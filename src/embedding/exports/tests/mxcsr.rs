use super::*;
use crate::embedding::layout::{GENERAL_PROTECTION, SIMD_EXCEPTION};

fn mxcsr() -> u32 {
    BRIDGE.with_borrow(|bridge| unsafe { (*bridge.core.as_ref().unwrap().state.get()).mxcsr })
}

#[test]
fn mxcsr_imports_validate_four_bytes_and_preserve_unrelated_state() {
    initialize(0x1000, &[0xf4]);
    assert_eq!(mxcsr(), 0x1f80);
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        unsafe {
            let state = &mut *core.state.get();
            state.xmm = [[0xa5; 16]; 16];
            state.registers = [0x1122334455667788; 16];
            state.flags = 0xcd7;
            state.remaining = 19;
            state.repeat_remaining = 23;
        }
        bridge.input = 0xffffu32.to_le_bytes().to_vec();
    });
    assert_eq!(numeric::core_import_mxcsr(), 0);
    assert_eq!(mxcsr(), 0xffff);
    BRIDGE.with_borrow(|bridge| unsafe {
        let state = &*bridge.core.as_ref().unwrap().state.get();
        assert_eq!(state.xmm, [[0xa5; 16]; 16]);
        assert_eq!(state.registers, [0x1122334455667788; 16]);
        assert_eq!(state.flags, 0xcd7);
        assert_eq!(state.rip, 0x1000);
        assert_eq!(state.remaining, 19);
        assert_eq!(state.repeat_remaining, 23);
    });
    for bytes in [vec![0; 3], vec![0; 5], 0x10000u32.to_le_bytes().to_vec()] {
        BRIDGE.with_borrow_mut(|bridge| bridge.input = bytes);
        assert_eq!(numeric::core_import_mxcsr(), 1);
        assert_eq!(mxcsr(), 0xffff);
    }
    core_clear_fault();
    assert_eq!(mxcsr(), 0xffff);
    BRIDGE.with_borrow_mut(|bridge| {
        bridge.input = vec![0; SCALAR_STATE_SIZE];
        bridge.input[128] = 2;
    });
    assert_eq!(core_import_state(), 0);
    assert_eq!(mxcsr(), 0xffff);
    BRIDGE.with_borrow_mut(|bridge| bridge.input = vec![0; 256]);
    assert_eq!(vector::core_import_xmm(), 0);
    assert_eq!(mxcsr(), 0xffff);
}

#[test]
fn guest_mxcsr_load_orders_full_source_before_reserved_payload_and_clears_owned_diagnostics() {
    initialize(0x1000, &[0xf4]);
    BRIDGE.with_borrow_mut(|bridge| {
        bridge
            .core
            .as_mut()
            .unwrap()
            .image
            .write_bytes(0x4000, &0x80000000u32.to_le_bytes())
            .unwrap();
    });
    assert_eq!(
        numeric::core_load_mxcsr(0x4000, Segment::Fs as u32),
        GENERAL_PROTECTION
    );
    assert_eq!(mxcsr(), 0x1f80);
    assert_eq!(
        metadata(GENERAL_PROTECTION),
        serde_json::json!({"vector":13,"errorCode":0,"cause":"mxcsr-reserved-bits","loadedValue":0x80000000u32})
    );
    assert_eq!(metadata(SIMD_EXCEPTION), serde_json::Value::Null);
    assert_eq!(numeric::core_load_mxcsr(0x400f, Segment::Ds as u32), DATA);
    assert_eq!(metadata(DATA)["width"], 4);
    assert_eq!(metadata(DATA)["failingAddress"], "0x4010");
    assert_eq!(metadata(GENERAL_PROTECTION), serde_json::Value::Null);
    assert_eq!(mxcsr(), 0x1f80);
    BRIDGE.with_borrow_mut(|bridge| {
        bridge
            .core
            .as_mut()
            .unwrap()
            .image
            .write_bytes(0x4001, &0x0fa0u32.to_le_bytes())
            .unwrap()
    });
    assert_eq!(numeric::core_load_mxcsr(0x4001, Segment::Ds as u32), 0);
    assert_eq!(mxcsr(), 0x0fa0);
    assert_eq!(metadata(DATA), serde_json::Value::Null);
    assert_eq!(metadata(GENERAL_PROTECTION), serde_json::Value::Null);
    assert_eq!(numeric::core_store_mxcsr(0x4007, Segment::Ds as u32), 1);
    BRIDGE.with_borrow(|bridge| {
        assert_eq!(
            bridge
                .core
                .as_ref()
                .unwrap()
                .image
                .read_bytes(0x4006, 6)
                .unwrap(),
            [0xa5, 0xa0, 0x0f, 0, 0, 0xa5]
        )
    });
    assert_eq!(mxcsr(), 0x0fa0);
}
