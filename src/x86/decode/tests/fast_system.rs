use super::*;
use crate::x86::context::{ExecutionContext, Mode};
use crate::x86::fast_system::Instruction as Fast;

fn decoded(
    bytes: &[u8],
    paged: bool,
    context: &ExecutionContext,
) -> Result<Instruction, DecodeError> {
    super::super::decode_with_profile(0x1000, context, paged, |pc| {
        bytes
            .get((pc - 0x1000) as usize)
            .copied()
            .ok_or(DecodeError::Fetch(missing(pc)))
    })
}

#[test]
fn fast_transfer_widths_ignore_redundant_prefixes_and_never_invent_a_word_return() {
    let context = ExecutionContext::default();
    for (bytes, expected) in [
        (&[0x0f, 0x05][..], Fast::Syscall),
        (&[0xf3, 0x66, 0x67, 0x65, 0x0f, 0x05][..], Fast::Syscall),
        (&[0x66, 0x0f, 0x07][..], Fast::Sysret { wide: false }),
        (
            &[0xf2, 0x66, 0x48, 0x0f, 0x07][..],
            Fast::Sysret { wide: true },
        ),
        (&[0x0f, 0x34][..], Fast::Sysenter),
        (&[0xf2, 0x66, 0x0f, 0x35][..], Fast::Sysexit { wide: false }),
        (&[0x66, 0x48, 0x0f, 0x35][..], Fast::Sysexit { wide: true }),
        (&[0x0f, 0x01, 0xf8][..], Fast::Swapgs),
        (&[0xf3, 0x66, 0x4f, 0x0f, 0x01, 0xf8][..], Fast::Swapgs),
    ] {
        let instruction = decoded(bytes, true, &context).unwrap();
        assert_eq!(instruction.operation, Operation::FastSystem(expected));
        assert_eq!(instruction.next_pc, 0x1000 + bytes.len() as u64);
        assert!(matches!(
            decoded(&bytes[..bytes.len() - 1], true, &context),
            Err(DecodeError::Fetch(_))
        ));
    }
}

#[test]
fn paged_fast_legality_does_not_change_linear_frontiers_or_legacy_rex_interpretation() {
    let mut context = ExecutionContext::default();
    for bytes in [
        &[0x0f, 0x05][..],
        &[0x0f, 0x07],
        &[0x0f, 0x34],
        &[0x0f, 0x35],
        &[0x0f, 0x01, 0xf8],
    ] {
        assert_eq!(
            decoded(bytes, false, &context),
            Err(DecodeError::Unsupported)
        );
        let mut locked = vec![0xf0];
        locked.extend_from_slice(bytes);
        assert_eq!(
            decoded(&locked, true, &context),
            Err(DecodeError::UndefinedEncoding)
        );
    }
    context.set_mode_and_cpl(Mode::Compatibility, 0);
    for bytes in [&[0x0f, 0x05][..], &[0x0f, 0x07], &[0x0f, 0x01, 0xf8]] {
        assert_eq!(
            decoded(bytes, true, &context),
            Err(DecodeError::UndefinedEncoding)
        );
    }
    assert_eq!(
        decoded(&[0x66, 0x0f, 0x35], true, &context)
            .unwrap()
            .operation,
        Operation::FastSystem(Fast::Sysexit { wide: false })
    );
    assert!(!matches!(
        decoded(&[0x48, 0x0f, 0x35], true, &context)
            .unwrap()
            .operation,
        Operation::FastSystem(_)
    ));
}
