use super::{at, missing, operation};
use crate::memory::{Access, Cause, Fault};
use crate::x86::decode::{self, DecodeError};
use crate::x86::instruction::{
    Address, AddressBase, AddressIndex, Alu, DataOperand as Operand, MemoryAluOperands, Operation,
    RegisterView, Width,
};

use Alu::{Add, And, Cmp, Or, Sub, Test, Xor};
use MemoryAluOperands::{MemoryFirst, RegisterFirst};
use Operand::{Immediate, Register};
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
        (0x01, Add, MemoryFirst(Register(RegisterView::low(1)))),
        (0x03, Add, RegisterFirst(RegisterView::low(1))),
        (0x29, Sub, MemoryFirst(Register(RegisterView::low(1)))),
        (0x2b, Sub, RegisterFirst(RegisterView::low(1))),
        (0x39, Cmp, MemoryFirst(Register(RegisterView::low(1)))),
        (0x3b, Cmp, RegisterFirst(RegisterView::low(1))),
        (0x21, And, MemoryFirst(Register(RegisterView::low(1)))),
        (0x23, And, RegisterFirst(RegisterView::low(1))),
        (0x09, Or, MemoryFirst(Register(RegisterView::low(1)))),
        (0x0b, Or, RegisterFirst(RegisterView::low(1))),
        (0x31, Xor, MemoryFirst(Register(RegisterView::low(1)))),
        (0x33, Xor, RegisterFirst(RegisterView::low(1))),
        (0x85, Test, MemoryFirst(Register(RegisterView::low(1)))),
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
fn memory_integer_register_fields_keep_all_banks_and_address_aliases() {
    for (opcode, kind, register_first) in [
        (0x01, Add, false),
        (0x03, Add, true),
        (0x29, Sub, false),
        (0x2b, Sub, true),
        (0x39, Cmp, false),
        (0x3b, Cmp, true),
        (0x21, And, false),
        (0x23, And, true),
        (0x09, Or, false),
        (0x0b, Or, true),
        (0x31, Xor, false),
        (0x33, Xor, true),
        (0x85, Test, false),
    ] {
        for (width, width_bit) in [(W32, 0), (W64, 8)] {
            for base in 0..16 {
                for register in [base, (base + 5) & 15] {
                    for ignored_x in if base & 7 == 4 { &[0][..] } else { &[0, 2] } {
                        let rex =
                            0x40 | width_bit | ((register >> 3) << 2) | (base >> 3) | ignored_x;
                        let mut bytes =
                            vec![rex, opcode, 0x40 | ((register & 7) << 3) | (base & 7)];
                        if base & 7 == 4 {
                            bytes.push(0x24);
                        }
                        bytes.push(0);
                        let operands = if register_first {
                            RegisterFirst(RegisterView::low(register))
                        } else {
                            MemoryFirst(Register(RegisterView::low(register)))
                        };
                        assert_eq!(
                            operation(&bytes),
                            alu(
                                kind,
                                Address {
                                    base: AddressBase::Register(base),
                                    index: None,
                                    displacement: 0,
                                },
                                operands,
                                width
                            ),
                            "{bytes:02x?}"
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn memory_integer_immediates_keep_selectors_and_signed_width_patterns() {
    let groups = [(0, Add), (1, Or), (4, And), (5, Sub), (6, Xor), (7, Cmp)];
    let imm8 = [
        (&[0][..], 0, 0),
        (&[0x7f][..], 0x7f, 0x7f),
        (&[0x80][..], 0xffff_ff80, 0xffff_ffff_ffff_ff80),
        (&[0xff][..], 0xffff_ffff, u64::MAX),
    ];
    let imm32 = [
        (&[0, 0, 0, 0][..], 0, 0),
        (&[0xff, 0xff, 0xff, 0x7f][..], 0x7fff_ffff, 0x7fff_ffff),
        (&[0, 0, 0, 0x80][..], 0x8000_0000, 0xffff_ffff_8000_0000),
        (&[0xff, 0xff, 0xff, 0xff][..], 0xffff_ffff, u64::MAX),
    ];
    for (opcode, selectors, immediates) in [
        (0x83, &groups[..], &imm8[..]),
        (0x81, &groups[..], &imm32[..]),
        (0xf7, &[(0, Test)][..], &imm32[..]),
    ] {
        for &(selector, kind) in selectors {
            for &(raw, expected32, expected64) in immediates {
                for (width, width_bit, expected) in [(W32, 0, expected32), (W64, 8, expected64)] {
                    for ignored_rx in [0, 2, 4, 6] {
                        let mut bytes = vec![
                            0x41 | width_bit | ignored_rx,
                            opcode,
                            0x45 | (selector << 3),
                            0,
                        ];
                        bytes.extend_from_slice(raw);
                        assert_eq!(
                            operation(&bytes),
                            alu(
                                kind,
                                Address {
                                    base: AddressBase::Register(13),
                                    index: None,
                                    displacement: 0,
                                },
                                MemoryFirst(Immediate(expected)),
                                width
                            ),
                            "{bytes:02x?}"
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn memory_integer_addresses_keep_sib_specials_displacements_and_aliases() {
    for (bytes, kind, base, index, displacement, operands, width) in [
        (
            &[0x4f, 0x01, 0x4c, 0xa5, 0xf8][..],
            Add,
            AddressBase::Register(13),
            Some(AddressIndex {
                register: 12,
                scale: 4,
            }),
            -8,
            MemoryFirst(Register(RegisterView::low(9))),
            W64,
        ),
        (
            &[0x49, 0x2b, 0x04, 0x25, 0, 0, 0, 0x80][..],
            Sub,
            AddressBase::None,
            None,
            -2147483648,
            RegisterFirst(RegisterView::low(0)),
            W64,
        ),
        (
            &[0x4a, 0x3b, 0x04, 0xe5, 0xfc, 0xff, 0xff, 0xff][..],
            Cmp,
            AddressBase::None,
            Some(AddressIndex {
                register: 12,
                scale: 8,
            }),
            -4,
            RegisterFirst(RegisterView::low(0)),
            W64,
        ),
        (
            &[0x4d, 0x39, 0x0c, 0x24][..],
            Cmp,
            AddressBase::Register(12),
            None,
            0,
            MemoryFirst(Register(RegisterView::low(9))),
            W64,
        ),
        (
            &[0x4a, 0x85, 0x04, 0xe4][..],
            Test,
            AddressBase::Register(4),
            Some(AddressIndex {
                register: 12,
                scale: 8,
            }),
            0,
            MemoryFirst(Register(RegisterView::low(0))),
            W64,
        ),
        (
            &[0x48, 0x85, 0x44, 0x00, 0x80][..],
            Test,
            AddressBase::Register(0),
            Some(AddressIndex {
                register: 0,
                scale: 1,
            }),
            -128,
            MemoryFirst(Register(RegisterView::low(0))),
            W64,
        ),
        (
            &[0x03, 0x83, 0xff, 0xff, 0xff, 0x7f][..],
            Add,
            AddressBase::Register(3),
            None,
            2147483647,
            RegisterFirst(RegisterView::low(0)),
            W32,
        ),
        (
            &[0x81, 0x24, 0x4b, 0, 0, 0, 0x80][..],
            And,
            AddressBase::Register(3),
            Some(AddressIndex {
                register: 1,
                scale: 2,
            }),
            0,
            MemoryFirst(Immediate(0x8000_0000)),
            W32,
        ),
        (
            &[0x83, 0x64, 0x8b, 0x7f, 0x80][..],
            And,
            AddressBase::Register(3),
            Some(AddressIndex {
                register: 1,
                scale: 4,
            }),
            127,
            MemoryFirst(Immediate(0xffff_ff80)),
            W32,
        ),
        (
            &[0x49, 0x83, 0x05, 0xff, 0xff, 0xff, 0x7f, 0xff][..],
            Add,
            AddressBase::NextPc,
            None,
            2147483647,
            MemoryFirst(Immediate(u64::MAX)),
            W64,
        ),
    ] {
        assert_eq!(
            operation(bytes),
            alu(
                kind,
                Address {
                    base,
                    index,
                    displacement
                },
                operands,
                width
            ),
            "{bytes:02x?}"
        );
    }
}

#[test]
fn rip_relative_memory_immediates_keep_the_completed_next_pc_and_domain_wrap() {
    for (bytes, kind, immediate, width) in [
        (&[0x83, 0x0d, 0, 0, 0, 0, 0][..], Or, 0, W32),
        (&[0x48, 0x83, 0x3d, 0, 0, 0, 0, 1][..], Cmp, 1, W64),
        (&[0x48, 0x81, 0x3d, 0, 0, 0, 0, 1, 0, 0, 0][..], Cmp, 1, W64),
        (
            &[0x48, 0xf7, 0x05, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff][..],
            Test,
            u64::MAX,
            W64,
        ),
    ] {
        let expected = alu(
            kind,
            Address {
                base: AddressBase::NextPc,
                index: None,
                displacement: 0,
            },
            MemoryFirst(Immediate(immediate)),
            width,
        );
        for pc in [
            0x1000,
            0x1_0000_1000,
            0xffff_8000_0000_1000,
            u64::MAX - bytes.len() as u64 + 1,
        ] {
            let mut reads = Vec::new();
            let decoded = decode::decode(pc, |address| {
                reads.push(address);
                address
                    .checked_sub(pc)
                    .and_then(|offset| bytes.get(offset as usize))
                    .copied()
                    .ok_or_else(|| missing(address))
            })
            .unwrap();
            assert_eq!(decoded.operation, expected, "{bytes:02x?} at {pc:x}");
            assert_eq!(decoded.next_pc, pc.wrapping_add(bytes.len() as u64));
            assert_eq!(
                reads,
                (0..bytes.len())
                    .map(|offset| pc + offset as u64)
                    .collect::<Vec<_>>()
            );
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
    for (opcode, selectors) in [(0xf6, &[1][..]), (0xf7, &[1]), (0xfe, &[2, 3, 4, 5, 6, 7])] {
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

#[test]
fn memory_integer_tail_fetches_preserve_fault_metadata_and_byte_order() {
    let bytes = [
        0x4f, 0xf7, 0x84, 0xa5, 0, 0, 0, 0x80, 0xff, 0xff, 0xff, 0xff,
    ];
    for denied_offset in [3, 4, 7, 8, 11] {
        let denied = Fault {
            address: 0x1000 + denied_offset,
            width: 1,
            access: Access::Execute,
            cause: Cause::Permission,
            failing: (0x1000 + denied_offset).into(),
        };
        let mut reads = Vec::new();
        let decoded = decode::decode(0x1000, |address| {
            reads.push(address);
            if address == denied.address {
                Err(denied)
            } else {
                Ok(bytes[(address - 0x1000) as usize])
            }
        });
        assert_eq!(decoded, Err(DecodeError::Fetch(denied)));
        assert_eq!(reads, (0x1000..=denied.address).collect::<Vec<_>>());
    }
}

#[test]
fn width_extension_admits_byte_memory_and_register_directions_but_keeps_other_prefixes_unsupported()
{
    for opcode in [0x03, 0x2b, 0x3b] {
        for prefix in [None, Some(0x40), Some(0x4f)] {
            let mut bytes: Vec<_> = prefix.into_iter().collect();
            bytes.extend([opcode, 0xff]);
            let pc = u64::MAX - bytes.len() as u64 + 1;
            let bank = if prefix == Some(0x4f) { 15 } else { 7 };
            let width = if prefix == Some(0x4f) { W64 } else { W32 };
            let kind = match opcode {
                0x03 => Add,
                0x2b => Sub,
                0x3b => Cmp,
                _ => unreachable!(),
            };
            let decoded = at(pc, &bytes).unwrap();
            assert_eq!(decoded.next_pc, 0);
            assert_eq!(
                decoded.operation,
                Operation::Alu {
                    kind,
                    dst: RegisterView::low(bank),
                    src: Register(RegisterView::low(bank)),
                    width,
                }
            );
        }
    }
    for prefix in [0x67, 0x26, 0x2e, 0x36, 0x3e, 0x64, 0x65, 0xf0, 0xf2, 0xf3] {
        assert_eq!(
            at(0x1000, &[prefix, 0x48, 0x01, 0x03]),
            Err(DecodeError::Unsupported)
        );
    }
    for opcode in [
        0x00, 0x02, 0x28, 0x2a, 0x38, 0x3a, 0x20, 0x22, 0x08, 0x0a, 0x30, 0x32, 0x84, 0x80, 0xf6,
    ] {
        assert!(matches!(
            at(0x1000, &[0x4f, opcode, 0x03, 0xff]).unwrap().operation,
            Operation::MemoryAlu {
                width: Width::W8,
                ..
            }
        ));
    }
    assert_eq!(
        at(0x1000, &[0x48, 0x49, 0x01, 0x03]),
        Err(DecodeError::Unsupported)
    );
}
