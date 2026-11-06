use super::*;
use crate::embedding::layout::{BUDGET, DATA, DISPATCH, DIVIDE_ERROR, STOP};

fn initialize(code_base: u64, code: &[u8]) {
    BRIDGE.with_borrow_mut(|bridge| {
        *bridge = Bridge::default();
        bridge.input.extend_from_slice(code);
        bridge.input.extend_from_slice(&[0xa5; 16]);
    });
    assert_eq!(core_init(code_base, code.len() as u32, 0x4000, 16), 0);
}

fn metadata(reason: i32) -> serde_json::Value {
    core_fault_info(reason);
    BRIDGE.with_borrow(|bridge| serde_json::from_slice(&bridge.info).unwrap())
}

#[test]
fn memory_fault_metadata_only_belongs_to_data_and_fetch_exits() {
    initialize(0x1000, &[0xb8, 1, 0, 0, 0]);
    assert_eq!(core_load(0x7000, 8), 0);
    let data = serde_json::json!({
        "address": "0x7000", "width": 8, "access": "read",
        "cause": "unmapped", "failingAddress": "0x7000",
    });
    assert_eq!(metadata(DATA), data);
    for reason in [
        DISPATCH,
        BUDGET,
        STOP,
        RESOURCE,
        UNSUPPORTED,
        INVALID,
        DIVIDE_ERROR,
    ] {
        assert_eq!(metadata(reason), serde_json::Value::Null, "reason {reason}");
    }
    assert_eq!(core_probe(0x7001), FETCH);
    assert_eq!(
        metadata(FETCH),
        serde_json::json!({
            "address": "0x7001", "width": 1, "access": "execute",
            "cause": "unmapped", "failingAddress": "0x7001",
        })
    );
}

#[test]
fn static_target_metadata_uses_the_execution_transport() {
    for code in [&[0xeb, 0x0e][..], &[0x75, 0x0e][..]] {
        initialize(0x7fff_ffff_fff0, code);
        assert_eq!(core_load(0x7000, 8), 0);
        BRIDGE.with_borrow_mut(|bridge| {
            // Metadata consumes execution transport, independently of bytes at RIP.
            unsafe { (*bridge.core.as_mut().unwrap().state.get()).target = 0x8000_0000_0008 };
        });
        assert_eq!(
            metadata(TARGET),
            serde_json::json!({
                "address": "0x800000000008", "width": 0, "access": "execute",
                "cause": "noncanonical", "failingAddress": "0x800000000008",
            })
        );
    }
}

#[test]
fn runtime_target_metadata_uses_each_executed_value() {
    for code in [&[0xc3][..], &[0xff, 0xd0][..], &[0xff, 0xe0][..]] {
        initialize(0x1000, code);
        assert_eq!(core_load(0x7000, 8), 0);
        for target in [0x8000_0000_0000, 0x8000_0000_0008] {
            BRIDGE.with_borrow_mut(|bridge| {
                // The generated invocation has returned before these exports run.
                unsafe { (*bridge.core.as_mut().unwrap().state.get()).target = target };
            });
            assert_eq!(
                metadata(TARGET),
                serde_json::json!({
                    "address": format!("0x{target:x}"), "width": 0, "access": "execute",
                    "cause": "noncanonical", "failingAddress": format!("0x{target:x}"),
                })
            );
        }
        for reason in [BUDGET, STOP, RESOURCE, UNSUPPORTED, INVALID, DIVIDE_ERROR] {
            assert_eq!(metadata(reason), serde_json::Value::Null);
        }
    }
}

#[test]
fn clearing_faults_resets_runtime_target_and_memory_failure() {
    initialize(0x1000, &[0xc3]);
    assert_eq!(core_load(0x7000, 8), 0);
    BRIDGE.with_borrow_mut(|bridge| {
        unsafe { (*bridge.core.as_mut().unwrap().state.get()).target = 0x8000_0000_0000 };
    });
    core_clear_fault();
    BRIDGE.with_borrow(|bridge| {
        let core = bridge.core.as_ref().unwrap();
        assert!(core.fault.is_none());
        assert_eq!(unsafe { (*core.state.get()).target }, 0);
    });
    assert_eq!(core_access_failed(), 0);
    assert_eq!(metadata(BUDGET), serde_json::Value::Null);
}

#[test]
fn importing_state_cannot_import_a_stale_runtime_target() {
    initialize(0x1000, &[0xc3]);
    assert_eq!(core_load(0x7000, 8), 0);
    BRIDGE.with_borrow_mut(|bridge| {
        unsafe { (*bridge.core.as_mut().unwrap().state.get()).target = 0x8000_0000_0000 };
        bridge.input = vec![0xff; size_of::<RunState>()];
        for index in 0..16 {
            let offset = std::mem::offset_of!(RunState, registers) + index * 8;
            bridge.input[offset..offset + 8].copy_from_slice(&(index as u64).to_le_bytes());
        }
        let flags = std::mem::offset_of!(RunState, flags);
        bridge.input[flags..flags + 8].copy_from_slice(&0x8d7_u64.to_le_bytes());
        let rip = std::mem::offset_of!(RunState, rip);
        bridge.input[rip..rip + 8].copy_from_slice(&0x1000_u64.to_le_bytes());
    });
    assert_eq!(core_import_state(), 0);
    BRIDGE.with_borrow(|bridge| {
        let core = bridge.core.as_ref().unwrap();
        assert!(core.fault.is_none());
        let state = unsafe { &*core.state.get() };
        assert_eq!(state.registers, std::array::from_fn(|i| i as u64));
        assert_eq!(state.flags, 0x8d7);
        assert_eq!(state.rip, 0x1000);
        assert_eq!(state.remaining, 0);
        assert_eq!(state.target, 0);
    });
    assert_eq!(metadata(STOP), serde_json::Value::Null);
}

#[test]
fn wide_arithmetic_failure_is_private_and_reset_by_each_division() {
    initialize(0x1000, &[0x90]);
    assert_eq!(core_divide_failed(), 0);
    assert_eq!(core_load(0x7000, 8), 0);
    assert_eq!(core_divide(2, 0, 2, 0), 0);
    assert_eq!(core_divide_failed(), 1);
    assert_eq!(metadata(DIVIDE_ERROR), serde_json::Value::Null);
    assert_eq!(metadata(DATA)["address"], "0x7000");
    assert_eq!(core_divide(1, 0, 2, 0), 1 << 63);
    assert_eq!(core_divide_failed(), 0);
    assert_eq!(core_divide(1 << 63, 0, u64::MAX, 1), 0);
    assert_eq!(core_divide_failed(), 1);
    core_clear_fault();
    assert_eq!(core_divide_failed(), 0);
    assert_eq!(core_access_failed(), 0);
    assert_eq!(core_multiply_high(u64::MAX, 2, 0), 1);
    assert_eq!(core_multiply_high(u64::MAX, 2, 1), u64::MAX);
}
