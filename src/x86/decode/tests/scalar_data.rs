use super::{at, missing};
use crate::x86::decode::DecodeError;

#[test]
fn scalar_data_admission_covers_narrow_registers_and_complete_move_encodings() {
    for bytes in [
        &[0xb4, 0x80][..],
        &[0x66, 0xb8, 0, 0x80][..],
        &[0x88, 0xe0][..],
        &[0x48, 0xc7, 0xc0, 0, 0, 0, 0x80][..],
        &[0x66, 0x8d, 0x40, 1][..],
    ] {
        let decoded = at(0x1000, bytes);
        assert!(decoded.is_ok(), "{bytes:02x?}: {decoded:?}");
        assert_eq!(decoded.unwrap().next_pc, 0x1000 + bytes.len() as u64);
    }
}

#[test]
fn scalar_two_byte_map_fetches_a_required_opcode_after_rex() {
    assert_eq!(
        at(0x1000, &[0x48, 0x0f]),
        Err(DecodeError::Fetch(missing(0x1002)))
    );
}
