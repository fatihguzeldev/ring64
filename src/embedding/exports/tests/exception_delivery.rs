use super::*;

fn pending_input() -> Vec<u8> {
    let mut input = vec![0; SCALAR_STATE_SIZE + 40];
    input[128..136].copy_from_slice(&2_u64.to_le_bytes());
    input[136..144].copy_from_slice(&0x1000_u64.to_le_bytes());
    let event = &mut input[SCALAR_STATE_SIZE..];
    event[..4].copy_from_slice(&1_u32.to_le_bytes());
    event[8..16].copy_from_slice(&0x1000_u64.to_le_bytes());
    event[16..24].copy_from_slice(&0x1000_u64.to_le_bytes());
    event[24..32].copy_from_slice(&0x10002_u64.to_le_bytes());
    input
}

#[test]
fn scalar_import_accepts_a_complete_pending_exception_checkpoint() {
    initialize(0x1000, &[0xf7, 0xf1]);
    BRIDGE.with_borrow_mut(|bridge| bridge.input = pending_input());
    assert_eq!(core_import_state(), 0);
}

#[test]
fn rejected_pending_checkpoint_does_not_publish_scalar_state() {
    initialize(0x1000, &[0xf7, 0xf1]);
    BRIDGE.with_borrow_mut(|bridge| {
        bridge.input = pending_input();
        // Saved CF disagrees with the captured live scalar FLAGS.
        bridge.input[SCALAR_STATE_SIZE + 24..SCALAR_STATE_SIZE + 32]
            .copy_from_slice(&0x10003_u64.to_le_bytes());
        bridge.input[..8].copy_from_slice(&99_u64.to_le_bytes());
    });
    assert_eq!(core_import_state(), 1);
    BRIDGE.with_borrow(|bridge| {
        let state = unsafe { &*bridge.core.as_ref().unwrap().state.get() };
        assert_eq!(state.registers[0], 0);
        assert_eq!(state.rip, 0x1000);
    });
}
