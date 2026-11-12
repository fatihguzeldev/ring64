use super::gate_tests::{call, fixture};
use super::*;

pub(super) fn gate(image: &mut Image, width: Width, count: u8, selector: u16) {
    let mut bytes = [0x00, 0x20, 0, 0, count | 0xe0, 0xe4, 0xcd, 0xab];
    bytes[2..4].copy_from_slice(&selector.to_le_bytes());
    if width == Width::W32 {
        bytes[5] = 0xec;
        bytes[6..].fill(0);
    }
    image.write_bytes(0x1038, &bytes).unwrap();
}

pub(super) fn expected_fault(
    result: Result<FarOutcome, FarFailure>,
    vector: u8,
    selector: u16,
    phase: ProtectionPhase,
) {
    assert_eq!(
        result,
        Err(FarFailure::Protection(ProtectionFault {
            vector,
            error_code: selector & !3,
            selector: Some(selector),
            phase,
        }))
    );
}

#[test]
fn every_legacy_count_gate_width_stack_width_and_tss_format_round_trips() {
    let mut cases = 0;
    for width in [Width::W16, Width::W32] {
        for count in 0..32u8 {
            for old32 in [false, true] {
                for new32 in [false, true] {
                    for tss32 in [false, true] {
                        let (mut context, mut image) = fixture("protected");
                        let mut old_ss = context.segment(Segment::Ss);
                        old_ss.default32 = old32;
                        old_ss.limit = u32::MAX;
                        context.set_segment(
                            Segment::Ss,
                            0x23,
                            old_ss,
                            context.attributes(Segment::Ss),
                        );
                        image
                            .write(
                                0x1020,
                                8,
                                if old32 {
                                    0x00cf_f300_0000_ffff
                                } else {
                                    0x008f_f300_0000_ffff
                                },
                            )
                            .unwrap();
                        image
                            .write(
                                0x1010,
                                8,
                                if new32 {
                                    0x00cf_9300_0000_ffff
                                } else {
                                    0x008f_9300_0000_ffff
                                },
                            )
                            .unwrap();
                        let mut tr = context.tr();
                        tr.attributes = if tss32 { 0x8b } else { 0x83 };
                        context.set_tr(tr);
                        let new_raw = if tss32 && !new32 {
                            0x1234_9000u64
                        } else {
                            0x9000
                        };
                        if tss32 {
                            image.write(0x2008, 2, 0x10).unwrap();
                            image.write(0x2004, 4, new_raw).unwrap();
                        } else {
                            image.write(0x2004, 2, 0x10).unwrap();
                            image.write(0x2002, 2, new_raw).unwrap();
                        }
                        gate(&mut image, width, count, 0x0b); // Embedded RPL3 is ignored.
                        let bytes = u64::from(width.bytes());
                        for index in 0..count {
                            image
                                .write(
                                    0x4000 + u64::from(index) * bytes,
                                    bytes as u32,
                                    0x100 + u64::from(index),
                                )
                                .unwrap();
                        }
                        let old_raw =
                            0x1234_5678_0000_0000 | if old32 { 0x4000 } else { 0xabcd_4000 };
                        let outcome = call(
                            &mut context,
                            &mut image,
                            if width == Width::W16 {
                                Width::W32
                            } else {
                                Width::W16
                            },
                            old_raw,
                        )
                        .unwrap();
                        let new_mask = if new32 { u64::from(u32::MAX) } else { 0xffff };
                        let expected_sp = (new_raw & !new_mask)
                            | (new_raw.wrapping_sub((u64::from(count) + 4) * bytes) & new_mask);
                        assert_eq!(
                            (outcome.pc, outcome.sp, context.cpl()),
                            (0x2000, expected_sp, 0)
                        );
                        let frame = outcome.sp & new_mask;
                        let mut values = vec![0x1007, 0x1b];
                        values.extend((0..count).map(|index| 0x100 + u64::from(index)));
                        values.extend([old_raw & width.mask(), 0x23]);
                        assert_eq!(values.len(), usize::from(count) + 4);
                        for (index, value) in values.into_iter().enumerate() {
                            assert_eq!(
                                image
                                    .read(frame + index as u64 * bytes, bytes as u32)
                                    .unwrap(),
                                value
                            );
                        }
                        let cleanup = u64::from(count) * bytes;
                        let returned = tests::run(
                            &mut context,
                            &mut image,
                            FarKind::Return,
                            width,
                            (cleanup, 0),
                            outcome.sp,
                        )
                        .unwrap();
                        let old_mask = if old32 { u64::from(u32::MAX) } else { 0xffff };
                        let saved_raw = old_raw & width.mask();
                        let expected_return =
                            (saved_raw & !old_mask) | (saved_raw.wrapping_add(cleanup) & old_mask);
                        assert_eq!(
                            (
                                returned.pc,
                                returned.sp,
                                context.cpl(),
                                context.selector(Segment::Ss)
                            ),
                            (0x1007, expected_return, 3, 0x23)
                        );
                        assert_eq!(
                            image.read(0x103d, 1).unwrap(),
                            if width == Width::W16 { 0xe4 } else { 0xec }
                        );
                        cases += 1;
                    }
                }
            }
        }
    }
    assert_eq!(cases, 512);
}

#[test]
fn gate_privilege_and_target_conformance_matrix_has_exact_selector_faults() {
    let mut cases = 0;
    for old_cpl in 0..4u8 {
        for gate_rpl in 0..4u8 {
            for gate_dpl in 0..4u8 {
                for target_dpl in 0..4u8 {
                    for conforming in [false, true] {
                        for kind in [FarKind::Call, FarKind::Jump] {
                            let (mut context, mut image) = fixture("protected");
                            context.set_mode_and_cpl(Mode::Protected, old_cpl);
                            for (segment, index) in [(Segment::Cs, 0x18), (Segment::Ss, 0x20)] {
                                let mut attributes = context.attributes(segment);
                                attributes.dpl = old_cpl;
                                context.set_segment(
                                    segment,
                                    index | u16::from(old_cpl),
                                    context.segment(segment),
                                    attributes,
                                );
                            }
                            gate(&mut image, Width::W32, 0, 0x0b);
                            image
                                .write(0x103d, 1, u64::from(0x8c | gate_dpl << 5))
                                .unwrap();
                            let access = 0x9b | target_dpl << 5 | if conforming { 4 } else { 0 };
                            image.write(0x100d, 1, u64::from(access)).unwrap();
                            image
                                .write(0x1015, 1, u64::from(0x93 | target_dpl << 5))
                                .unwrap();
                            image
                                .write(
                                    0x2008 + u64::from(target_dpl) * 8,
                                    2,
                                    0x10 | u64::from(target_dpl),
                                )
                                .unwrap();
                            image
                                .write(0x2004 + u64::from(target_dpl) * 8, 4, 0x9000)
                                .unwrap();
                            let original = context.clone();
                            let selector = 0x38 | u16::from(gate_rpl);
                            let result = execute(
                                &mut context,
                                &mut image,
                                FarDescriptor {
                                    kind,
                                    width: Width::W16,
                                    memory: false,
                                },
                                FarOperands {
                                    offset: 0xffff,
                                    selector,
                                    input_sp: 0x4000,
                                    next_pc: 0x1007,
                                    segment: Segment::Ds,
                                },
                            );
                            if old_cpl > gate_dpl || gate_rpl > gate_dpl {
                                expected_fault(result, 13, selector, ProtectionPhase::Descriptor);
                                assert_eq!(context, original);
                            } else if target_dpl > old_cpl
                                || kind == FarKind::Jump && !conforming && target_dpl != old_cpl
                            {
                                expected_fault(result, 13, 0x0b, ProtectionPhase::Descriptor);
                                assert_eq!(context, original);
                            } else {
                                let outcome = result.unwrap();
                                let cpl = if conforming { old_cpl } else { target_dpl };
                                let inner = kind == FarKind::Call && cpl < old_cpl;
                                let sp = if kind == FarKind::Jump {
                                    0x4000
                                } else if inner {
                                    0x8ff0
                                } else {
                                    0x3ff8
                                };
                                assert_eq!(
                                    (
                                        outcome.pc,
                                        outcome.sp,
                                        context.cpl(),
                                        context.selector(Segment::Cs)
                                    ),
                                    (0x2000, sp, cpl, 8 | u16::from(cpl))
                                );
                            }
                            cases += 1;
                        }
                    }
                }
            }
        }
    }
    assert_eq!(cases, 1024);
}

#[test]
fn inner_aliases_capture_parameters_before_saved_pointer_publication() {
    for count in [1, 2] {
        let (mut context, mut image) = fixture("protected");
        gate(&mut image, Width::W32, count, 8);
        image.write(0x2008, 2, 0x10).unwrap();
        image
            .write(0x2004, 4, 0x8004 + u64::from(count) * 4)
            .unwrap();
        image.write(0x8000, 4, 0x1122_3344).unwrap();
        image.write(0x8004, 4, 0x5566_7788).unwrap();
        let outcome = call(&mut context, &mut image, Width::W16, 0x8000).unwrap();
        assert_eq!(
            (outcome.sp, image.read(0x7ffc, 4).unwrap()),
            (0x7ff4, 0x1122_3344)
        );
        if count == 2 {
            assert_eq!(image.read(0x8000, 4).unwrap(), 0x5566_7788);
        }
        assert_eq!(image.read(0x7ff8, 4).unwrap(), 0x1b);
        assert_eq!(image.read(0x7ff4, 4).unwrap(), 0x1007);
    }
}

#[test]
fn old_b16_parameters_wrap_between_complete_slots_and_save_raw_esp() {
    let (mut context, mut image) = fixture("protected");
    let mut ss = context.segment(Segment::Ss);
    ss.default32 = false;
    ss.limit = 0x1ffff;
    context.set_segment(Segment::Ss, 0x23, ss, context.attributes(Segment::Ss));
    gate(&mut image, Width::W32, 2, 8);
    image.write(0x2008, 2, 0x10).unwrap();
    image.write(0x2004, 4, 0x9000).unwrap();
    image.write(0xfffe, 4, 0x1122_3344).unwrap();
    image.write(2, 4, 0x5566_7788).unwrap();
    let outcome = call(&mut context, &mut image, Width::W16, 0x1234_5678_abcd_fffe).unwrap();
    assert_eq!(outcome.sp, 0x8fe8);
    for (index, value) in [0x1007, 0x1b, 0x1122_3344, 0x5566_7788, 0xabcd_fffe, 0x23]
        .into_iter()
        .enumerate()
    {
        assert_eq!(image.read(0x8fe8 + index as u64 * 4, 4).unwrap(), value);
    }
}
