use super::*;
use crate::x86::context::{ExecutionContext, Mode, Segment};
use crate::x86::processor::Instruction as Processor;

fn context(mode: Mode, code32: bool) -> ExecutionContext {
    let mut context = ExecutionContext::default();
    context.set_mode_and_cpl(mode, if mode == Mode::Virtual8086 { 3 } else { 0 });
    let mut cs = context.segment(Segment::Cs);
    cs.default32 = code32;
    context.set_segment(
        Segment::Cs,
        context.selector(Segment::Cs),
        cs,
        context.attributes(Segment::Cs),
    );
    context
}

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
fn processor_selected_opcodes_cross_all_inherited_code_profiles() {
    for mode in [
        Mode::Real,
        Mode::Protected,
        Mode::Virtual8086,
        Mode::Compatibility,
        Mode::Long64,
    ] {
        for code32 in [false, true] {
            if (mode == Mode::Virtual8086 || mode == Mode::Long64) && code32 {
                continue;
            }
            for paged in [false, true] {
                for bytes in [&[0x0f, 0xa2][..], &[0x0f, 0x31], &[0x0f, 0x01, 0xf9]] {
                    let result = decoded(bytes, paged, &context(mode, code32));
                    assert!(
                        result.is_ok(),
                        "{mode:?}/{code32}/{paged}: {bytes:x?}: {result:?}"
                    );
                    assert_eq!(result.unwrap().encoded_len(), bytes.len() as u32);
                }
            }
        }
    }
}

#[test]
fn processor_prefixes_ignore_width_address_repeat_and_raw_rex_fields() {
    for (opcode, expected) in [
        (&[0x0f, 0xa2][..], Processor::Cpuid),
        (&[0x0f, 0x31][..], Processor::Rdtsc),
        (&[0x0f, 0x01, 0xf9][..], Processor::Rdtscp),
    ] {
        for prefix in [
            &[0x66, 0x67, 0x64][..],
            &[0x66, 0x66, 0x67, 0x67],
            &[0xf3],
            &[0xf2],
            &[0xf3, 0xf3],
            &[0xf2, 0xf3],
            &[0xf3, 0xf2],
            &[0x48, 0x66, 0x4f],
            &[0x4f, 0x66, 0xf3],
        ] {
            let mut bytes = prefix.to_vec();
            bytes.extend_from_slice(opcode);
            for paged in [false, true] {
                let instruction = decoded(&bytes, paged, &ExecutionContext::default()).unwrap();
                assert_eq!(instruction.operation, Operation::Processor(expected));
                assert_eq!(instruction.encoded_len(), bytes.len() as u32);
            }
        }
        for rex in 0x40..=0x4f {
            let mut bytes = vec![rex];
            bytes.extend_from_slice(opcode);
            assert_eq!(operation(&bytes), Operation::Processor(expected));
        }
    }
}

#[test]
fn processor_lock_and_required_bytes_have_distinct_frontiers() {
    for opcode in [&[0x0f, 0xa2][..], &[0x0f, 0x31], &[0x0f, 0x01, 0xf9]] {
        for paged in [false, true] {
            let mut locked = vec![0xf0];
            locked.extend_from_slice(opcode);
            assert_eq!(
                decoded(&locked, paged, &ExecutionContext::default()),
                Err(DecodeError::UndefinedEncoding)
            );
            for end in 0..locked.len() {
                assert!(matches!(
                    decoded(&locked[..end], paged, &ExecutionContext::default()),
                    Err(DecodeError::Fetch(_))
                ));
            }
            for prefix in [&[0xf0, 0xf0][..], &[0xf0, 0xf3], &[0xf2, 0xf0]] {
                let mut bytes = prefix.to_vec();
                bytes.extend_from_slice(opcode);
                assert_eq!(
                    decoded(&bytes, paged, &ExecutionContext::default()),
                    Err(DecodeError::Unsupported)
                );
            }
        }
        let mut fifteen = vec![0x66; 15 - opcode.len()];
        fifteen.extend_from_slice(opcode);
        assert_eq!(at(0x1000, &fifteen).unwrap().encoded_len(), 15);
        fifteen.insert(0, 0x66);
        assert_eq!(at(0x1000, &fifteen), Err(DecodeError::InstructionLength));
    }
}

#[test]
fn rdtscp_does_not_widen_swapgs_invlpg_or_unselected_register_neighbors() {
    let context = ExecutionContext::default();
    assert_eq!(
        decoded(&[0x0f, 0x01, 0xf8], true, &context)
            .unwrap()
            .operation,
        Operation::FastSystem(crate::x86::fast_system::Instruction::Swapgs)
    );
    assert_eq!(
        decoded(&[0x0f, 0x01, 0xf8], false, &context),
        Err(DecodeError::Unsupported)
    );
    for neighbor in 0xfa..=0xff {
        assert_eq!(
            decoded(&[0x0f, 0x01, neighbor], true, &context),
            Err(DecodeError::Invalid)
        );
        assert_eq!(
            decoded(&[0x0f, 0x01, neighbor], false, &context),
            Err(DecodeError::Unsupported)
        );
    }
    assert!(matches!(
        decoded(&[0x0f, 0x01, 0x39], true, &context)
            .unwrap()
            .operation,
        Operation::Paging(crate::x86::instruction::PagingInstruction::InvalidatePage(
            _
        ))
    ));
    assert!(matches!(
        decoded(&[0x0f, 0x01, 0x7c], true, &context),
        Err(DecodeError::Fetch(_))
    ));
    assert_eq!(
        decoded(&[0x0f, 0x01, 0x7c], false, &context),
        Err(DecodeError::Unsupported)
    );
}

#[test]
fn rex_bytes_remain_separate_legacy_increment_or_decrement_instructions() {
    for mode in [
        Mode::Real,
        Mode::Protected,
        Mode::Virtual8086,
        Mode::Compatibility,
    ] {
        for code32 in [false, true] {
            if mode == Mode::Virtual8086 && code32 {
                continue;
            }
            for rex in 0x40..=0x4f {
                for opcode in [&[0x0f, 0xa2][..], &[0x0f, 0x31], &[0x0f, 0x01, 0xf9]] {
                    let mut bytes = vec![rex];
                    bytes.extend_from_slice(opcode);
                    let instruction = decoded(&bytes, false, &context(mode, code32)).unwrap();
                    assert_eq!(instruction.encoded_len(), 1);
                    assert!(matches!(instruction.operation, Operation::Unary { .. }));
                }
            }
        }
    }
}
