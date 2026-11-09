use super::*;
use crate::x86::context::TaskRegister;
use crate::x86::context::{Mode, Segment};
use crate::x86::instruction::{SoftwareEventKind as Kind, Width};
use crate::x86::protection::TableRegister;
use crate::x86::protection::tests::{context, image, mapping};

fn event(kind: Kind, width: Width, vector: u8) -> SoftwareEventDescriptor {
    SoftwareEventDescriptor {
        kind,
        width,
        vector,
    }
}

fn captured(image: &Image, address: u64, width: u32) -> Vec<u8> {
    let mut output = vec![0; width as usize];
    image
        .read_fields(address, width, &[(0, width)], &mut output)
        .unwrap();
    output
}

#[test]
fn real_int_uses_fixed_words_and_preserves_raw_old_pointer_without_a_gdt() {
    let mut context = context("real", 0);
    let mut cs = context.segment(Segment::Cs);
    cs.base = 0x80;
    cs.limit = 0xffff;
    context.set_segment(Segment::Cs, 8, cs, context.attributes(Segment::Cs));
    let mut ss = context.segment(Segment::Ss);
    ss.base = 0x2000;
    ss.default32 = false;
    context.set_segment(Segment::Ss, 16, ss, context.attributes(Segment::Ss));
    context.set_idtr(TableRegister {
        base: 0x1000,
        limit: 15,
    });
    let mut bytes = vec![0xa5; 512];
    bytes[12..16].copy_from_slice(&[0x04, 0x02, 0x20, 0]);
    let mut image = image(
        bytes,
        vec![
            mapping(0x1000, 0, 256, true, true),
            mapping(0x2000, 256, 256, true, true),
        ],
    );
    let entered = execute(
        &mut context,
        &mut image,
        event(Kind::Int3, Width::W16, 3),
        EventInputs {
            flags: 0x40303,
            sp: 0xdead_beef_0000_0100,
            next_pc: 0x1234,
        },
    )
    .unwrap();
    assert_eq!(entered.pc, 0x204);
    assert_eq!(entered.sp, 0xdead_beef_0000_00fa);
    assert_eq!(entered.flags, 3);
    assert_eq!(captured(&image, 0x20fa, 6), [0x34, 0x12, 8, 0, 3, 3]);
    assert_eq!(context.selector(Segment::Cs), 0x20);
    assert_eq!(context.segment(Segment::Cs).base, 0x200);
}

#[test]
fn protected_trap_gate_saves_three_dwords_and_preserves_if() {
    let mut context = context("protected", 0);
    context.set_gdtr(TableRegister {
        base: 0x1000,
        limit: 15,
    });
    context.set_idtr(TableRegister {
        base: 0x2000,
        limit: 31,
    });
    let mut ss = context.segment(Segment::Ss);
    ss.base = 0x3000;
    ss.default32 = true;
    context.set_segment(Segment::Ss, 16, ss, context.attributes(Segment::Ss));
    let mut bytes = vec![0xa5; 768];
    bytes[8..16].copy_from_slice(&0x00cf_9a00_0000_ffffu64.to_le_bytes());
    bytes[280..288].copy_from_slice(&0x0000_8f00_0008_3456u64.to_le_bytes());
    let mut image = image(
        bytes,
        vec![
            mapping(0x1000, 0, 256, true, true),
            mapping(0x2000, 256, 256, true, true),
            mapping(0x3000, 512, 256, true, true),
        ],
    );
    let entered = execute(
        &mut context,
        &mut image,
        event(Kind::Interrupt, Width::W16, 3),
        EventInputs {
            flags: 0x3c7fd7,
            sp: 0x100,
            next_pc: 0x2200,
        },
    )
    .unwrap();
    assert_eq!(entered.pc, 0x3456);
    assert_eq!(entered.sp, 0xf4);
    assert_eq!(entered.flags, 0x3c3ed7);
    assert_eq!(
        captured(&image, 0x30f4, 12),
        [0, 0x22, 0, 0, 8, 0, 0, 0, 0xd7, 0x7f, 0x3c, 0]
    );
    assert_eq!(context.mode(), Mode::Protected);
    assert!(context.segment(Segment::Cs).default32);
    assert_eq!(image.read_vector(0x1008, 8).unwrap()[5], 0x9b);
}

#[test]
fn inner_entry_uses_cached_tss_width_new_stack_width_and_old_full_frame_values() {
    for (attributes, sp_bytes, ss_at, expected_sp) in [
        (0x83u16, &[0x30, 0][..], 4, 0x1c),
        (0x8b, &[0x30, 0, 1, 0][..], 8, 0x1001c),
    ] {
        let mut context = context("protected", 3);
        for (segment, selector) in [(Segment::Cs, 0x1b), (Segment::Ss, 0x23)] {
            let mut attributes = context.attributes(segment);
            attributes.dpl = 3;
            context.set_segment(segment, selector, context.segment(segment), attributes);
        }
        context.set_gdtr(TableRegister {
            base: 0x1000,
            limit: 23,
        });
        context.set_idtr(TableRegister {
            base: 0x2000,
            limit: 31,
        });
        context.set_tr(TaskRegister {
            selector: 0x28,
            valid: true,
            base: 0x3000,
            limit: 0x67,
            attributes,
        });
        let mut data = vec![0xa5; 1024];
        data[8..16].copy_from_slice(&0x00cf_9a00_0000_ffffu64.to_le_bytes());
        data[16..24].copy_from_slice(&0x0000_9200_4000_ffffu64.to_le_bytes());
        data[280..288].copy_from_slice(&0x0000_ee00_0008_3456u64.to_le_bytes());
        let sp_at = if attributes == 0x83 { 2 } else { 4 };
        data[512 + sp_at..512 + sp_at + sp_bytes.len()].copy_from_slice(sp_bytes);
        data[512 + ss_at..514 + ss_at].copy_from_slice(&[16, 0]);
        let mut image = image(
            data,
            vec![
                mapping(0x1000, 0, 256, true, true),
                mapping(0x2000, 256, 256, true, true),
                mapping(0x3000, 512, 256, true, false),
                mapping(0x4000, 768, 256, true, true),
            ],
        );
        let out = execute(
            &mut context,
            &mut image,
            event(Kind::Interrupt, Width::W16, 3),
            EventInputs {
                flags: 0x303,
                sp: 0xdead_beef_1122_3344,
                next_pc: 0x2200,
            },
        )
        .unwrap();
        assert_eq!(out.sp, expected_sp);
        assert_eq!(out.flags, 3);
        assert_eq!(context.cpl(), 0);
        assert_eq!(context.selector(Segment::Ss), 16);
        assert!(!context.segment(Segment::Ss).default32);
        assert_eq!(
            captured(&image, 0x401c, 20),
            [
                0, 0x22, 0, 0, 0x1b, 0, 0, 0, 3, 3, 0, 0, 0x44, 0x33, 0x22, 0x11, 0x23, 0, 0, 0
            ]
        );
        assert_eq!(image.read_vector(0x1008, 8).unwrap()[5], 0x9b);
        assert_eq!(image.read_vector(0x1010, 8).unwrap()[5], 0x93);
    }
}

#[test]
fn ia32e_ist1_and_ist7_use_live_qword_and_save_old_raw_stack_even_at_same_cpl() {
    for ist in [1u8, 7] {
        let mut context = context("long64", 0);
        context.set_gdtr(TableRegister {
            base: 0x1000,
            limit: 15,
        });
        context.set_idtr(TableRegister {
            base: 0x2000,
            limit: 63,
        });
        context.set_tr(TaskRegister {
            selector: 0x28,
            valid: true,
            base: 0x3000,
            limit: 0x67,
            attributes: 0x8b,
        });
        let old_ss = context.segment(Segment::Ss);
        let mut data = vec![0xa5; 1024];
        data[8..16].copy_from_slice(&0x00af_9a00_0000_ffffu64.to_le_bytes());
        data[304..312]
            .copy_from_slice(&(0x0000_8e00_0008_1234u64 | u64::from(ist) << 32).to_le_bytes());
        data[312..320].fill(0);
        let field = 512 + 28 + usize::from(ist) * 8;
        data[field..field + 8].copy_from_slice(&0x405fu64.to_le_bytes());
        let mut image = image(
            data,
            vec![
                mapping(0x1000, 0, 256, true, true),
                mapping(0x2000, 256, 256, true, false),
                mapping(0x3000, 512, 256, true, false),
                mapping(0x4000, 768, 256, true, true),
            ],
        );
        let out = execute(
            &mut context,
            &mut image,
            event(Kind::Int3, Width::W16, 3),
            EventInputs {
                flags: 0x303,
                sp: 0x8000_0000_0001,
                next_pc: 0x2200,
            },
        )
        .unwrap();
        assert_eq!((out.pc, out.sp, out.flags), (0x1234, 0x4028, 3));
        assert_eq!(context.selector(Segment::Ss), 0);
        let mut expected_ss = old_ss;
        expected_ss.usable = false;
        assert_eq!(context.segment(Segment::Ss), expected_ss);
        let expected = [0x2200u64, 8, 0x303, 0x8000_0000_0001, 16]
            .into_iter()
            .flat_map(u64::to_le_bytes)
            .collect::<Vec<_>>();
        assert_eq!(captured(&image, 0x4028, 40), expected);
    }
}

#[test]
fn into_clear_of_does_not_probe_tables_or_task_and_private_descriptor_rejects_malformed_shapes() {
    let mut context = context("protected", 3);
    let before = context.clone();
    let mut image = image(vec![0; 16], vec![mapping(0x1000, 0, 16, true, false)]);
    let input = EventInputs {
        flags: 0x303,
        sp: 0xdead_beef,
        next_pc: 0x1111,
    };
    assert_eq!(
        execute(
            &mut context,
            &mut image,
            event(Kind::Into, Width::W16, 4),
            input
        ),
        Ok(EventOutcome {
            pc: input.next_pc,
            sp: input.sp,
            flags: input.flags,
            context_changed: false
        })
    );
    assert_eq!(context, before);
    for encoded in [0x20, 0x40, 0x80, 0x10000, 7, 0x18, 0x101, 0x304, 0x100b] {
        assert_eq!(
            SoftwareEventDescriptor::try_decode(encoded),
            None,
            "{encoded:x}"
        );
    }
    for (kind, width, vector) in [
        (Kind::Interrupt, Width::W16, 255),
        (Kind::Int3, Width::W16, 3),
        (Kind::Into, Width::W16, 4),
        (Kind::Int1, Width::W16, 1),
        (Kind::Return, Width::W16, 0),
        (Kind::Return, Width::W32, 0),
        (Kind::Return, Width::W64, 0),
    ] {
        let descriptor = event(kind, width, vector);
        assert_eq!(
            SoftwareEventDescriptor::try_decode(descriptor.encode()),
            Some(descriptor)
        );
    }
}

#[test]
fn gate_dpl_precedes_presence_except_int1_and_v86_immediate_admission_precedes_idt() {
    for (kind, vector, expected_vector, error_code) in [
        (Kind::Interrupt, 1, 13, 10),
        (Kind::Int1, 1, 11, 11),
        (Kind::Int3, 3, 13, 26),
        (Kind::Into, 4, 13, 34),
    ] {
        let mut context = context("protected", 3);
        context.set_idtr(TableRegister {
            base: 0x2000,
            limit: 39,
        });
        let before = context.clone();
        let mut data = vec![0; 40];
        let offset = usize::from(vector) * 8;
        data[offset + 5] = 0x0e;
        let mut image = image(data, vec![mapping(0x2000, 0, 40, true, false)]);
        assert_eq!(
            execute(
                &mut context,
                &mut image,
                event(kind, Width::W16, vector),
                EventInputs {
                    flags: 0x802,
                    sp: 0,
                    next_pc: 0x1002
                }
            ),
            Err(EventFailure::Protection(ProtectionFault {
                vector: expected_vector,
                error_code,
                phase: if kind == Kind::Int1 {
                    ProtectionPhase::Descriptor
                } else {
                    ProtectionPhase::Privilege
                },
                selector: None
            }))
        );
        assert_eq!(context, before);
    }
    let mut context = context("virtual8086", 3);
    let before = context.clone();
    let mut image = image(vec![0; 8], vec![mapping(0x1000, 0, 8, true, false)]);
    assert_eq!(
        execute(
            &mut context,
            &mut image,
            event(Kind::Interrupt, Width::W16, 3),
            EventInputs {
                flags: 2,
                sp: 0,
                next_pc: 0x1002
            }
        ),
        Err(EventFailure::Protection(ProtectionFault {
            vector: 13,
            error_code: 0,
            phase: ProtectionPhase::Privilege,
            selector: None
        }))
    );
    assert_eq!(context, before);
}

#[test]
fn bad_target_precedes_private_frame_permission_and_late_denial_preserves_accessed_and_frame_bytes()
{
    for bad_target in [false, true] {
        let mut context = context("protected", 0);
        context.set_gdtr(TableRegister {
            base: 0x1000,
            limit: 15,
        });
        context.set_idtr(TableRegister {
            base: 0x2000,
            limit: 31,
        });
        let mut ss = context.segment(Segment::Ss);
        ss.base = 0x3000;
        ss.default32 = true;
        context.set_segment(Segment::Ss, 16, ss, context.attributes(Segment::Ss));
        let before = context.clone();
        let mut data = vec![0xa5; 768];
        let code = if bad_target {
            0x0040_9a00_0000_0100u64
        } else {
            0x00cf_9a00_0000_ffff
        };
        data[8..16].copy_from_slice(&code.to_le_bytes());
        data[280..288].copy_from_slice(&0x0000_8e00_0008_3456u64.to_le_bytes());
        let mut image = image(
            data,
            vec![
                mapping(0x1000, 0, 256, true, true),
                mapping(0x2000, 256, 256, true, false),
                mapping(0x3000, 512, 247, true, true),
                mapping(0x30f7, 759, 1, true, false),
                mapping(0x30f8, 760, 8, true, true),
            ],
        );
        let failure = execute(
            &mut context,
            &mut image,
            event(Kind::Int3, Width::W16, 3),
            EventInputs {
                flags: 0x303,
                sp: 0x100,
                next_pc: 0x2200,
            },
        )
        .unwrap_err();
        if bad_target {
            assert_eq!(
                failure,
                EventFailure::Protection(ProtectionFault {
                    vector: 13,
                    error_code: 0,
                    phase: ProtectionPhase::Target,
                    selector: None
                })
            );
        } else {
            assert!(matches!(
                failure,
                EventFailure::Operand {
                    segment: Segment::Ss,
                    failure: AccessFailure::Linear(crate::memory::Fault {
                        address: 0x30f4,
                        width: 4,
                        access: crate::memory::Access::Write,
                        cause: crate::memory::Cause::Permission,
                        failing: 0x30f7
                    })
                }
            ));
        }
        assert_eq!(context, before);
        assert_eq!(image.read_vector(0x1008, 8).unwrap()[5], 0x9a);
        assert_eq!(captured(&image, 0x30f4, 12), vec![0xa5; 12]);
    }
}
