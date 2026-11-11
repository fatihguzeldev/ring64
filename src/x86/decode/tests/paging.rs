use super::*;
use crate::memory::{Access, Cause};
use crate::x86::context::Mode;
use crate::x86::instruction::{
    Address, AddressBase, Operation, PagingInstruction as Paging, Width,
};

fn decoded(
    bytes: &[u8],
    paged: bool,
    context: &ExecutionContext,
) -> Result<Instruction, DecodeError> {
    decode_with_profile(0x1000, context, paged, |address| {
        bytes
            .get((address - 0x1000) as usize)
            .copied()
            .ok_or_else(|| {
                DecodeError::Fetch(Fault {
                    address,
                    width: 1,
                    access: Access::Execute,
                    cause: Cause::Unmapped,
                    failing: u128::from(address),
                })
            })
    })
}

#[test]
fn paged_mov_cr_ignores_mod_tails_and_operand_width_prefixes() {
    let context = ExecutionContext::default();
    for (bytes, register, gpr, write) in [
        (&[0x0f, 0x20, 0x04][..], 0, 4, false),
        (&[0x66, 0x0f, 0x22, 0x58][..], 3, 0, true),
        (&[0x49, 0x0f, 0x20, 0xd7][..], 2, 15, false),
        (&[0x44, 0x0f, 0x22, 0xc0][..], 8, 0, true),
    ] {
        let instruction = decoded(bytes, true, &context).unwrap();
        assert_eq!(instruction.next_pc, 0x1000 + bytes.len() as u64);
        assert_eq!(
            instruction.operation,
            Operation::Paging(Paging::ControlRegister {
                register,
                gpr,
                write,
                width: Width::W64
            })
        );
    }
    let mut compat = context;
    compat.set_mode_and_cpl(Mode::Compatibility, 0);
    assert_eq!(
        decoded(&[0x66, 0x0f, 0x20, 0xc0], true, &compat)
            .unwrap()
            .operation,
        Operation::Paging(Paging::ControlRegister {
            register: 0,
            gpr: 0,
            write: false,
            width: Width::W32
        })
    );
}

#[test]
fn paged_control_legality_and_required_bytes_do_not_change_linear_frontiers() {
    let context = ExecutionContext::default();
    for bytes in [
        &[0x0f, 0x20][..],
        &[0x0f, 0x22][..],
        &[0x0f, 0x01, 0x3c][..],
    ] {
        assert_eq!(
            decoded(bytes, false, &context),
            Err(DecodeError::Unsupported)
        );
        assert!(matches!(
            decoded(bytes, true, &context),
            Err(DecodeError::Fetch(_))
        ));
    }
    for bytes in [
        &[0x0f, 0x20, 0xc8][..],
        &[0x0f, 0x22, 0xe8],
        &[0x44, 0x0f, 0x20, 0xd0],
        &[0xf0, 0x0f, 0x20, 0xc0],
        &[0xf0, 0x0f, 0x32],
        &[0x0f, 0x01, 0xff],
    ] {
        assert_eq!(
            decoded(bytes, true, &context),
            Err(DecodeError::Invalid),
            "{bytes:x?}"
        );
    }
    for bytes in [&[0xf3, 0x0f, 0x20][..], &[0xf2, 0x0f, 0x32][..]] {
        assert_eq!(
            decoded(bytes, true, &context),
            Err(DecodeError::Unsupported)
        );
    }
}

#[test]
fn paged_msr_and_invlpg_operands_are_literal_instruction_records() {
    let context = ExecutionContext::default();
    assert_eq!(
        decoded(&[0x0f, 0x32], true, &context).unwrap().operation,
        Operation::Paging(Paging::ModelSpecificRegister { write: false })
    );
    assert_eq!(
        decoded(&[0x0f, 0x30], true, &context).unwrap().operation,
        Operation::Paging(Paging::ModelSpecificRegister { write: true })
    );
    let bytes = [0x64, 0x67, 0x0f, 0x01, 0xbd, 0x00, 0x10, 0x00, 0x00];
    assert_eq!(
        decoded(&bytes, true, &context).unwrap().operation,
        Operation::Paging(Paging::InvalidatePage(Address {
            base: AddressBase::Register(5),
            index: None,
            displacement: 0x1000,
            size: Width::W32,
            segment: crate::x86::context::Segment::Fs
        }))
    );
    for bytes in [&[0x0f, 0x32][..], &[0x0f, 0x30][..], &bytes[..]] {
        assert_eq!(
            decoded(bytes, false, &context),
            Err(DecodeError::Unsupported)
        );
    }
}
