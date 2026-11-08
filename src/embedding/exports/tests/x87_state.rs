use super::*;
use crate::embedding::exports::x87_state::core_import_x87;
use crate::embedding::layout::X87_EXCEPTION;

fn input() -> Vec<u8> {
    let mut bytes: Vec<u8> = (0..104).collect();
    bytes[80..82].copy_from_slice(&0x37bu16.to_le_bytes());
    bytes[82..84].copy_from_slice(&0xa884u16.to_le_bytes());
    bytes[84..86].copy_from_slice(&0xffffu16.to_le_bytes());
    bytes[86..88].copy_from_slice(&0x7ffu16.to_le_bytes());
    bytes
}

fn snapshot() -> crate::x86::x87::State {
    BRIDGE.with_borrow(|bridge| unsafe { (*bridge.core.as_ref().unwrap().state.get()).x87 })
}

#[test]
fn raw_x87_import_preserves_physical_payloads_and_pending_across_other_projections() {
    initialize(0x1000, &[0x90]);
    let bytes = input();
    BRIDGE.with_borrow_mut(|bridge| bridge.input = bytes.clone());
    assert_eq!(core_import_x87(), 0);
    let before = snapshot();
    assert_eq!(before.registers[7], std::array::from_fn(|i| (70 + i) as u8));
    assert_eq!(before.tag_word, 0xffff);
    assert_eq!(before.pending(), 4);
    assert_eq!(
        before.instruction_pointer,
        u64::from_le_bytes(bytes[88..96].try_into().unwrap())
    );
    core_clear_fault();
    BRIDGE.with_borrow_mut(|bridge| {
        bridge.input = vec![0; SCALAR_STATE_SIZE];
        bridge.input[128] = 2;
    });
    assert_eq!(core_import_state(), 0);
    BRIDGE.with_borrow_mut(|bridge| bridge.input = vec![0xa5; 256]);
    assert_eq!(vector::core_import_xmm(), 0);
    BRIDGE.with_borrow_mut(|bridge| bridge.input = 0x1f80u32.to_le_bytes().to_vec());
    assert_eq!(numeric::core_import_mxcsr(), 0);
    assert_eq!(snapshot(), before);
    let record = metadata(X87_EXCEPTION);
    assert_eq!(record["pending"], 4);
    assert_eq!(record["statusWord"], 0xa884);
    assert_eq!(record["opcode"], 0x7ff);
    assert_eq!(metadata(DATA), serde_json::Value::Null);
}

#[test]
fn rejected_x87_import_changes_no_state_or_existing_guest_diagnostics() {
    initialize(0x1000, &[0x90]);
    BRIDGE.with_borrow_mut(|bridge| bridge.input = input());
    assert_eq!(core_import_x87(), 0);
    assert_eq!(core_load(0x7000, 4), 0);
    let fault = metadata(DATA);
    let before = snapshot();
    let mut bad = input();
    bad[87] = 8;
    let mut inconsistent = input();
    inconsistent[83] &= !0x80;
    for bytes in [vec![], vec![0; 103], vec![0; 105], bad, inconsistent] {
        BRIDGE.with_borrow_mut(|bridge| bridge.input = bytes);
        assert_eq!(core_import_x87(), 1);
        assert_eq!(snapshot(), before);
        assert_eq!(metadata(DATA), fault);
    }
    BRIDGE.with_borrow_mut(|bridge| bridge.input = input());
    assert_eq!(core_import_x87(), 0);
    assert_eq!(metadata(DATA), serde_json::Value::Null);
}
