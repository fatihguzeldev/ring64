use super::*;
use crate::x86::context::{TableRegister, TaskRegister};
use crate::x86::exception::{ExceptionEvent, InterruptEvent, InterruptSource};
use crate::x86::protection::tests::{context, image, mapping};

fn setup(mode: &str, cpl: u8, vector: u8, gate: u64) -> (ExecutionContext, Image) {
    let mut context = context(mode, cpl);
    context.set_gdtr(TableRegister {
        base: 0x1000,
        limit: 0xff,
    });
    context.set_idtr(TableRegister {
        base: 0x2000,
        limit: 0x1ff,
    });
    let mut bytes = vec![0xa5; 1536];
    bytes[8..16].copy_from_slice(&0x00cf_9b00_0000_ffffu64.to_le_bytes());
    bytes[16..24].copy_from_slice(&0x00cf_9300_0000_ffffu64.to_le_bytes());
    let slot = 256
        + usize::from(vector)
            * if mode == "long64" || mode == "compatibility" {
                16
            } else if mode == "real" {
                4
            } else {
                8
            };
    bytes[slot..slot + 8].copy_from_slice(&gate.to_le_bytes());
    if mode == "long64" || mode == "compatibility" {
        bytes[8..16].copy_from_slice(&0x00af_9b00_0000_ffffu64.to_le_bytes());
        bytes[slot + 8..slot + 16].fill(0);
    }
    let image = image(
        bytes,
        vec![
            mapping(0x1000, 0, 256, true, true),
            mapping(0x2000, 256, 512, true, true),
            mapping(0x3000, 768, 256, true, true),
            mapping(0x4000, 1024, 512, true, true),
        ],
    );
    (context, image)
}

fn enter(
    context: &mut ExecutionContext,
    image: &mut Image,
    vector: u8,
    code: Option<u16>,
    sp: u64,
) -> Result<EventOutcome, EventFailure> {
    let event = ExceptionEvent::fault(vector, 0x1000, 0x202, context, code);
    enter_exception(context, image, event, sp, 0x202)
}

#[test]
fn processor_protected_error_frame_separates_saved_rf_from_handler_flags_and_slot_widths() {
    for (gate, width, expected_sp) in [
        (0x0000_8e00_0008_2000, 4, 0x41f0),
        (0x0000_8600_0008_2000, 2, 0x41f8),
    ] {
        let (mut context, mut image) = setup("protected", 0, 13, gate);
        let result = enter(&mut context, &mut image, 13, Some(0x2b), 0x4200).unwrap();
        assert_eq!(
            (result.pc, result.sp, result.flags),
            (0x2000, expected_sp, 2)
        );
        for (index, value) in [0x2b, 0x1000, 8, if width == 4 { 0x10202 } else { 0x202 }]
            .into_iter()
            .enumerate()
        {
            assert_eq!(
                image
                    .read(expected_sp + index as u64 * u64::from(width), width)
                    .unwrap(),
                value
            );
        }
        assert_eq!(image.read(expected_sp - 1, 1).unwrap(), 0xa5);
    }
}

#[test]
fn processor_bypasses_dpl_while_software_int_retains_its_admission_and_ext() {
    let (mut context, mut image) = setup("protected", 3, 0, 0x0000_8e00_0008_2000);
    image.write(0x1008, 8, 0x00cf_fb00_0000_ffff).unwrap();
    let old = context.clone();
    assert_eq!(
        execute(
            &mut context,
            &mut image,
            SoftwareEventDescriptor {
                kind: SoftwareEventKind::Interrupt,
                vector: 0,
                width: Width::W16
            },
            EventInputs {
                flags: 0x202,
                sp: 0x4200,
                next_pc: 0x1002
            }
        ),
        Err(EventFailure::Protection(ProtectionFault {
            vector: 13,
            error_code: 2,
            phase: ProtectionPhase::Privilege,
            selector: None
        }))
    );
    assert_eq!(context, old);
    let result = enter(&mut context, &mut image, 0, None, 0x4200).unwrap();
    assert_eq!(result.sp, 0x41f4);
    assert_eq!(context.cpl(), 3);
    assert_eq!(image.read(0x41f4, 4).unwrap(), 0x1000);

    let (mut context, mut image) = setup("protected", 0, 13, 0x0000_0e00_0008_2000);
    assert_eq!(
        enter(&mut context, &mut image, 13, Some(0), 0x4200),
        Err(EventFailure::Protection(ProtectionFault {
            vector: 11,
            error_code: 0x6b,
            phase: ProtectionPhase::Descriptor,
            selector: None
        }))
    );
    let (mut context, mut image) = setup("long64", 0, 13, 0x0000_8600_0008_2000);
    assert_eq!(
        enter(&mut context, &mut image, 13, Some(0), 0x4200),
        Err(EventFailure::Protection(ProtectionFault {
            vector: 13,
            error_code: 0,
            phase: ProtectionPhase::Descriptor,
            selector: None
        }))
    );
}

#[test]
fn real_exception_uses_words_without_error_slot_even_for_error_code_vectors() {
    let (mut context, mut image) = setup("real", 0, 13, 0x0020_1234);
    let result = enter(&mut context, &mut image, 13, Some(0), 0x4200).unwrap();
    assert_eq!((result.pc, result.sp, result.flags), (0x1234, 0x41fa, 2));
    assert_eq!(image.read(0x41fa, 2).unwrap(), 0x1000);
    assert_eq!(image.read(0x41fc, 2).unwrap(), 8);
    assert_eq!(image.read(0x41fe, 2).unwrap(), 0x202);
    assert_eq!(image.read(0x41f8, 2).unwrap(), 0xa5a5);
}

#[test]
fn error_slot_private_refusal_leaves_frame_context_and_accessed_byte_unchanged() {
    let (mut context, mut image) = setup("protected", 0, 13, 0x0000_8e00_0008_2000);
    image.write(0x1008, 8, 0x00cf_9a00_0000_ffff).unwrap();
    image
        .set_mappings(vec![
            mapping(0x1000, 0, 256, true, true),
            mapping(0x2000, 256, 512, true, true),
            mapping(0x41f4, 1524, 12, true, true),
        ])
        .unwrap();
    let old = context.clone();
    assert!(matches!(
        enter(&mut context, &mut image, 13, Some(0), 0x4200),
        Err(EventFailure::Operand {
            segment: Segment::Ss,
            ..
        })
    ));
    assert_eq!(context, old);
    assert_eq!(image.read(0x100d, 1).unwrap(), 0x9a);
    for slot in [0x41f4, 0x41f8, 0x41fc] {
        assert_eq!(image.read(slot, 4).unwrap(), 0xa5a5_a5a5);
    }
}

#[test]
fn virtual_processor_uses_ten_dwords_and_refuses_valid_word_gate_before_tss_access() {
    let (mut context, mut image) = setup("virtual8086", 3, 13, 0x0000_8e00_0008_2000);
    context.set_tr(TaskRegister {
        selector: 0x28,
        valid: true,
        base: 0x3000,
        limit: 0x67,
        attributes: 0x8b,
    });
    image.write(0x3004, 4, 0x4200).unwrap();
    image.write(0x3008, 2, 16).unwrap();
    let result = enter(&mut context, &mut image, 13, Some(0x2b), 0x7000).unwrap();
    assert_eq!((result.sp, result.flags), (0x41d8, 2));
    for (index, value) in [0x2b, 0x1000, 0, 0x30202, 0x7000, 0, 0, 0, 0, 0]
        .into_iter()
        .enumerate()
    {
        assert_eq!(image.read(0x41d8 + index as u64 * 4, 4).unwrap(), value);
    }
    assert_eq!(context.mode(), Mode::Protected);
    assert_eq!(context.cpl(), 0);

    let (mut context, mut image) = setup("virtual8086", 3, 13, 0x0000_8600_0008_2000);
    let old = context.clone();
    assert_eq!(
        enter(&mut context, &mut image, 13, Some(0), 0x7000),
        Err(EventFailure::Unsupported)
    );
    assert_eq!(context, old);
    image.write(0x206d, 1, 6).unwrap();
    assert_eq!(
        enter(&mut context, &mut image, 13, Some(0), 0x7000),
        Err(EventFailure::Protection(ProtectionFault {
            vector: 11,
            error_code: 0x6b,
            phase: ProtectionPhase::Descriptor,
            selector: None
        }))
    );
}

#[test]
fn long_exception_aligns_stack_and_appends_one_qword_code_without_saving_live_rf() {
    let (mut context, mut image) = setup("long64", 0, 13, 0x0000_8e00_0008_2000);
    let result = enter(&mut context, &mut image, 13, Some(0x2b), 0x41ff).unwrap();
    assert_eq!((result.sp, result.flags), (0x41c0, 2));
    for (index, value) in [0x2b, 0x1000, 8, 0x10202, 0x41ff, 16]
        .into_iter()
        .enumerate()
    {
        assert_eq!(image.read(0x41c0 + index as u64 * 8, 8).unwrap(), value);
    }
    assert_eq!(image.read(0x41bf, 1).unwrap(), 0xa5);
}

#[test]
fn noncanonical_entry_stack_has_a_hard_zero_even_for_int1_and_processor_sources() {
    for sp in [0x8000_0000_0000, 0xffff_8000_0000_0000] {
        let (mut context, mut image) = setup("long64", 0, 1, 0x0000_8e00_0008_2000);
        let failure = execute(
            &mut context,
            &mut image,
            SoftwareEventDescriptor {
                kind: SoftwareEventKind::Int1,
                width: Width::W16,
                vector: 1,
            },
            EventInputs {
                flags: 0x202,
                sp,
                next_pc: 0x1001,
            },
        )
        .unwrap_err();
        assert_eq!(
            failure,
            EventFailure::Protection(ProtectionFault {
                vector: 12,
                error_code: 0,
                phase: ProtectionPhase::Target,
                selector: None
            })
        );
    }
}

#[test]
fn noncanonical_int1_handler_target_has_a_hard_zero_not_ext() {
    let (mut context, mut image) = setup("long64", 0, 1, 0x0000_8e00_0008_2000);
    image.write(0x2018, 4, 0x8000).unwrap();
    let failure = execute(
        &mut context,
        &mut image,
        SoftwareEventDescriptor {
            kind: SoftwareEventKind::Int1,
            width: Width::W16,
            vector: 1,
        },
        EventInputs {
            flags: 0x202,
            sp: 0x4200,
            next_pc: 0x1001,
        },
    )
    .unwrap_err();
    assert_eq!(
        failure,
        EventFailure::Protection(ProtectionFault {
            vector: 13,
            error_code: 0,
            phase: ProtectionPhase::Target,
            selector: None
        })
    );
}

#[test]
fn malformed_processor_image_is_rejected_before_gate_or_stack_access() {
    let mut context = context("protected", 0);
    let old = context.clone();
    let mut image = image(vec![0; 1], vec![mapping(0x9000, 0, 1, true, true)]);
    for event in [
        ExceptionEvent::fault(14, 0x1000, 2, &context, Some(0)),
        ExceptionEvent::fault(13, 0x1000, 2, &context, None),
        ExceptionEvent {
            numeric: None,
            debug: None,
            saved_flags: 0x10203,
            ..ExceptionEvent::fault(13, 0x1000, 2, &context, Some(0))
        },
    ] {
        assert_eq!(
            enter_exception(&mut context, &mut image, event, 0x8000, 2),
            Err(EventFailure::Unsupported)
        );
        assert_eq!(context, old);
    }
}

#[test]
fn trap_frame_keeps_captured_rf_while_handler_uses_live_flags_and_has_no_error_slot() {
    let (mut context, mut image) = setup("protected", 0, 1, 0x0000_8f00_0008_2000);
    let event = ExceptionEvent {
        numeric: None,
        page_fault_address: None,
        debug: None,
        vector: 1,
        instruction_pc: 0x1000,
        return_pc: 0x1010,
        saved_flags: 0x302,
        error_code: None,
    };
    let result = enter_exception(&mut context, &mut image, event, 0x4200, 0x10302).unwrap();
    assert_eq!(
        (result.pc, result.sp, result.flags),
        (0x2000, 0x41f4, 0x202)
    );
    assert_eq!(image.read(0x41f4, 4).unwrap(), 0x1010);
    assert_eq!(image.read(0x41fc, 4).unwrap(), 0x302);
    assert_eq!(image.read(0x41f0, 4).unwrap(), 0xa5a5_a5a5);
}

#[test]
fn external_reserved_vectors_bypass_gate_dpl_and_never_add_an_error_slot() {
    for vector in [0, 2, 8, 13, 31] {
        let (mut context, mut image) = setup("protected", 3, vector, 0x0000_8e00_0008_2000);
        image.write(0x1008, 8, 0x00cf_fb00_0000_ffff).unwrap();
        let event = InterruptEvent {
            source: InterruptSource::Irq(vector),
            return_pc: 0x1234,
            saved_flags: 0x10202,
        };
        let out = enter_interrupt(&mut context, &mut image, event, 0x4200, 0x10202).unwrap();
        assert_eq!((out.pc, out.sp, out.flags), (0x2000, 0x41f4, 2));
        assert_eq!(image.read(0x41f4, 4).unwrap(), 0x1234);
        assert_eq!(image.read(0x41f8, 4).unwrap(), 8);
        assert_eq!(image.read(0x41fc, 4).unwrap(), 0x10202);
        assert_eq!(image.read(0x41f0, 4).unwrap(), 0xa5a5_a5a5);
    }
}

#[test]
fn external_vm_frame_uses_nine_dwords_with_vm_but_without_forced_rf() {
    let (mut context, mut image) = setup("virtual8086", 3, 2, 0x0000_8e00_0008_2000);
    context.set_tr(TaskRegister {
        selector: 0x28,
        valid: true,
        base: 0x3000,
        limit: 0x67,
        attributes: 0x8b,
    });
    image.write(0x3004, 4, 0x4200).unwrap();
    image.write(0x3008, 2, 16).unwrap();
    let event = InterruptEvent {
        source: InterruptSource::Nmi,
        return_pc: 0x1234,
        saved_flags: 0x20202,
    };
    let out = enter_interrupt(&mut context, &mut image, event, 0x7000, 0x202).unwrap();
    assert_eq!((out.sp, out.flags), (0x41dc, 2));
    for (i, expected) in [0x1234, 0, 0x20202, 0x7000, 0, 0, 0, 0, 0]
        .into_iter()
        .enumerate()
    {
        assert_eq!(image.read(0x41dc + i as u64 * 4, 4).unwrap(), expected);
    }
    let (mut context, mut image) = setup("virtual8086", 3, 2, 0x0000_8600_0008_2000);
    assert_eq!(
        enter_interrupt(&mut context, &mut image, event, 0x7000, 0x202),
        Err(EventFailure::Unsupported)
    );
}

#[test]
fn switched_legacy_stack_limits_keep_new_ss_and_ext_without_publishing_a_frame() {
    for descriptor in [0x0040_9300_0000_41f7, 0x0040_9700_0000_41f7] {
        for external in [false, true] {
            let (mut context, mut image) = setup("protected", 3, 32, 0x0000_ee00_0008_2000);
            image.write(0x1010, 8, descriptor).unwrap();
            image.write(0x4004, 4, 0x4200).unwrap();
            image.write(0x4008, 2, 16).unwrap();
            context.set_tr(TaskRegister {
                selector: 0x28,
                valid: true,
                base: 0x4000,
                limit: 0x67,
                attributes: 0x8b,
            });
            let before = context.clone();
            let guard = image.read_bytes(0x4100, 256).unwrap();
            let failure = if external {
                enter_interrupt(
                    &mut context,
                    &mut image,
                    InterruptEvent {
                        source: InterruptSource::Irq(32),
                        return_pc: 0x1000,
                        saved_flags: 0x202,
                    },
                    0x4200,
                    0x202,
                )
            } else {
                execute(
                    &mut context,
                    &mut image,
                    SoftwareEventDescriptor {
                        kind: SoftwareEventKind::Interrupt,
                        width: Width::W16,
                        vector: 32,
                    },
                    EventInputs {
                        flags: 0x202,
                        sp: 0x4200,
                        next_pc: 0x1002,
                    },
                )
            }
            .unwrap_err();
            assert_eq!(
                failure.architectural(&context),
                Some(ProtectionFault {
                    vector: 12,
                    error_code: 16 | u16::from(external),
                    phase: ProtectionPhase::Target,
                    selector: Some(16),
                }),
                "{failure:?}"
            );
            assert!(matches!(
                failure,
                EventFailure::StackLimit {
                    failure: crate::x86::context::SegmentFault {
                        segment: Segment::Ss,
                        cause: crate::x86::context::SegmentCause::Limit,
                        ..
                    },
                    ..
                }
            ));
            assert_eq!(context, before);
            assert_eq!(image.read_bytes(0x4100, 256).unwrap(), guard);
        }
    }
}
