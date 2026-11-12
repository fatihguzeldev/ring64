use super::tests::{context, image, run};
use super::*;
use crate::memory::{Cause, MappingInput, Permissions};
use crate::x86::context::{SegmentCause, SegmentFault};

fn mapping(base: u64, offset: u32, length: u32, write: bool) -> MappingInput {
    MappingInput {
        base,
        offset,
        length,
        backing: "ram".into(),
        permissions: Permissions {
            read: true,
            write,
            execute: true,
        },
    }
}

fn descriptor_failure(result: Result<FarOutcome, FarFailure>, vector: u8, selector: u16) {
    assert!(
        matches!(result, Err(FarFailure::Protection(ProtectionFault {
        vector: v, error_code, selector: Some(s), ..
    })) if v == vector && error_code == selector & 0xfffc && s == selector)
    );
}

#[test]
fn private_mode_gate_rejects_noninstructions_before_dynamic_access() {
    let long = context("long64", 0);
    let protected = context("protected", 0);
    for kind in [FarKind::Call, FarKind::Jump, FarKind::Return] {
        for width in [Width::W16, Width::W32, Width::W64] {
            for memory in [false, true] {
                let descriptor = FarDescriptor {
                    kind,
                    width,
                    memory,
                };
                assert_eq!(
                    valid_in_mode(descriptor, &long),
                    if kind == FarKind::Return {
                        !memory
                    } else {
                        memory
                    }
                );
                assert_eq!(
                    valid_in_mode(descriptor, &protected),
                    width != Width::W64 && (kind != FarKind::Return || !memory)
                );
            }
        }
        assert!(!valid_in_mode(
            FarDescriptor {
                kind,
                width: Width::W8,
                memory: true
            },
            &long
        ));
    }
}

#[test]
fn direct_code_literal_privileges_distinguish_conforming_rpl_and_presence() {
    // CPL, RPL, descriptor access byte, expected vector (zero means success).
    let cases = [
        (0, 3, 0x9d, 0),
        (0, 3, 0x99, 13),
        (1, 3, 0x9d, 0),
        (1, 0, 0xbd, 0),
        (1, 0, 0xdd, 13),
        (2, 3, 0xbd, 0),
        (2, 2, 0xd9, 0),
        (2, 3, 0xd9, 13),
        (3, 0, 0xf9, 0),
        (3, 3, 0x9d, 0),
        (0, 0, 0x19, 11),
        (0, 3, 0x19, 13),
        (2, 0, 0x5d, 11),
    ];
    for (cpl, rpl, access, vector) in cases {
        for kind in [FarKind::Call, FarKind::Jump] {
            let mut context = context("protected", cpl);
            let original = context.clone();
            let mut image = image();
            image
                .write(
                    0x1008,
                    8,
                    0x0040_0000_0000_ffff | u64::from(access as u8) << 40,
                )
                .unwrap();
            let selector = 8 | u16::from(rpl as u8);
            let result = run(
                &mut context,
                &mut image,
                kind,
                Width::W32,
                (0x2000, selector),
                0x4000,
            );
            if vector == 0 {
                assert_eq!(result.unwrap().pc, 0x2000);
                assert_eq!(context.selector(Segment::Cs), 8 | u16::from(cpl));
                assert_eq!(context.cpl(), cpl);
            } else {
                descriptor_failure(result, vector, selector);
                assert_eq!(context, original);
            }
        }
    }
}

#[test]
fn system_target_frontier_and_selected_gate_presence_skip_unselected_tails() {
    for mode in ["protected", "compatibility", "long64"] {
        for ty in 0u8..16 {
            let mut context = context(mode, 0);
            let mut image = image();
            // P0 and deliberately absent upper gate data must not be probed on the frontier.
            image.write(0x1008, 8, u64::from(ty) << 40).unwrap();
            image
                .set_mappings(vec![
                    mapping(0x1008, 0x1008, 8, false),
                    mapping(0x1100, 0x1100, 10, true),
                ])
                .unwrap();
            let original = context.clone();
            let result = run(
                &mut context,
                &mut image,
                FarKind::Jump,
                Width::W32,
                (0x2000, 8),
                0x4000,
            );
            let frontier = if mode == "protected" {
                [1, 3, 5, 9, 11].contains(&ty)
            } else {
                false
            };
            let gate = ty == 12 || mode == "protected" && ty == 4;
            if gate {
                descriptor_failure(result, 11, 8);
            } else if frontier {
                assert_eq!(result, Err(FarFailure::Unsupported));
            } else {
                descriptor_failure(result, 13, 8);
            }
            assert_eq!(context, original);
        }
    }
}

#[test]
fn return_invalid_ld_type_and_privilege_precede_presence() {
    for (raw, selector, old_cpl, vector) in [
        (0x00ef_1b00_0000_ffff, 8, 0, 13), // L1/D1/P0
        (0x00af_1b00_0000_ffff, 8, 0, 11), // valid code P0
        (0x00af_9300_0000_ffff, 8, 0, 13), // data
        (0x00af_1b00_0000_ffff, 8, 1, 13), // return RPL0 below current1
    ] {
        let mut context = context("long64", old_cpl);
        let original = context.clone();
        let mut image = image();
        image.write(0x1008, 8, raw).unwrap();
        image.write(0x4000, 8, 0x2000).unwrap();
        image.write(0x4008, 8, selector).unwrap();
        descriptor_failure(
            run(
                &mut context,
                &mut image,
                FarKind::Return,
                Width::W64,
                (0, 0),
                0x4000,
            ),
            vector,
            selector as u16,
        );
        assert_eq!(context, original);
    }
}

#[test]
fn real_and_v8086_return_selector_low_bits_never_select_an_outer_frame() {
    for (mode, cpl) in [("real", 0), ("virtual8086", 3)] {
        let mut context = context(mode, cpl);
        let original_cache = context.segment(Segment::Cs);
        let original_attributes = context.attributes(Segment::Cs);
        let mut image = image();
        image.write(0x4000, 2, 0x1000).unwrap();
        image.write(0x4002, 2, 3).unwrap();
        image
            .set_mappings(vec![mapping(0x4000, 0x4000, 4, false)])
            .unwrap();
        let outcome = run(
            &mut context,
            &mut image,
            FarKind::Return,
            Width::W16,
            (0, 0),
            0x4000,
        )
        .unwrap();
        assert_eq!((outcome.pc, outcome.sp), (0x1000, 0x4004));
        assert_eq!(context.cpl(), cpl);
        let mut expected_cache = original_cache;
        expected_cache.base = 0x30;
        assert_eq!(context.segment(Segment::Cs), expected_cache);
        assert_eq!(context.attributes(Segment::Cs), original_attributes);
        assert_eq!(context.selector(Segment::Cs), 3);
    }
}

#[test]
fn b16_wraps_slot_starts_without_wrapping_the_bytes_of_each_slot() {
    let mut context = context("protected", 0);
    let mut ss = context.segment(Segment::Ss);
    ss.default32 = false;
    ss.limit = u32::MAX;
    context.set_segment(Segment::Ss, 16, ss, context.attributes(Segment::Ss));
    let mut image = image();
    image.write(0x1008, 8, 0x00cf_9b00_0000_ffff).unwrap();
    let outcome = run(
        &mut context,
        &mut image,
        FarKind::Call,
        Width::W32,
        (0x2000, 8),
        0xdead_beef_0000_0006,
    )
    .unwrap();
    assert_eq!(outcome.sp, 0xdead_beef_0000_fffe);
    assert_eq!(image.read(2, 4).unwrap(), 8);
    assert_eq!(image.read(0xfffe, 4).unwrap(), 0x1234);
    let returned = run(
        &mut context,
        &mut image,
        FarKind::Return,
        Width::W32,
        (0, 0),
        outcome.sp,
    )
    .unwrap();
    assert_eq!((returned.pc, returned.sp), (0x1234, 0xdead_beef_0000_0006));
}

#[test]
fn outer_return_uses_popped_bank_then_target_b16_cleanup() {
    let mut context = context("long64", 0);
    let mut image = image();
    image.write(0x1018, 8, 0x00cf_fb00_0000_ffff).unwrap();
    image.write(0x1020, 8, 0x008f_f300_0000_ffff).unwrap();
    image.write(0x4000, 4, 0x2000).unwrap();
    image.write(0x4004, 4, 0x1b).unwrap();
    image.write(0x400b, 4, 0x89ab_fffe).unwrap();
    image.write(0x400f, 4, 0x23).unwrap();
    let outcome = run(
        &mut context,
        &mut image,
        FarKind::Return,
        Width::W32,
        (3, 0),
        0x4000,
    )
    .unwrap();
    assert_eq!(outcome.sp, 0x89ab_0001);
    assert_eq!(context.mode(), Mode::Compatibility);
    assert_eq!(context.stack_width(), Width::W16);
}

#[test]
fn permitted_null_ss_keeps_hidden_fields_but_marks_unusable_for_later_compatibility() {
    let mut context = context("long64", 0);
    let mut ss = context.segment(Segment::Ss);
    ss.base = 0x1_0000_0080;
    context.set_segment(Segment::Ss, 16, ss, context.attributes(Segment::Ss));
    let attributes = context.attributes(Segment::Ss);
    let mut image = image();
    image.write(0x1018, 8, 0x00af_bb00_0000_ffff).unwrap();
    image.write(0x1020, 8, 0x00cf_bb00_0000_ffff).unwrap();
    image.write(0x4000, 8, 0x2000).unwrap();
    image.write(0x4008, 8, 0x19).unwrap();
    image.write(0x4010, 8, 0x0000_8000_0000_0000).unwrap();
    image.write(0x4018, 8, 1).unwrap();
    let outcome = run(
        &mut context,
        &mut image,
        FarKind::Return,
        Width::W64,
        (0, 0),
        0x4000,
    )
    .unwrap();
    assert_eq!(outcome.sp, 0x0000_8000_0000_0000);
    assert_eq!(context.cpl(), 1);
    ss.usable = false;
    assert_eq!(context.selector(Segment::Ss), 1);
    assert_eq!(context.segment(Segment::Ss), ss);
    assert_eq!(context.attributes(Segment::Ss), attributes);
    run(
        &mut context,
        &mut image,
        FarKind::Jump,
        Width::W32,
        (0x2000, 0x21),
        outcome.sp,
    )
    .unwrap();
    assert_eq!(context.mode(), Mode::Compatibility);
    assert!(matches!(
        context.translate(0x1000, 4, Segment::Ss, Access::Write, false),
        Err(AccessFailure::Segment(SegmentFault {
            cause: SegmentCause::Unusable,
            ..
        }))
    ));
}

#[test]
fn outer_missing_ss_and_bad_null_ss_leave_every_context_field_unchanged() {
    for (ss_selector, raw_ss, vector) in [(0x23, 0x00cf_7300_0000_ffff, 12), (0, 0, 13)] {
        let mut context = context("long64", 0);
        let original = context.clone();
        let mut image = image();
        image.write(0x1018, 8, 0x00af_fb00_0000_ffff).unwrap();
        image.write(0x1020, 8, raw_ss).unwrap();
        image.write(0x4000, 8, 0x2000).unwrap();
        image.write(0x4008, 8, 0x1b).unwrap();
        image.write(0x4010, 8, 0x5000).unwrap();
        image.write(0x4018, 8, ss_selector).unwrap();
        descriptor_failure(
            run(
                &mut context,
                &mut image,
                FarKind::Return,
                Width::W64,
                (0, 0),
                0x4000,
            ),
            vector,
            ss_selector as u16,
        );
        assert_eq!(context, original);
    }
}

#[test]
fn restored_pointer_read_fault_wins_before_later_ss_slot_geometry() {
    let mut context = context("protected", 0);
    let mut ss = context.segment(Segment::Ss);
    ss.limit = 0x401b;
    ss.default32 = true;
    context.set_segment(Segment::Ss, 16, ss, context.attributes(Segment::Ss));
    let original = context.clone();
    let mut image = image();
    image.write(0x1018, 8, 0x0040_fa00_0000_ffff).unwrap();
    image.write(0x4000, 4, 0x2000).unwrap();
    image.write(0x4004, 4, 0x1b).unwrap();
    image
        .set_mappings(vec![mapping(0, 0, 0x4008, true)])
        .unwrap();
    let result = run(
        &mut context,
        &mut image,
        FarKind::Return,
        Width::W32,
        (0x10, 0),
        0x4000,
    );
    assert!(matches!(
        result,
        Err(FarFailure::Operand {
            segment: Segment::Ss,
            failure: AccessFailure::Linear(crate::memory::Fault {
                address: 0x4018,
                width: 4,
                cause: Cause::Unmapped,
                ..
            })
        })
    ));
    assert_eq!(context, original);
    assert_eq!(image.read(0x1018, 8).unwrap(), 0x0040_fa00_0000_ffff);
}

#[test]
fn skipped_span_geometry_does_not_wrap_at_b16_or_probe_its_backing() {
    for limit in [0xffff, u32::MAX] {
        let mut context = context("protected", 0);
        let mut ss = context.segment(Segment::Ss);
        ss.default32 = false;
        ss.limit = limit;
        context.set_segment(Segment::Ss, 16, ss, context.attributes(Segment::Ss));
        let mut image = image();
        image.write(0x1018, 8, 0x0040_fb00_0000_ffff).unwrap();
        image.write(0x1020, 8, 0x0040_f300_0000_ffff).unwrap();
        image.write(0xfff0, 4, 0x2000).unwrap();
        image.write(0xfff4, 4, 0x1b).unwrap();
        image.write(8, 4, 0x5000).unwrap();
        image.write(12, 4, 0x23).unwrap();
        image
            .set_mappings(vec![
                mapping(0, 0, 0x2000, true),
                mapping(0xfff0, 0xfff0, 8, true),
            ])
            .unwrap();
        let result = run(
            &mut context,
            &mut image,
            FarKind::Return,
            Width::W32,
            (0x10, 0),
            0xfff0,
        );
        if limit == 0xffff {
            assert!(matches!(
                result,
                Err(FarFailure::Operand {
                    segment: Segment::Ss,
                    failure: AccessFailure::Segment(SegmentFault {
                        offset: 0xfff8,
                        width: 0x10,
                        cause: SegmentCause::Limit,
                        failing: 0x10000,
                        ..
                    })
                })
            ));
        } else {
            assert_eq!(result.unwrap().sp, 0x5010);
        }
    }
}

#[test]
fn late_frame_permission_fault_publishes_neither_descriptor_a_nor_first_slot() {
    let mut context = context("long64", 0);
    let original = context.clone();
    let mut image = image();
    image.write(0x1008, 8, 0x00af_9a00_0000_ffff).unwrap();
    image.write(0x4000, 8, 0x5566_7788_1122_3344).unwrap();
    image
        .set_mappings(vec![
            mapping(0, 0, 0x4000, true),
            mapping(0x4000, 0x4000, 4, false),
            mapping(0x4004, 0x4004, 0xcffc, true),
        ])
        .unwrap();
    let result = run(
        &mut context,
        &mut image,
        FarKind::Call,
        Width::W32,
        (0x2000, 8),
        0x4008,
    );
    assert!(matches!(
        result,
        Err(FarFailure::Operand {
            segment: Segment::Ss,
            failure: AccessFailure::Linear(crate::memory::Fault {
                address: 0x4000,
                width: 4,
                cause: Cause::Permission,
                ..
            })
        })
    ));
    assert_eq!(context, original);
    assert_eq!(image.read(0x1008, 8).unwrap(), 0x00af_9a00_0000_ffff);
    assert_eq!(image.read(0x4000, 8).unwrap(), 0x5566_7788_1122_3344);
}

#[test]
fn late_stack_a_admission_failure_keeps_earlier_code_a_zero() {
    let mut context = context("long64", 0);
    let original = context.clone();
    let mut image = image();
    image.write(0x1018, 8, 0x00af_fa00_0000_ffff).unwrap();
    image.write(0x1020, 8, 0x00cf_f200_0000_ffff).unwrap();
    image.write(0x4000, 8, 0x2000).unwrap();
    image.write(0x4008, 8, 0x1b).unwrap();
    image.write(0x4010, 8, 0x5000).unwrap();
    image.write(0x4018, 8, 0x23).unwrap();
    image
        .set_mappings(vec![
            mapping(0, 0, 0x1025, true),
            mapping(0x1025, 0x1025, 1, false),
            mapping(0x1026, 0x1026, 0xffda, true),
        ])
        .unwrap();
    let result = run(
        &mut context,
        &mut image,
        FarKind::Return,
        Width::W64,
        (0, 0),
        0x4000,
    );
    assert!(matches!(
        result,
        Err(FarFailure::SystemMemory(super::super::SystemMemoryFault {
            address: 0x1025,
            width: 1,
            reference: super::super::SystemReference::Selector(0x23),
            phase: super::super::SystemPhase::AccessedWrite,
            ..
        }))
    ));
    assert_eq!(context, original);
    assert_eq!(image.read(0x1018, 8).unwrap(), 0x00af_fa00_0000_ffff);
    assert_eq!(image.read(0x1020, 8).unwrap(), 0x00cf_f200_0000_ffff);
}

#[test]
fn frame_aliases_overwrite_just_set_a_and_cs_slot_before_offset_slot() {
    let mut context = context("long64", 0);
    let mut image = image();
    image.write(0x1008, 8, 0x00af_9a00_0000_ffff).unwrap();
    image
        .set_mappings(vec![
            mapping(0, 0, 0x4000, true),
            mapping(0x4000, 0x100d, 2, true),
            mapping(0x4002, 0x100d, 2, true),
        ])
        .unwrap();
    let outcome = run(
        &mut context,
        &mut image,
        FarKind::Call,
        Width::W16,
        (0x2000, 8),
        0x4004,
    )
    .unwrap();
    assert_eq!(outcome.sp, 0x4000);
    assert_eq!(image.read(0x100d, 2).unwrap(), 0x1234);
    assert_eq!(image.read(0x4000, 2).unwrap(), 0x1234);
    assert_eq!(image.read(0x4002, 2).unwrap(), 0x1234);
    assert!(context.attributes(Segment::Cs).accessed);
    assert!(context.attributes(Segment::Cs).present);
    assert_eq!(context.mode(), Mode::Long64);
}

#[test]
fn a_zero_requires_only_its_one_byte_write_permission() {
    let mut context = context("protected", 0);
    let mut image = image();
    image.write(0x1008, 8, 0x0040_9a00_0000_ffff).unwrap();
    image
        .set_mappings(vec![
            mapping(0, 0, 0x100d, false),
            mapping(0x100d, 0x100d, 1, true),
            mapping(0x100e, 0x100e, 0xfff2, false),
        ])
        .unwrap();
    run(
        &mut context,
        &mut image,
        FarKind::Jump,
        Width::W32,
        (0x2000, 8),
        0x4000,
    )
    .unwrap();
    assert_eq!(image.read(0x1008, 8).unwrap(), 0x0040_9b00_0000_ffff);
}
