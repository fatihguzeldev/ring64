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
    for (bytes, reason, vector) in [
        (&[0xf3, 0x0f, 0x0b][..], UNSUPPORTED, None),
        (&[0xf0, 0xf0, 0x0f, 0x0b], UNSUPPORTED, None),
        (&[0x0f], FETCH, None),
        (&[0x66; 15][..], INVALID, Some(13)),
    ] {
        initialize(0x1000, bytes);
        assert_eq!(core_configure_delivery(1), 0);
        BRIDGE.with_borrow_mut(|bridge| unsafe {
            (*bridge.core.as_mut().unwrap().state.get()).flags = 0x10202;
        });
        assert_eq!(core_probe(0x1000), reason);
        assert_eq!(core_stage_exception(reason), i32::from(vector.is_some()));
        if let Some(vector) = vector {
            let EventState::Pending(selected) = event() else {
                panic!("selected length fault")
            };
            assert_eq!((selected.vector, selected.error_code), (vector, Some(0)));
        } else {
            assert_eq!(event(), EventState::Ready);
        }
        BRIDGE.with_borrow(|bridge| {
            assert_eq!(
                unsafe { (*bridge.core.as_ref().unwrap().state.get()).flags },
                if vector.is_some() { 0x202 } else { 0x10202 }
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

#[test]
fn late_error_slot_refusal_preserves_source_owner_and_numeric_banks_until_repaired_commit() {
    initialize(0x1000, &[0x90]);
    let maps = || {
        use crate::memory::{MappingInput, Permissions};
        [(0x2000, 0, 16), (0x3000, 64, 112), (0x41f4, 260, 12)]
            .into_iter()
            .map(|(base, offset, length)| MappingInput {
                base,
                offset,
                length,
                backing: "bytes".into(),
                permissions: Permissions {
                    read: true,
                    write: true,
                    execute: true,
                },
            })
            .collect::<Vec<_>>()
    };
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        let mut context = ExecutionContext::default().to_json();
        context["mode"] = serde_json::json!("protected");
        context["segments"]["ss"]["default32"] = serde_json::json!(true);
        core.context = ExecutionContext::from_json(&context).unwrap();
        core.context.set_gdtr(TableRegister {
            base: 0x2000,
            limit: 15,
        });
        core.context.set_idtr(TableRegister {
            base: 0x3000,
            limit: 111,
        });
        let mut bytes = vec![0xa5; 512];
        bytes[8..16].copy_from_slice(&0x00cf_9a00_0000_ffffu64.to_le_bytes());
        bytes[168..176].copy_from_slice(&0x0000_8e00_0008_5000u64.to_le_bytes());
        core.image = Image::mapped(
            vec![("bytes".into(), bytes)],
            maps(),
            crate::memory::MemoryLimits {
                max_backing_bytes: 512,
                max_backings: 1,
                max_mappings: 4,
            },
        )
        .unwrap();
        let source = core.image.register_source([(0x200d, 1)]).unwrap();
        assert_eq!(source, 1);
        assert!(core.image.activate(source));
        core.protection_fault = Some(crate::x86::protection::ProtectionFault {
            vector: 13,
            error_code: 0,
            phase: crate::x86::protection::ProtectionPhase::Descriptor,
            selector: None,
        });
        let state = unsafe { &mut *core.state.get() };
        state.registers = [0x1234; 16];
        state.registers[4] = 0x4200;
        state.flags = 2;
        state.xmm = [[0x5a; 16]; 16];
        state.mxcsr = 0xffc5;
        state.x87.set_raw(3, 0x4000_8123_4567_89ab_cdef);
    });
    assert_eq!(core_configure_delivery(1), 0);
    assert_eq!(core_stage_exception(PROTECTION), 1);
    let pending = event();
    let before = BRIDGE.with_borrow(|bridge| {
        let core = bridge.core.as_ref().unwrap();
        let state = unsafe { &*core.state.get() };
        (core.context.clone(), state.x87)
    });
    assert_eq!(core_deliver_exception(), DATA);
    assert_eq!(event(), pending);
    assert_eq!(metadata(DATA)["address"], "0x41f0");
    BRIDGE.with_borrow(|bridge| {
        let core = bridge.core.as_ref().unwrap();
        let state = unsafe { &*core.state.get() };
        assert_eq!(core.context, before.0);
        assert!(core.image.owner_valid(1));
        assert_eq!(core.image.read(0x200d, 1).unwrap(), 0x9a);
        for address in [0x41f4, 0x41f8, 0x41fc] {
            assert_eq!(core.image.read(address, 4).unwrap(), 0xa5a5_a5a5);
        }
        assert_eq!(state.registers[4], 0x4200);
        assert_eq!(state.xmm, [[0x5a; 16]; 16]);
        assert_eq!(state.mxcsr, 0xffc5);
        assert_eq!(state.x87, before.1);
    });
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        let mut repaired = maps();
        let mut error = repaired[2].clone();
        error.base = 0x41f0;
        error.offset = 256;
        error.length = 4;
        repaired.push(error);
        core.image.set_mappings(repaired).unwrap();
    });
    assert_eq!(core_deliver_exception(), DISPATCH);
    assert_eq!(event(), EventState::Ready);
    assert_eq!(metadata(DATA), serde_json::Value::Null);
    BRIDGE.with_borrow(|bridge| {
        let core = bridge.core.as_ref().unwrap();
        let state = unsafe { &*core.state.get() };
        assert_eq!(
            (state.rip, state.registers[4], state.flags),
            (0x5000, 0x41f0, 2)
        );
        for (index, expected) in [0, 0x1000, 8, 0x10002].into_iter().enumerate() {
            assert_eq!(
                core.image.read(0x41f0 + index as u64 * 4, 4).unwrap(),
                expected
            );
        }
        assert_eq!(core.image.read(0x200d, 1).unwrap(), 0x9b);
        assert_eq!(state.x87, before.1);
        assert_eq!(state.xmm, [[0x5a; 16]; 16]);
    });
}
