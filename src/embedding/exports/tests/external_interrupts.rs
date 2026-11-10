use super::super::exception_delivery::{core_configure_delivery, core_deliver_exception};
use super::super::external_interrupts::{
    core_external_boundary, core_external_step, core_request_interrupt, core_request_nmi,
    core_shutdown_can_wake,
};
use super::super::software_events::core_software_event;
use super::*;
use crate::embedding::layout::{HALTED, PENDING_INTERRUPT, PROTECTION, SHUTDOWN, SYSTEM_MEMORY};
use crate::x86::context::TableRegister;
use crate::x86::instruction::{SoftwareEventDescriptor, SoftwareEventKind, Width};

#[test]
fn external_intake_coalesces_without_acceptance_and_nmi_refusal_retains_blocking() {
    initialize(0x1000, &[0x90]);
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        core.context.set_idtr(TableRegister {
            base: 0x7000,
            limit: 0x3ff,
        });
        unsafe {
            (*core.state.get()).flags = 0x10202;
        }
    });
    assert_eq!(core_request_interrupt(13), 0);
    assert_eq!(core_request_interrupt(13), 1);
    assert_eq!(core_request_interrupt(32), 1);
    assert_eq!(core_request_interrupt(256), -1);
    assert_eq!(core_request_nmi(), 0);
    assert_eq!(core_request_nmi(), 0);
    assert_eq!(core_external_boundary(), PENDING_INTERRUPT);
    BRIDGE.with_borrow(|bridge| {
        let state = unsafe { &*bridge.core.as_ref().unwrap().state.get() };
        assert_eq!(state.event.kind, 0);
        assert_eq!(
            (
                state.interrupts.irq,
                state.interrupts.nmi_pending,
                state.interrupts.nmi_blocked
            ),
            (14, 1, 0)
        );
    });
    assert_eq!(core_configure_delivery(1), 0);
    assert_eq!(core_external_boundary(), PENDING_INTERRUPT);
    assert_eq!(core_request_nmi(), 0);
    assert_eq!(core_deliver_exception(), SYSTEM_MEMORY);
    core_clear_fault();
    assert_eq!(core_external_boundary(), PENDING_INTERRUPT);
    BRIDGE.with_borrow(|bridge| {
        let state = unsafe { &*bridge.core.as_ref().unwrap().state.get() };
        assert_eq!(
            (
                state.event.kind,
                state.event.vector,
                state.event.return_pc,
                state.event.saved_flags
            ),
            (5, 2, 0x1000, 0x10202)
        );
        assert_eq!(
            (
                state.interrupts.irq,
                state.interrupts.nmi_pending,
                state.interrupts.nmi_blocked
            ),
            (14, 1, 1)
        );
        assert_eq!((state.rip, state.flags), (0x1000, 0x10202));
    });
}

#[test]
fn external_reserved_vectors_start_benign_escalation_and_preserve_ext() {
    for (vector, error_code) in [(8, 0x43), (13, 0x6b)] {
        initialize(0x1000, &[0x90]);
        BRIDGE.with_borrow_mut(|bridge| {
            let core = bridge.core.as_mut().unwrap();
            let mut context = core.context.to_json();
            context["mode"] = serde_json::json!("protected");
            core.context = ExecutionContext::from_json(&context).unwrap();
            unsafe {
                (*core.state.get()).flags = 0x202;
            }
        });
        assert_eq!(core_configure_delivery(1), 0);
        assert_eq!(core_request_interrupt(vector), 0);
        assert_eq!(core_external_boundary(), PENDING_INTERRUPT);
        assert_eq!(core_deliver_exception(), DISPATCH);
        BRIDGE.with_borrow(|bridge| {
            let state = unsafe { &*bridge.core.as_ref().unwrap().state.get() };
            assert_eq!(
                (state.event.kind, state.event.vector, state.event.error_code),
                (1, 13, error_code)
            );
            assert_eq!(
                (
                    state.event.instruction_pc,
                    state.event.return_pc,
                    state.event.saved_flags
                ),
                (0x1000, 0x1000, 0x10202)
            );
            assert_eq!(state.interrupts.irq, 0);
        });
        assert_eq!(core_deliver_exception(), DISPATCH);
        BRIDGE.with_borrow(|bridge| {
            assert_eq!(
                unsafe { (*bridge.core.as_ref().unwrap().state.get()).event.vector },
                8
            )
        });
        assert_eq!(core_deliver_exception(), SHUTDOWN);
    }
}

#[test]
fn generated_external_step_captures_live_arguments_without_overwriting_scalar_locals() {
    initialize(0x1000, &[0x90]);
    assert_eq!(core_configure_delivery(1), 0);
    assert_eq!(core_request_interrupt(32), 0);
    assert_eq!(core_external_step(0x1010, 0x10202, 0), PENDING_INTERRUPT);
    BRIDGE.with_borrow(|bridge| {
        let state = unsafe { &*bridge.core.as_ref().unwrap().state.get() };
        assert_eq!((state.rip, state.flags), (0x1000, 2));
        assert_eq!(
            (
                state.event.kind,
                state.event.return_pc,
                state.event.saved_flags
            ),
            (4, 0x1010, 0x10202)
        );
        assert_eq!(state.interrupts.irq, 0);
    });
}

fn external_input(kind: u32, flags: u64, shadow: u32, blocked: u32) -> Vec<u8> {
    let mut input = vec![0; SCALAR_STATE_SIZE + 52];
    input[128..136].copy_from_slice(&flags.to_le_bytes());
    input[136..144].copy_from_slice(&0x1000_u64.to_le_bytes());
    input[164..168].copy_from_slice(&shadow.to_le_bytes());
    let event = &mut input[SCALAR_STATE_SIZE..SCALAR_STATE_SIZE + 40];
    event[..4].copy_from_slice(&kind.to_le_bytes());
    event[4..8].copy_from_slice(&(if kind == 5 { 2_u32 } else { 13_u32 }).to_le_bytes());
    event[16..24].copy_from_slice(&0x1000_u64.to_le_bytes());
    event[24..32].copy_from_slice(&flags.to_le_bytes());
    input[SCALAR_STATE_SIZE + 40..SCALAR_STATE_SIZE + 44].copy_from_slice(&33_u32.to_le_bytes());
    input[SCALAR_STATE_SIZE + 44..SCALAR_STATE_SIZE + 48].copy_from_slice(&1_u32.to_le_bytes());
    input[SCALAR_STATE_SIZE + 48..].copy_from_slice(&blocked.to_le_bytes());
    input
}

#[test]
fn external_checkpoint_crossfields_reject_atomically_and_legacy_import_cancels_queues() {
    initialize(0x1000, &[0x90]);
    BRIDGE.with_borrow_mut(|bridge| bridge.input = external_input(4, 0x202, 0, 0));
    assert_eq!(core_import_state(), 0);
    for input in [
        external_input(4, 2, 0, 0),
        external_input(4, 0x202, 1, 0),
        external_input(5, 0x202, 0, 0),
        external_input(5, 0x202, 2, 1),
    ] {
        BRIDGE.with_borrow_mut(|bridge| {
            bridge.input = input;
            bridge.input[..8].copy_from_slice(&99_u64.to_le_bytes());
        });
        assert_eq!(core_import_state(), 1);
        BRIDGE.with_borrow(|bridge| {
            let state = unsafe { &*bridge.core.as_ref().unwrap().state.get() };
            assert_eq!(
                (state.registers[0], state.event.kind, state.interrupts.irq),
                (0, 4, 33)
            );
        });
    }
    BRIDGE.with_borrow_mut(|bridge| bridge.input = external_input(5, 0x202, 1, 1));
    assert_eq!(core_import_state(), 0);
    BRIDGE.with_borrow_mut(|bridge| {
        bridge.input = external_input(4, 0x202, 0, 0);
        bridge.input.truncate(SCALAR_STATE_SIZE);
    });
    assert_eq!(core_import_state(), 0);
    BRIDGE.with_borrow(|bridge| {
        let state = unsafe { &*bridge.core.as_ref().unwrap().state.get() };
        assert_eq!(state.event.kind, 0);
        assert_eq!(state.interrupts, RawInterruptState::default());
    });
}

#[test]
fn iret_unblocks_nmi_before_private_stack_and_virtual_privilege_failures() {
    for (mode, width, flags, reason) in [
        ("long64", Width::W64, 0x202, DATA),
        ("protected", Width::W32, 0x4202, UNSUPPORTED),
        ("virtual8086", Width::W32, 0x202, PROTECTION),
    ] {
        initialize(0x1000, &[0xcf]);
        BRIDGE.with_borrow_mut(|bridge| {
            let core = bridge.core.as_mut().unwrap();
            let mut context = core.context.to_json();
            context["mode"] = serde_json::json!(mode);
            if mode == "virtual8086" {
                context["cpl"] = serde_json::json!(3);
                for name in ["cs", "ss", "ds", "es", "fs", "gs"] {
                    context["segments"][name]["selector"] = serde_json::json!(0);
                    context["segments"][name]["base"] = serde_json::json!("0x0");
                    context["segments"][name]["limit"] = serde_json::json!(0xffff);
                    context["segments"][name]["type"] = serde_json::json!("read-write");
                    context["segments"][name]["default32"] = serde_json::json!(false);
                }
            }
            core.context = ExecutionContext::from_json(&context).unwrap();
            unsafe {
                (*core.state.get()).interrupts.nmi_blocked = 1;
            }
        });
        assert_eq!(core_software_event(u32::MAX, 0x7000, flags, 0x1001), -1);
        BRIDGE.with_borrow(|bridge| {
            assert_eq!(
                unsafe {
                    (*bridge.core.as_ref().unwrap().state.get())
                        .interrupts
                        .nmi_blocked
                },
                1
            )
        });
        let descriptor = SoftwareEventDescriptor {
            kind: SoftwareEventKind::Return,
            vector: 0,
            width,
        };
        assert_eq!(
            core_software_event(descriptor.encode(), 0x7000, flags, 0x1001),
            reason
        );
        BRIDGE.with_borrow(|bridge| {
            assert_eq!(
                unsafe {
                    (*bridge.core.as_ref().unwrap().state.get())
                        .interrupts
                        .nmi_blocked
                },
                0
            )
        });
    }
}

#[test]
fn shutdown_dry_wake_and_halted_boundaries_preserve_the_selected_profile() {
    initialize(0x1000, &[0x90]);
    BRIDGE.with_borrow_mut(|bridge| unsafe {
        let state = &mut *bridge.core.as_mut().unwrap().state.get();
        state.event.kind = 2;
        state.interrupts.nmi_pending = 1;
    });
    assert_eq!(core_shutdown_can_wake(), 0);
    assert_eq!(core_external_boundary(), SHUTDOWN);
    assert_eq!(core_configure_delivery(1), 0);
    assert_eq!(core_shutdown_can_wake(), 1);
    BRIDGE.with_borrow(|bridge| {
        assert_eq!(
            unsafe { (*bridge.core.as_ref().unwrap().state.get()).event.kind },
            2
        )
    });
    BRIDGE.with_borrow_mut(|bridge| unsafe {
        (*bridge.core.as_mut().unwrap().state.get()).interruptibility = 2;
    });
    assert_eq!(core_shutdown_can_wake(), 0);
    assert_eq!(core_external_boundary(), SHUTDOWN);
    BRIDGE.with_borrow_mut(|bridge| unsafe {
        (*bridge.core.as_mut().unwrap().state.get()).interruptibility = 0;
    });
    assert_eq!(core_external_boundary(), PENDING_INTERRUPT);
    BRIDGE.with_borrow(|bridge| {
        let state = unsafe { &*bridge.core.as_ref().unwrap().state.get() };
        assert_eq!(
            (
                state.event.kind,
                state.interrupts.nmi_pending,
                state.interrupts.nmi_blocked
            ),
            (5, 0, 1)
        );
    });
    initialize(0x1000, &[0x90]);
    assert_eq!(core_request_interrupt(2), 0);
    BRIDGE.with_borrow_mut(|bridge| unsafe {
        (*bridge.core.as_mut().unwrap().state.get()).event.kind = 3;
    });
    assert_eq!(core_external_boundary(), HALTED);
}

#[test]
fn accepted_blocked_nmi_retries_repaired_ivt_and_publishes_one_fixed_word_frame() {
    initialize(0x1000, &[0x90]);
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        let mut context = core.context.to_json();
        context["mode"] = serde_json::json!("real");
        core.context = ExecutionContext::from_json(&context).unwrap();
        core.context.set_idtr(TableRegister {
            base: 0x7000,
            limit: 0x3ff,
        });
        unsafe {
            (*core.state.get()).registers[4] = 0x4010;
        }
    });
    assert_eq!(core_configure_delivery(1), 0);
    assert_eq!(core_request_nmi(), 0);
    assert_eq!(core_external_boundary(), PENDING_INTERRUPT);
    assert_eq!(core_deliver_exception(), SYSTEM_MEMORY);
    assert_eq!(core_request_nmi(), 0);
    assert_eq!(core_request_nmi(), 0);
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        // NMI IVT slot starts in the mapped data bank; its captured target is A5A5:A5A5.
        core.context.set_idtr(TableRegister {
            base: 0x3ff8,
            limit: 0x3ff,
        });
    });
    assert_eq!(core_external_boundary(), PENDING_INTERRUPT);
    assert_eq!(core_deliver_exception(), DISPATCH);
    BRIDGE.with_borrow(|bridge| {
        let core = bridge.core.as_ref().unwrap();
        let state = unsafe { &*core.state.get() };
        assert_eq!(
            (state.event.kind, state.rip, state.registers[4], state.flags),
            (0, 0xa5a5, 0x400a, 2)
        );
        assert_eq!(
            (state.interrupts.nmi_pending, state.interrupts.nmi_blocked),
            (1, 1)
        );
        assert_eq!(core.image.read(0x400a, 2).unwrap(), 0x1000);
        assert_eq!(core.image.read(0x400c, 2).unwrap(), 8);
        assert_eq!(core.image.read(0x400e, 2).unwrap(), 2);
        assert_eq!(core.image.read(0x4008, 2).unwrap(), 0xa5a5);
    });
    assert_eq!(core_external_boundary(), DISPATCH);
}

#[test]
fn lock_halt_selected_ud_keeps_report_rf_and_does_not_broaden_other_invalid_frontiers() {
    use super::super::exception_delivery::core_stage_exception;
    for (bytes, reason, selected) in [
        (&[0xf0, 0xf4][..], INVALID, true),
        (&[0x66, 0xf0, 0xf4][..], INVALID, true),
        (&[0xf0, 0x90][..], INVALID, false),
        (&[0xf0, 0xf0, 0xf4][..], UNSUPPORTED, false),
        (&[0xf0][..], FETCH, false),
        (&[0x66; 15][..], INVALID, false),
    ] {
        initialize(0x1000, bytes);
        BRIDGE.with_borrow_mut(|bridge| unsafe {
            (*bridge.core.as_mut().unwrap().state.get()).flags = 0x10202;
        });
        assert_eq!(core_probe(0x1000), reason);
        assert_eq!(core_stage_exception(reason), 0);
        BRIDGE.with_borrow(|bridge| {
            assert_eq!(
                unsafe { (*bridge.core.as_ref().unwrap().state.get()).flags },
                0x10202
            )
        });
        assert_eq!(core_configure_delivery(1), 0);
        assert_eq!(core_stage_exception(reason), i32::from(selected));
        BRIDGE.with_borrow(|bridge| {
            let state = unsafe { &*bridge.core.as_ref().unwrap().state.get() };
            if selected {
                assert_eq!(
                    (
                        state.event.kind,
                        state.event.vector,
                        state.event.saved_flags,
                        state.flags
                    ),
                    (1, 6, 0x10202, 0x202)
                );
            } else {
                assert_eq!((state.event.kind, state.flags), (0, 0x10202));
            }
        });
    }
}
