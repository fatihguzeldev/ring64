use super::super::exception_delivery::{
    core_configure_delivery, core_deliver_exception, core_stage_exception,
};
use super::super::system_flags::core_debug_step;
use super::*;
use crate::embedding::layout::{DEBUG_EXCEPTION, PROTECTION, SHUTDOWN, SYSTEM_MEMORY};
use crate::x86::context::TableRegister;
use crate::x86::exception::{EventState, ExceptionEvent};

fn event() -> EventState {
    BRIDGE.with_borrow(|bridge| {
        unsafe { (*bridge.core.as_ref().unwrap().state.get()).event }
            .decode()
            .unwrap()
    })
}

#[test]
fn ud2_staging_preserves_private_prefix_fetch_and_report_frontiers() {
    for bytes in [
        &[0x0f, 0x0b][..],
        &[0xf0, 0x0f, 0x0b],
        &[0x66, 0x48, 0x0f, 0x0b],
    ] {
        initialize(0x1000, bytes);
        BRIDGE.with_borrow_mut(|bridge| unsafe {
            (*bridge.core.as_mut().unwrap().state.get()).flags = 0x10202;
        });
        assert_eq!(core_probe(0x1000), UNSUPPORTED);
        assert_eq!(core_stage_exception(UNSUPPORTED), 0);
        assert_eq!(event(), EventState::Ready);
        BRIDGE.with_borrow(|bridge| {
            assert_eq!(
                unsafe { (*bridge.core.as_ref().unwrap().state.get()).flags },
                0x10202
            );
        });
        assert_eq!(core_configure_delivery(1), 0);
        assert_eq!(core_stage_exception(UNSUPPORTED), 1);
        assert_eq!(
            event(),
            EventState::Pending(ExceptionEvent {
                vector: 6,
                instruction_pc: 0x1000,
                return_pc: 0x1000,
                saved_flags: 0x10202,
                error_code: None,
            })
        );
        BRIDGE.with_borrow(|bridge| {
            assert_eq!(
                unsafe { (*bridge.core.as_ref().unwrap().state.get()).flags },
                0x202
            );
        });
        let retained = event();
        core_clear_fault();
        assert_eq!(event(), retained);
    }
    for (bytes, reason) in [
        (&[0xf3, 0x0f, 0x0b][..], UNSUPPORTED),
        (&[0xf0, 0xf0, 0x0f, 0x0b], UNSUPPORTED),
        (&[0x0f], FETCH),
        (&[0x66; 15][..], INVALID),
    ] {
        initialize(0x1000, bytes);
        assert_eq!(core_configure_delivery(1), 0);
        BRIDGE.with_borrow_mut(|bridge| unsafe {
            (*bridge.core.as_mut().unwrap().state.get()).flags = 0x10202;
        });
        assert_eq!(core_probe(0x1000), reason);
        assert_eq!(core_stage_exception(reason), 0);
        assert_eq!(event(), EventState::Ready);
        BRIDGE.with_borrow(|bridge| {
            assert_eq!(
                unsafe { (*bridge.core.as_ref().unwrap().state.get()).flags },
                0x10202
            );
        });
    }
}

#[test]
fn staged_completed_trap_survives_transient_clear_and_private_entry_failure_before_escalation() {
    initialize(0x1000, &[0x90]);
    assert_eq!(core_configure_delivery(1), 0);
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        core.context.set_idtr(TableRegister {
            base: 0x7000,
            limit: 0x3ff,
        });
        let state = unsafe { &mut *core.state.get() };
        state.rip = 0x1010;
        state.flags = 0x302;
        state.interruptibility = 1;
        state.remaining = 7;
        state.repeat_remaining = 11;
        state.registers = [0x1234; 16];
    });
    assert_eq!(core_debug_step(0x1000, 0x1010, 1, 0x302), DEBUG_EXCEPTION);
    assert_eq!(core_stage_exception(DEBUG_EXCEPTION), 1);
    let original = event();
    core_clear_fault();
    assert_eq!(event(), original);
    assert_eq!(core_deliver_exception(), SYSTEM_MEMORY);
    assert_eq!(event(), original);
    BRIDGE.with_borrow(|bridge| {
        let state = unsafe { &*bridge.core.as_ref().unwrap().state.get() };
        assert_eq!(
            (state.rip, state.flags, state.interruptibility),
            (0x1010, 0x302, 1)
        );
        assert_eq!((state.remaining, state.repeat_remaining), (7, 11));
        assert_eq!(state.registers, [0x1234; 16]);
    });
    BRIDGE.with_borrow_mut(|bridge| {
        bridge
            .core
            .as_mut()
            .unwrap()
            .context
            .set_idtr(TableRegister::default());
    });
    assert_eq!(core_deliver_exception(), DISPATCH);
    assert_eq!(
        event(),
        EventState::Pending(ExceptionEvent {
            vector: 13,
            instruction_pc: 0x1000,
            return_pc: 0x1010,
            saved_flags: 0x10302,
            error_code: Some(0xb),
        })
    );
    assert_eq!(metadata(SYSTEM_MEMORY), serde_json::Value::Null);
    assert_eq!(metadata(PROTECTION), serde_json::Value::Null);
    assert_eq!(core_deliver_exception(), DISPATCH);
    assert_eq!(
        event(),
        EventState::Pending(ExceptionEvent {
            vector: 8,
            instruction_pc: 0x1000,
            return_pc: 0x1010,
            saved_flags: 0x10302,
            error_code: Some(0),
        })
    );
    assert_eq!(core_deliver_exception(), SHUTDOWN);
    assert_eq!(event(), EventState::Shutdown);
    core_clear_fault();
    assert_eq!(event(), EventState::Shutdown);
}

#[test]
fn malformed_raw_event_imports_publish_no_scalar_or_retained_event_changes() {
    for (offset, value) in [(0, 3), (4, 256), (32, 65536), (36, 2), (32, 1)] {
        initialize(0x1000, &[0x90]);
        assert_eq!(core_configure_delivery(1), 0);
        assert_eq!(core_stage_exception(DIVIDE_ERROR), 1);
        let original = event();
        BRIDGE.with_borrow_mut(|bridge| {
            let mut input = vec![0; SCALAR_STATE_SIZE + 40];
            input[..8].copy_from_slice(&99u64.to_le_bytes());
            input[128..136].copy_from_slice(&2u64.to_le_bytes());
            input[136..144].copy_from_slice(&0x1000u64.to_le_bytes());
            let raw = &mut input[SCALAR_STATE_SIZE..];
            raw[..4].copy_from_slice(&1u32.to_le_bytes());
            raw[8..16].copy_from_slice(&0x1000u64.to_le_bytes());
            raw[16..24].copy_from_slice(&0x1000u64.to_le_bytes());
            raw[24..32].copy_from_slice(&0x10002u64.to_le_bytes());
            raw[offset..offset + 4].copy_from_slice(&(value as u32).to_le_bytes());
            bridge.input = input;
        });
        assert_eq!(core_import_state(), 1, "field {offset}, value {value}");
        assert_eq!(event(), original);
        BRIDGE.with_borrow(|bridge| {
            assert_eq!(
                unsafe { (*bridge.core.as_ref().unwrap().state.get()).registers[0] },
                0
            );
        });
    }
}

#[test]
fn disabled_configuration_and_unselected_reasons_never_consume_retained_state() {
    initialize(0x1000, &[0x90]);
    for enabled in [-1, 2, i32::MAX] {
        assert_eq!(core_configure_delivery(enabled), -1);
    }
    assert_eq!(core_configure_delivery(1), 0);
    for reason in [
        DISPATCH,
        STOP,
        BUDGET,
        DATA,
        FETCH,
        INVALID,
        RESOURCE,
        SEGMENT,
        TARGET,
        UNSUPPORTED,
        REPEAT_BUDGET,
    ] {
        assert_eq!(core_stage_exception(reason), 0);
        assert_eq!(event(), EventState::Ready);
    }
    assert_eq!(core_stage_exception(DIVIDE_ERROR), 1);
    let pending = event();
    assert_eq!(core_stage_exception(DIVIDE_ERROR), -1);
    assert_eq!(event(), pending);
    assert_eq!(core_configure_delivery(0), 0);
    assert_eq!(core_stage_exception(DIVIDE_ERROR), 0);
    assert_eq!(event(), pending);
}
