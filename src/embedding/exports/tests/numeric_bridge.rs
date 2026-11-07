use super::*;
use crate::embedding::layout::{GENERAL_PROTECTION, SIMD_EXCEPTION};
use crate::x86::float::{Format, Kind, Op};

fn operation(kind: Kind, scalar: bool) -> u32 {
    Op {
        kind,
        format: Format::F32,
        scalar,
        integer64: false,
        predicate: 0,
    }
    .encode()
}
fn invoke(operation: u32, left: u128, right: u128) -> i32 {
    numeric::core_float(
        operation,
        left as u64,
        (left >> 64) as u64,
        right as u64,
        (right >> 64) as u64,
    )
}
fn state() -> (u32, u128) {
    BRIDGE.with_borrow(|bridge| unsafe {
        let state = &*bridge.core.as_ref().unwrap().state.get();
        (state.mxcsr, u128::from_le_bytes(state.vector_scratch))
    })
}

#[test]
fn numeric_bridge_uses_captured_operands_and_publishes_status_without_canonical_register_writes() {
    initialize(0x1000, &[0xf4]);
    BRIDGE.with_borrow_mut(|bridge| unsafe {
        let state = &mut *bridge.core.as_mut().unwrap().state.get();
        state.xmm = [[0xa5; 16]; 16];
        state.registers = [0x9988776655443322; 16];
        state.flags = 0xcd7;
        state.remaining = 17;
        state.repeat_remaining = 19;
    });
    let left = 0x112233445566778899aabbcc3f800000u128;
    assert_eq!(invoke(operation(Kind::Add, true), left, 0x33800000), 0);
    assert_eq!(state(), (0x1fa0, left));
    BRIDGE.with_borrow(|bridge| unsafe {
        let state = &*bridge.core.as_ref().unwrap().state.get();
        assert_eq!(state.xmm, [[0xa5; 16]; 16]);
        assert_eq!(state.registers, [0x9988776655443322; 16]);
        assert_eq!(state.flags, 0xcd7);
        assert_eq!(state.rip, 0x1000);
        assert_eq!(state.remaining, 17);
        assert_eq!(state.repeat_remaining, 19);
    });
    assert_eq!(metadata(SIMD_EXCEPTION), serde_json::Value::Null);
}

#[test]
fn numeric_bridge_preserves_re_raised_sticky_flags_and_records_both_computation_phases() {
    initialize(0x1000, &[0xf4]);
    let left = 0x112233445566778899aabbcc3f800000u128;
    BRIDGE.with_borrow_mut(|bridge| unsafe {
        (*bridge.core.as_mut().unwrap().state.get()).mxcsr = 0x0fa0
    });
    assert_eq!(
        invoke(operation(Kind::Add, true), left, 0x33800000),
        SIMD_EXCEPTION
    );
    assert_eq!(state(), (0x0fa0, left));
    let post = metadata(SIMD_EXCEPTION);
    assert_eq!(
        post,
        serde_json::json!({"vector":19,"stage":"post-computation","raised":0x20,"unmasked":0x20,"mxcsrBefore":0x0fa0,"mxcsrAfter":0x0fa0})
    );
    assert_eq!(invoke(operation(Kind::Add, true), left, 0), 0);
    assert_eq!(metadata(SIMD_EXCEPTION), serde_json::Value::Null);
    assert_eq!(state(), (0x0fa0, left));
    let a = 0x3f8000007f7fffff3f80000000000000u128;
    let b = 0x404000003f0000000000000000000000u128;
    BRIDGE.with_borrow_mut(|bridge| unsafe {
        (*bridge.core.as_mut().unwrap().state.get()).mxcsr = 0x1f00
    });
    assert_eq!(invoke(operation(Kind::Div, false), a, b), SIMD_EXCEPTION);
    assert_eq!(state(), (0x1f05, a));
    assert_eq!(
        metadata(SIMD_EXCEPTION),
        serde_json::json!({"vector":19,"stage":"pre-computation","raised":5,"unmasked":1,"mxcsrBefore":0x1f00,"mxcsrAfter":0x1f05})
    );
    assert_eq!(post["stage"], "post-computation");
}

#[test]
fn numeric_diagnostics_clear_independently_of_accrued_status_on_all_architectural_imports() {
    initialize(0x1000, &[0xf4]);
    for projection in ["scalar", "xmm", "mxcsr", "clear", "context"] {
        BRIDGE.with_borrow_mut(|bridge| unsafe {
            (*bridge.core.as_mut().unwrap().state.get()).mxcsr = 0x0f80
        });
        assert_eq!(
            invoke(operation(Kind::Add, true), 0x3f800000, 0x33800000),
            SIMD_EXCEPTION
        );
        assert_eq!(state().0, 0x0fa0);
        match projection {
            "scalar" => {
                BRIDGE.with_borrow_mut(|bridge| {
                    bridge.input = vec![0; SCALAR_STATE_SIZE];
                    bridge.input[128] = 2;
                });
                assert_eq!(core_import_state(), 0);
            }
            "xmm" => {
                BRIDGE.with_borrow_mut(|bridge| bridge.input = vec![0; 256]);
                assert_eq!(vector::core_import_xmm(), 0);
            }
            "mxcsr" => {
                BRIDGE.with_borrow_mut(|bridge| bridge.input = 0x0fa0u32.to_le_bytes().to_vec());
                assert_eq!(numeric::core_import_mxcsr(), 0);
            }
            "clear" => core_clear_fault(),
            "context" => {
                BRIDGE.with_borrow_mut(|bridge| {
                    bridge.input = serde_json::to_vec(
                        &serde_json::json!({"mode":"long64","fsBase":"0x10000","gsBase":"0x0"}),
                    )
                    .unwrap()
                });
                assert_eq!(context::core_set_context(), 0);
            }
            _ => unreachable!(),
        }
        assert_eq!(metadata(SIMD_EXCEPTION), serde_json::Value::Null);
        assert_eq!(metadata(GENERAL_PROTECTION), serde_json::Value::Null);
        assert_eq!(state().0, 0x0fa0);
    }
    BRIDGE.with_borrow_mut(|bridge| unsafe {
        (*bridge.core.as_mut().unwrap().state.get()).mxcsr = 0x0f80
    });
    assert_eq!(
        invoke(operation(Kind::Add, true), 0x3f800000, 0x33800000),
        SIMD_EXCEPTION
    );
    let previous = metadata(SIMD_EXCEPTION);
    BRIDGE.with_borrow_mut(|bridge| bridge.input = 0x10000u32.to_le_bytes().to_vec());
    assert_eq!(numeric::core_import_mxcsr(), 1);
    assert_eq!(metadata(SIMD_EXCEPTION), previous);
    assert_eq!(state().0, 0x0fa0);
}
