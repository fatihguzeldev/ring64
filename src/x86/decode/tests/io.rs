use super::*;
use crate::x86::instruction::{Repeat, StringKind};

#[test]
fn io_widths_ignore_rex_w_before_operand_override_and_never_have_modrm() {
    for (bytes, input, port, width) in [
        (&[0xe4, 0x80][..], true, Some(0x80), Width::W8),
        (&[0xe7, 0xff][..], false, Some(0xff), Width::W32),
        (&[0xec][..], true, None, Width::W8),
        (&[0xef][..], false, None, Width::W32),
        (&[0x48, 0xed][..], true, None, Width::W32),
        (&[0x66, 0x48, 0xed][..], true, None, Width::W16),
        (&[0x66, 0x48, 0xef][..], false, None, Width::W16),
    ] {
        let instruction = at(0x1000, bytes).unwrap();
        assert_eq!(instruction.operation, Operation::Io { input, port, width });
        assert_eq!(instruction.next_pc, 0x1000 + bytes.len() as u64);
    }
    assert!(matches!(
        at(0x1000, &[0x66, 0x48, 0xf3, 0x6d]).unwrap().operation,
        Operation::String {
            kind: StringKind::Ins,
            width: Width::W16,
            repeat: Repeat::Count,
            ..
        }
    ));
    assert!(matches!(
        at(0x1000, &[0x6f]).unwrap().operation,
        Operation::String {
            kind: StringKind::Outs,
            width: Width::W32,
            repeat: Repeat::None,
            ..
        }
    ));
}

#[test]
fn io_lock_fetches_required_immediate_while_repeat_rejects_at_frontier() {
    assert!(matches!(
        at(0x1000, &[0xf0, 0xe4]),
        Err(DecodeError::Fetch(_))
    ));
    assert_eq!(
        at(0x1000, &[0xf0, 0xe4, 0x80]),
        Err(DecodeError::UndefinedEncoding)
    );
    for bytes in [&[0xf0, 0x6c][..], &[0xf0, 0xed][..]] {
        assert_eq!(at(0x1000, bytes), Err(DecodeError::UndefinedEncoding));
    }
    for bytes in [
        &[0xf2, 0x6c][..],
        &[0xf3, 0xe4][..],
        &[0xf3, 0xef][..],
        &[0xf0, 0xf3, 0x6c][..],
    ] {
        assert_eq!(at(0x1000, bytes), Err(DecodeError::Unsupported));
    }
}
