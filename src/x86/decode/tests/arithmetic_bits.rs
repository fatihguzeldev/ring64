use super::{DecodeError, at, missing};

#[test]
fn carry_arithmetic_is_admitted_and_requires_its_operand_bytes() {
    for bytes in [&[0x10, 0xc8][..], &[0x18, 0xc8][..]] {
        assert!(at(0x1000, bytes).is_ok(), "{bytes:02x?}");
    }
    for bytes in [
        &[0x48, 0x80, 0x14][..],
        &[0x66, 0x81, 0x1c][..],
        &[0x83, 0x1c][..],
        &[0x11][..],
        &[0x66, 0x1d, 0xff][..],
    ] {
        assert_eq!(
            at(0x1000, bytes),
            Err(DecodeError::Fetch(missing(0x1000 + bytes.len() as u64)))
        );
    }
}
