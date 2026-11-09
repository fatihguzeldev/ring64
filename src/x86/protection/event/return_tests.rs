use super::*;
use crate::x86::context::{LoadedSegment, SegmentAttributes, SegmentType};
use crate::x86::instruction::{SoftwareEventKind as Kind, Width};
use crate::x86::protection::{
    TableRegister,
    tests::{context, image, mapping},
};

fn descriptor(width: Width) -> SoftwareEventDescriptor {
    SoftwareEventDescriptor {
        kind: Kind::Return,
        width,
        vector: 0,
    }
}
fn put_slots(bytes: &mut [u8], at: usize, values: &[u64], width: Width) {
    let size = usize::from(width.bytes());
    for (i, value) in values.iter().enumerate() {
        bytes[at + i * size..at + (i + 1) * size].copy_from_slice(&value.to_le_bytes()[..size]);
    }
}

#[test]
fn real_iret_word_restores_low_flags_and_same_stack_raw_upper_bits_without_gdt() {
    let mut context = context("real", 0);
    let mut cs = context.segment(Segment::Cs);
    cs.limit = 0xffff;
    cs.base = 0x200;
    context.set_segment(Segment::Cs, 0x20, cs, context.attributes(Segment::Cs));
    let mut ss = context.segment(Segment::Ss);
    ss.base = 0x2000;
    ss.default32 = false;
    context.set_segment(Segment::Ss, 16, ss, context.attributes(Segment::Ss));
    let mut data = vec![0xa5; 256];
    data[0xfa..].copy_from_slice(&[0x34, 0x12, 8, 0, 3, 3]);
    let mut image = image(data, vec![mapping(0x2000, 0, 256, true, false)]);
    let out = execute(
        &mut context,
        &mut image,
        descriptor(Width::W16),
        EventInputs {
            flags: 3,
            sp: 0xdead_beef_0000_00fa,
            next_pc: 0,
        },
    )
    .unwrap();
    assert_eq!(
        (out.pc, out.sp, out.flags),
        (0x1234, 0xdead_beef_0000_0100, 0x303)
    );
    assert_eq!(context.selector(Segment::Cs), 8);
    assert_eq!(context.segment(Segment::Cs).base, 0x80);
}

#[test]
fn long_source_iret_always_reads_five_operand_sized_slots_and_does_not_probe_restored_sp() {
    for (width, sp, flags) in [
        (Width::W16, 0x1234, 0x103),
        (Width::W32, 0xfeed_1234, 0x10103),
        (Width::W64, 0x8000_0000_0001, 0x10103),
    ] {
        let mut context = context("long64", 0);
        context.set_gdtr(TableRegister {
            base: 0x1000,
            limit: 15,
        });
        let old_ss = context.segment(Segment::Ss);
        let mut data = vec![0xa5; 128];
        data[8..16].copy_from_slice(&0x00af_9a00_0000_ffffu64.to_le_bytes());
        put_slots(&mut data, 64, &[0x1200, 8, flags, sp, 0], width);
        let mut image = image(
            data,
            vec![
                mapping(0x1000, 0, 64, true, true),
                mapping(0x4000, 64, 5 * u32::from(width.bytes()), true, false),
            ],
        );
        let out = execute(
            &mut context,
            &mut image,
            descriptor(width),
            EventInputs {
                flags: 2,
                sp: 0x4000,
                next_pc: 0,
            },
        )
        .unwrap();
        assert_eq!((out.pc, out.sp, out.flags), (0x1200, sp, flags));
        assert_eq!(context.mode(), Mode::Long64);
        assert_eq!(context.selector(Segment::Ss), 0);
        let mut expected = old_ss;
        expected.usable = false;
        assert_eq!(context.segment(Segment::Ss), expected);
        assert_eq!(image.read_vector(0x1008, 8).unwrap()[5], 0x9b);
    }
}

#[test]
fn compatibility_source_to_long_same_cpl_reads_three_slots_and_preserves_unrelated_high_sp() {
    let mut context = context("compatibility", 0);
    context.set_gdtr(TableRegister {
        base: 0x1000,
        limit: 15,
    });
    let mut ss = context.segment(Segment::Ss);
    ss.default32 = true;
    context.set_segment(Segment::Ss, 16, ss, context.attributes(Segment::Ss));
    let old_ss = context.segment(Segment::Ss);
    let mut data = vec![0xa5; 128];
    data[8..16].copy_from_slice(&0x00af_9a00_0000_ffffu64.to_le_bytes());
    put_slots(&mut data, 64, &[0x1200, 0xffff_0008, 2], Width::W32);
    let mut image = image(
        data,
        vec![
            mapping(0x1000, 0, 64, true, true),
            mapping(0x4000, 64, 12, true, false),
        ],
    );
    let out = execute(
        &mut context,
        &mut image,
        descriptor(Width::W32),
        EventInputs {
            flags: 2,
            sp: 0xdead_beef_0000_4000,
            next_pc: 0,
        },
    )
    .unwrap();
    assert_eq!(
        (out.pc, out.sp, out.flags),
        (0x1200, 0xdead_beef_0000_400c, 2)
    );
    assert_eq!(context.mode(), Mode::Long64);
    assert_eq!(context.segment(Segment::Ss), old_ss);
}

#[test]
fn protected_iretd_vm_return_consumes_nine_slots_and_rebuilds_six_fixed_real_caches() {
    let mut context = context("protected", 0);
    let mut ss = context.segment(Segment::Ss);
    ss.default32 = true;
    context.set_segment(Segment::Ss, 16, ss, context.attributes(Segment::Ss));
    let mut data = vec![0xa5; 64];
    put_slots(
        &mut data,
        0,
        &[
            0x1234,
            0x20,
            0x3f7fd7,
            0x1234_abcd,
            0x30,
            0x40,
            0x50,
            0x60,
            0x70,
        ],
        Width::W32,
    );
    let mut image = image(data, vec![mapping(0x4000, 0, 36, true, false)]);
    let out = execute(
        &mut context,
        &mut image,
        descriptor(Width::W32),
        EventInputs {
            flags: 2,
            sp: 0x4000,
            next_pc: 0,
        },
    )
    .unwrap();
    assert_eq!((out.pc, out.sp, out.flags), (0x1234, 0x1234_abcd, 0x3d7fd7));
    assert_eq!((context.mode(), context.cpl()), (Mode::Virtual8086, 3));
    for (segment, selector) in [
        (Segment::Cs, 0x20),
        (Segment::Ss, 0x30),
        (Segment::Es, 0x40),
        (Segment::Ds, 0x50),
        (Segment::Fs, 0x60),
        (Segment::Gs, 0x70),
    ] {
        assert_eq!(context.selector(segment), selector);
        assert_eq!(
            context.segment(segment),
            LoadedSegment {
                base: u64::from(selector) << 4,
                limit: 0xffff,
                default32: false,
                usable: true,
                kind: SegmentType::ReadWrite
            }
        );
        assert_eq!(
            context.attributes(segment),
            SegmentAttributes {
                dpl: 3,
                present: true,
                accessed: true,
                ..SegmentAttributes::default()
            }
        );
    }
}

#[test]
fn iret_nt_and_v86_iopl_admission_precede_frame_reads() {
    for (mode, cpl, flags, expected) in [
        ("protected", 0, 0x4002, EventFailure::Unsupported),
        (
            "compatibility",
            0,
            0x4002,
            fault(13, 0, ProtectionPhase::Privilege, None),
        ),
        (
            "long64",
            0,
            0x4002,
            fault(13, 0, ProtectionPhase::Privilege, None),
        ),
        (
            "virtual8086",
            3,
            2,
            fault(13, 0, ProtectionPhase::Privilege, None),
        ),
    ] {
        let mut context = context(mode, cpl);
        let before = context.clone();
        let mut image = image(vec![0; 8], vec![mapping(0x1000, 0, 8, true, false)]);
        assert_eq!(
            execute(
                &mut context,
                &mut image,
                descriptor(Width::W32),
                EventInputs {
                    flags,
                    sp: 0x4000,
                    next_pc: 0
                }
            ),
            Err(expected)
        );
        assert_eq!(context, before);
    }
}

#[test]
fn return_cs_rpl_and_vm_ip_bound_precede_unselected_descriptor_or_extra_reads() {
    for (mode, cpl, values, width, expected) in [
        (
            "long64",
            3,
            [0x1200, 8, 2],
            Width::W64,
            selector_fault(8, 13, 0, ProtectionPhase::Selector),
        ),
        (
            "protected",
            0,
            [0x1_0000, 0x20, 0x20002],
            Width::W32,
            fault(13, 0, ProtectionPhase::Target, None),
        ),
    ] {
        let mut context = context(mode, cpl);
        context.set_gdtr(TableRegister {
            base: 0x9000,
            limit: 0xffff,
        });
        let mut ss = context.segment(Segment::Ss);
        ss.default32 = true;
        context.set_segment(Segment::Ss, 16, ss, context.attributes(Segment::Ss));
        let before = context.clone();
        let mut data = vec![0; 24];
        put_slots(&mut data, 0, &values, width);
        let mut image = image(
            data,
            vec![mapping(
                0x4000,
                0,
                3 * u32::from(width.bytes()),
                true,
                false,
            )],
        );
        assert_eq!(
            execute(
                &mut context,
                &mut image,
                descriptor(width),
                EventInputs {
                    flags: 2,
                    sp: 0x4000,
                    next_pc: 0
                }
            ),
            Err(expected)
        );
        assert_eq!(context, before);
    }
}

#[test]
fn outer_return_ss_absence_is_ss_zero_and_success_clears_raw_null_data_cache_without_erasing_base()
{
    for present in [false, true] {
        let mut context = context("long64", 0);
        context.set_gdtr(TableRegister {
            base: 0x1000,
            limit: 39,
        });
        let mut fs = context.segment(Segment::Fs);
        fs.base = 0x1_2345_6000;
        fs.usable = true;
        let mut attributes = context.attributes(Segment::Fs);
        attributes.dpl = 3;
        context.set_segment(Segment::Fs, 0, fs, attributes);
        let before = context.clone();
        let mut data = vec![0xa5; 128];
        data[24..32].copy_from_slice(&0x00af_fa00_0000_ffffu64.to_le_bytes());
        let stack = if present {
            0x00cf_f200_0000_ffffu64
        } else {
            0x00cf_7200_0000_ffff
        };
        data[32..40].copy_from_slice(&stack.to_le_bytes());
        put_slots(
            &mut data,
            64,
            &[0x1200, 0x1b, 2, 0x8000_0000_0001, 0x23],
            Width::W64,
        );
        let mut image = image(
            data,
            vec![
                mapping(0x1000, 0, 64, true, true),
                mapping(0x4000, 64, 40, true, false),
            ],
        );
        let result = execute(
            &mut context,
            &mut image,
            descriptor(Width::W64),
            EventInputs {
                flags: 2,
                sp: 0x4000,
                next_pc: 0,
            },
        );
        if present {
            let out = result.unwrap();
            assert_eq!((out.pc, out.sp, out.flags), (0x1200, 0x8000_0000_0001, 2));
            assert_eq!(context.cpl(), 3);
            assert_eq!(context.selector(Segment::Fs), 0);
            let mut expected = fs;
            expected.usable = false;
            assert_eq!(context.segment(Segment::Fs), expected);
            assert_eq!(context.attributes(Segment::Fs), attributes);
            assert_eq!(image.read_vector(0x1018, 8).unwrap()[5], 0xfb);
            assert_eq!(image.read_vector(0x1020, 8).unwrap()[5], 0xf3);
        } else {
            assert_eq!(
                result,
                Err(EventFailure::Protection(ProtectionFault {
                    vector: 12,
                    error_code: 0,
                    phase: ProtectionPhase::Descriptor,
                    selector: Some(0x23)
                }))
            );
            assert_eq!(context, before);
            assert_eq!(image.read_vector(0x1018, 8).unwrap()[5], 0xfa);
        }
    }
}
