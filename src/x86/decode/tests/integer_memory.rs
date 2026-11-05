use super::{at, missing, operation};
use crate::memory::{Access, Cause, Fault};
use crate::x86::decode::{self, DecodeError};
use crate::x86::instruction::{
    Address, AddressBase, Alu, MemoryAluOperands, Operand, Operation, Width,
};

use Alu::{Add, And, Cmp, Or, Sub, Test, Xor};
use MemoryAluOperands::{MemoryFirst, RegisterFirst};
use Operand::Register;
use Width::{W32, W64};

fn alu(kind: Alu, address: Address, operands: MemoryAluOperands, width: Width) -> Operation {
    Operation::MemoryAlu {
        kind,
        address,
        operands,
        width,
    }
}

#[test]
fn memory_integer_opcode_directions_keep_the_first_read_operand() {
    for (opcode, kind, operands) in [
        (0x01, Add, MemoryFirst(Register(1))),
        (0x03, Add, RegisterFirst(1)),
        (0x29, Sub, MemoryFirst(Register(1))),
        (0x2b, Sub, RegisterFirst(1)),
        (0x39, Cmp, MemoryFirst(Register(1))),
        (0x3b, Cmp, RegisterFirst(1)),
        (0x21, And, MemoryFirst(Register(1))),
        (0x23, And, RegisterFirst(1)),
        (0x09, Or, MemoryFirst(Register(1))),
        (0x0b, Or, RegisterFirst(1)),
        (0x31, Xor, MemoryFirst(Register(1))),
        (0x33, Xor, RegisterFirst(1)),
        (0x85, Test, MemoryFirst(Register(1))),
    ] {
        let address = Address {
            base: AddressBase::Register(3),
            index: None,
            displacement: 0,
        };
        for (prefix, width) in [(None, W32), (Some(0x40), W32), (Some(0x48), W64)] {
            let mut bytes: Vec<_> = prefix.into_iter().collect();
            bytes.extend([opcode, 0x0b]);
            assert_eq!(operation(&bytes), alu(kind, address, operands, width));
        }
    }
}

#[test]
fn admitted_memory_integer_forms_fetch_each_required_address_and_immediate_byte() {
    for bytes in [
        &[0x01, 0x04, 0x24][..],
        &[0x29, 0x04, 0x24][..],
        &[0x39, 0x04, 0x24][..],
        &[0x83, 0x04, 0x24, 1][..],
        &[0x03, 0x03][..],
        &[0x4f, 0x2b, 0x84, 0xa5, 0, 0, 0, 0x80][..],
        &[0x48, 0x83, 0x3d, 0, 0, 0, 0, 1][..],
        &[0x48, 0x81, 0x3d, 0, 0, 0, 0, 1, 0, 0, 0][..],
        &[
            0x4f, 0xf7, 0x84, 0xa5, 0, 0, 0, 0x80, 0xff, 0xff, 0xff, 0xff,
        ][..],
    ] {
        for length in 0..bytes.len() {
            assert_eq!(
                at(0x1000, &bytes[..length]),
                Err(DecodeError::Fetch(missing(0x1000 + length as u64))),
                "{bytes:02x?} truncated to {length}"
            );
        }
        for length in 1..bytes.len() {
            let pc = u64::MAX - length as u64 + 1;
            assert_eq!(
                at(pc, &bytes[..length]),
                Err(DecodeError::Fetch(Fault {
                    address: pc,
                    width: length as u32 + 1,
                    access: Access::Execute,
                    cause: Cause::AddressRange,
                    failing: 1u128 << 64,
                })),
                "{bytes:02x?} truncated to {length} at {pc:x}"
            );
        }
    }
}

#[test]
fn unsupported_integer_memory_selectors_stop_before_address_tails() {
    for (opcode, selectors) in [
        (0x81, &[2, 3][..]),
        (0x83, &[2, 3]),
        (0xf7, &[1, 2, 3, 4, 5, 6, 7]),
    ] {
        for selector in selectors {
            for mode in 0..4 {
                let bytes = [0x4f, opcode, (mode << 6) | (selector << 3) | 4];
                let pc = u64::MAX - 2;
                let mut reads = Vec::new();
                let decoded = decode::decode(pc, |address| {
                    reads.push(address);
                    address
                        .checked_sub(pc)
                        .and_then(|offset| bytes.get(offset as usize))
                        .copied()
                        .ok_or_else(|| missing(address))
                });
                assert_eq!(decoded, Err(DecodeError::Unsupported), "{bytes:02x?}");
                assert_eq!(reads, vec![pc, pc + 1, pc + 2]);
            }
        }
    }
}
