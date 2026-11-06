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

use super::operation;
use crate::x86::instruction::{
    Address, AddressBase, Alu, Condition, DataOperand, Location, MemoryAluOperands, Operation,
    RegisterView as R, Width,
};

fn base_address() -> Address {
    Address {
        base: AddressBase::Register(3),
        index: None,
        displacement: 0,
    }
}

#[test]
fn ordinary_integer_matrix_covers_every_direction_width_and_accumulator_encoding() {
    use Alu::*;
    for (kind, byte_rm, wide_rm, byte_reg, wide_reg, byte_acc, wide_acc, selector) in [
        (Add, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0),
        (Or, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 1),
        (And, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 4),
        (Sub, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 5),
        (Xor, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 6),
        (Cmp, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 7),
    ] {
        for (prefix, wide, imm, value, short_value) in [
            (
                &[][..],
                Width::W32,
                &[0, 0, 0, 0x80][..],
                0x80000000,
                0xffffff80,
            ),
            (&[0x66][..], Width::W16, &[0, 0x80][..], 0x8000, 0xff80),
            (
                &[0x48][..],
                Width::W64,
                &[0, 0, 0, 0x80][..],
                0xffffffff80000000,
                0xffffffffffffff80,
            ),
            (
                &[0x66, 0x48][..],
                Width::W64,
                &[0, 0, 0, 0x80][..],
                0xffffffff80000000,
                0xffffffffffffff80,
            ),
        ] {
            for (rm_opcode, reg_opcode, accumulator, group, width, immediate, expected) in [
                (
                    byte_rm,
                    byte_reg,
                    byte_acc,
                    0x80,
                    Width::W8,
                    &[0x80][..],
                    0x80,
                ),
                (wide_rm, wide_reg, wide_acc, 0x81, wide, imm, value),
            ] {
                for (opcode, modrm) in [(rm_opcode, 0xc8), (reg_opcode, 0xc1)] {
                    let mut bytes = prefix.to_vec();
                    bytes.extend([opcode, modrm]);
                    assert_eq!(
                        operation(&bytes),
                        Operation::Alu {
                            kind,
                            dst: R::low(0),
                            src: DataOperand::Register(R::low(1)),
                            width,
                        },
                        "{bytes:02x?}"
                    );
                }
                for (opcode, operands) in [
                    (
                        rm_opcode,
                        MemoryAluOperands::MemoryFirst(DataOperand::Register(R::low(1))),
                    ),
                    (reg_opcode, MemoryAluOperands::RegisterFirst(R::low(1))),
                ] {
                    let mut bytes = prefix.to_vec();
                    bytes.extend([opcode, 0x0b]);
                    assert_eq!(
                        operation(&bytes),
                        Operation::MemoryAlu {
                            kind,
                            address: base_address(),
                            operands,
                            width,
                        },
                        "{bytes:02x?}"
                    );
                }
                for (opcode, modrm) in [(accumulator, None), (group, Some(0xc0 | selector << 3))] {
                    let mut bytes = prefix.to_vec();
                    bytes.push(opcode);
                    bytes.extend(modrm);
                    bytes.extend(immediate);
                    assert_eq!(
                        operation(&bytes),
                        Operation::Alu {
                            kind,
                            dst: R::low(0),
                            src: DataOperand::Immediate(expected),
                            width,
                        },
                        "{bytes:02x?}"
                    );
                }
            }
            let mut bytes = prefix.to_vec();
            bytes.extend([0x83, 0xc0 | selector << 3, 0x80]);
            assert_eq!(
                operation(&bytes),
                Operation::Alu {
                    kind,
                    dst: R::low(0),
                    src: DataOperand::Immediate(short_value),
                    width: wide,
                }
            );
        }
    }
}

#[test]
fn narrow_move_test_and_extension_records_keep_views_source_width_and_signedness() {
    use DataOperand::{Immediate, Register};
    use Width::*;
    for (bytes, expected) in [
        (
            &[0xb4, 0x80][..],
            Operation::Mov {
                dst: R::high_byte(0),
                src: Immediate(0x80),
                width: W8,
            },
        ),
        (
            &[0x40, 0xb4, 0x80][..],
            Operation::Mov {
                dst: R::low(4),
                src: Immediate(0x80),
                width: W8,
            },
        ),
        (
            &[0x66, 0x41, 0xb7, 0x80][..],
            Operation::Mov {
                dst: R::low(15),
                src: Immediate(0x80),
                width: W8,
            },
        ),
        (
            &[0x88, 0xe0][..],
            Operation::Mov {
                dst: R::low(0),
                src: Register(R::high_byte(0)),
                width: W8,
            },
        ),
        (
            &[0x66, 0x44, 0x8b, 3][..],
            Operation::Load {
                dst: R::low(8),
                address: base_address(),
                width: W16,
            },
        ),
        (
            &[0x66, 0xc7, 3, 0, 0x80][..],
            Operation::Store {
                src: Immediate(0x8000),
                address: base_address(),
                width: W16,
            },
        ),
        (
            &[0x48, 0xc7, 3, 0, 0, 0, 0x80][..],
            Operation::Store {
                src: Immediate(0xffffffff80000000),
                address: base_address(),
                width: W64,
            },
        ),
        (
            &[0x66, 0x85, 0xe0][..],
            Operation::Alu {
                kind: Alu::Test,
                dst: R::low(0),
                src: Register(R::low(4)),
                width: W16,
            },
        ),
        (
            &[0x84, 0xe0][..],
            Operation::Alu {
                kind: Alu::Test,
                dst: R::low(0),
                src: Register(R::high_byte(0)),
                width: W8,
            },
        ),
        (
            &[0xf6, 0xc4, 0x80][..],
            Operation::Alu {
                kind: Alu::Test,
                dst: R::high_byte(0),
                src: Immediate(0x80),
                width: W8,
            },
        ),
        (
            &[0x66, 0xf7, 0xc0, 0, 0x80][..],
            Operation::Alu {
                kind: Alu::Test,
                dst: R::low(0),
                src: Immediate(0x8000),
                width: W16,
            },
        ),
        (
            &[0x66, 0xa9, 0, 0x80][..],
            Operation::Alu {
                kind: Alu::Test,
                dst: R::low(0),
                src: Immediate(0x8000),
                width: W16,
            },
        ),
        (
            &[0x48, 0xa9, 0, 0, 0, 0x80][..],
            Operation::Alu {
                kind: Alu::Test,
                dst: R::low(0),
                src: Immediate(0xffffffff80000000),
                width: W64,
            },
        ),
    ] {
        assert_eq!(operation(bytes), expected, "{bytes:02x?}");
    }
    for (prefix, width) in [
        (&[][..], W32),
        (&[0x66][..], W16),
        (&[0x48][..], W64),
        (&[0x66, 0x48][..], W64),
    ] {
        for (opcode, source_width, signed) in [
            (0xb6, W8, false),
            (0xbe, W8, true),
            (0xb7, W16, false),
            (0xbf, W16, true),
        ] {
            if source_width == W16 && width == W16 {
                continue;
            }
            for (modrm, src) in [
                (
                    0xc4,
                    Location::Register(
                        if source_width == W8 && prefix.is_empty()
                            || source_width == W8 && prefix == [0x66]
                        {
                            R::high_byte(0)
                        } else {
                            R::low(4)
                        },
                    ),
                ),
                (3, Location::Memory(base_address())),
            ] {
                let mut bytes = prefix.to_vec();
                bytes.extend([0x0f, opcode, modrm]);
                assert_eq!(
                    operation(&bytes),
                    Operation::Extend {
                        dst: R::low(0),
                        src,
                        source_width,
                        width,
                        signed
                    },
                    "{bytes:02x?}"
                );
            }
        }
        let source_width = if width == W64 { W32 } else { width };
        let mut bytes = prefix.to_vec();
        bytes.extend([0x63, 0xc1]);
        assert_eq!(
            operation(&bytes),
            Operation::Extend {
                dst: R::low(0),
                src: Location::Register(R::low(1)),
                source_width,
                width,
                signed: true
            }
        );
        let mut bytes = prefix.to_vec();
        bytes.push(0x99);
        assert_eq!(operation(&bytes), Operation::SignHigh { width });
    }
}

#[test]
fn condition_data_opcodes_cover_all_conditions_and_ignore_setcc_reg_bits() {
    use Condition::*;
    let conditions = [
        Overflow,
        NotOverflow,
        Below,
        AboveOrEqual,
        Equal,
        NotEqual,
        BelowOrEqual,
        Above,
        Sign,
        NotSign,
        Parity,
        NotParity,
        Less,
        GreaterOrEqual,
        LessOrEqual,
        Greater,
    ];
    for (cc, condition) in conditions.into_iter().enumerate() {
        for (prefix, width, byte_register) in [
            (&[][..], Width::W32, R::high_byte(0)),
            (&[0x66][..], Width::W16, R::high_byte(0)),
            (&[0x40][..], Width::W32, R::low(4)),
            (&[0x4c][..], Width::W64, R::low(4)),
            (&[0x66, 0x4c][..], Width::W64, R::low(4)),
        ] {
            for reg in 0..8 {
                let mut bytes = prefix.to_vec();
                bytes.extend([0x0f, 0x90 + cc as u8, 0xc4 | reg << 3]);
                assert_eq!(
                    operation(&bytes),
                    Operation::Setcc {
                        dst: Location::Register(byte_register),
                        condition
                    },
                    "{bytes:02x?}"
                );
            }
            let dst = if prefix.contains(&0x4c) {
                R::low(8)
            } else {
                R::low(0)
            };
            for (modrm, src) in [
                (0xc1, Location::Register(R::low(1))),
                (3, Location::Memory(base_address())),
            ] {
                let mut bytes = prefix.to_vec();
                bytes.extend([0x0f, 0x40 + cc as u8, modrm]);
                assert_eq!(
                    operation(&bytes),
                    Operation::Cmov {
                        dst,
                        src,
                        width,
                        condition
                    },
                    "{bytes:02x?}"
                );
            }
        }
    }
}

#[test]
fn scalar_required_fields_truncate_at_each_byte_and_preserve_domain_failure_metadata() {
    use crate::memory::{Access, Cause, Fault};
    for bytes in [
        &[0x66, 0x48, 0xb8, 1, 2, 3, 4, 5, 6, 7, 8][..],
        &[0x66, 0xc7, 0x44, 0x8b, 0xf8, 0, 0x80][..],
        &[0x66, 0x83, 0x44, 0x8b, 0xf8, 0x80][..],
        &[0x48, 0xf7, 0x05, 0, 0, 0, 0, 0, 0, 0, 0x80][..],
        &[0x66, 0xa1, 0, 0x40, 0, 0, 1, 0, 0, 0][..],
        &[0x4f, 0x0f, 0xbe, 0x84, 0x8b, 0, 0, 0, 0x80][..],
        &[0x66, 0x0f, 0x44, 0x84, 0x8b, 0, 0, 0, 0x80][..],
        &[0x66, 0x4f, 0x0f, 0x94, 0x84, 0x8b, 0, 0, 0, 0x80][..],
    ] {
        assert_eq!(
            at(0x1000, bytes).unwrap().next_pc,
            0x1000 + bytes.len() as u64
        );
        assert_eq!(
            at(u64::MAX - bytes.len() as u64 + 1, bytes)
                .unwrap()
                .next_pc,
            0
        );
        for length in 0..bytes.len() {
            assert_eq!(
                at(0x1000, &bytes[..length]),
                Err(DecodeError::Fetch(missing(0x1000 + length as u64))),
                "{bytes:02x?}/{length}"
            );
            if length != 0 {
                let pc = u64::MAX - length as u64 + 1;
                assert_eq!(
                    at(pc, &bytes[..length]),
                    Err(DecodeError::Fetch(Fault {
                        address: pc,
                        width: length as u32 + 1,
                        access: Access::Execute,
                        cause: Cause::AddressRange,
                        failing: 1u128 << 64
                    })),
                    "{bytes:02x?}/{length} at {pc:x}"
                );
            }
        }
    }
}

#[test]
fn unsupported_scalar_forms_and_invalid_lea_stop_before_unneeded_fields() {
    use crate::x86::decode::decode;
    for bytes in [
        &[0x82][..],
        &[0x67][..],
        &[0x66, 0x66][..],
        &[0x48, 0x66][..],
        &[0x48, 0x49][..],
        &[0x66, 0x0f, 0xbf][..],
        &[0x66, 0x44, 0x0f, 0xb7][..],
        &[0xc7, 0x0c][..],
        &[0x66, 0xc6, 0x0c][..],
        &[0x48, 0x80, 0x14][..],
        &[0x66, 0x81, 0x1c][..],
        &[0x83, 0x1c][..],
        &[0xf6, 0x0c][..],
        &[0x66, 0xf7, 0x3c][..],
        &[0x66, 0x50][..],
        &[0x66, 0xe8][..],
        &[0x48, 0x0f, 0x85][..],
    ] {
        let mut reads = Vec::new();
        let result = decode(0x1000, |pc| {
            reads.push(pc);
            bytes
                .get((pc - 0x1000) as usize)
                .copied()
                .ok_or_else(|| missing(pc))
        });
        assert_eq!(result, Err(DecodeError::Unsupported), "{bytes:02x?}");
        assert_eq!(
            reads,
            (0..bytes.len())
                .map(|i| 0x1000 + i as u64)
                .collect::<Vec<_>>(),
            "{bytes:02x?}"
        );
    }
    for prefix in [&[][..], &[0x66][..], &[0x48][..], &[0x66, 0x48][..]] {
        let mut bytes = prefix.to_vec();
        bytes.extend([0x8d, 0xc4]);
        let pc = u64::MAX - bytes.len() as u64 + 1;
        assert_eq!(at(pc, &bytes), Err(DecodeError::Invalid));
    }
}

#[test]
fn byte_and_word_register_fields_cover_every_bank_and_legacy_high_view() {
    let byte_views = [
        R::low(0),
        R::low(1),
        R::low(2),
        R::low(3),
        R::high_byte(0),
        R::high_byte(1),
        R::high_byte(2),
        R::high_byte(3),
    ];
    for (reg, source) in byte_views.into_iter().enumerate() {
        for (rm, destination) in byte_views.into_iter().enumerate() {
            for (opcode, dst, src) in [(0x88, destination, source), (0x8a, source, destination)] {
                let bytes = [opcode, 0xc0 | (reg as u8) << 3 | rm as u8];
                assert_eq!(
                    operation(&bytes),
                    Operation::Mov {
                        dst,
                        src: DataOperand::Register(src),
                        width: Width::W8
                    }
                );
            }
        }
    }
    for width in [Width::W8, Width::W16] {
        for reg in 0..16u8 {
            for rm in 0..16u8 {
                for (opcode, dst, src) in if width == Width::W8 {
                    [(0x88, rm, reg), (0x8a, reg, rm)]
                } else {
                    [(0x89, rm, reg), (0x8b, reg, rm)]
                } {
                    for ignored in if width == Width::W8 {
                        &[0, 2, 8, 10][..]
                    } else {
                        &[0, 2][..]
                    } {
                        let mut bytes = Vec::new();
                        if width == Width::W16 {
                            bytes.push(0x66);
                        }
                        bytes.extend([
                            0x40 | ((reg >> 3) << 2) | (rm >> 3) | ignored,
                            opcode,
                            0xc0 | ((reg & 7) << 3) | (rm & 7),
                        ]);
                        assert_eq!(
                            operation(&bytes),
                            Operation::Mov {
                                dst: R::low(dst),
                                src: DataOperand::Register(R::low(src)),
                                width
                            },
                            "{bytes:02x?}"
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn moffs_addresses_are_always_full_width_and_accumulator_selection_ignores_rex_fields() {
    let address = Address {
        base: AddressBase::None,
        index: None,
        displacement: 0x100004000,
    };
    for (prefix, wide) in [
        (&[][..], Width::W32),
        (&[0x66][..], Width::W16),
        (&[0x47][..], Width::W32),
        (&[0x4f][..], Width::W64),
        (&[0x66, 0x47][..], Width::W16),
        (&[0x66, 0x4f][..], Width::W64),
    ] {
        for (opcode, width) in [
            (0xa0, Width::W8),
            (0xa1, wide),
            (0xa2, Width::W8),
            (0xa3, wide),
        ] {
            let mut bytes = prefix.to_vec();
            bytes.push(opcode);
            bytes.extend(0x100004000u64.to_le_bytes());
            let expected = if opcode < 0xa2 {
                Operation::Load {
                    dst: R::low(0),
                    address,
                    width,
                }
            } else {
                Operation::Store {
                    src: DataOperand::Register(R::low(0)),
                    address,
                    width,
                }
            };
            assert_eq!(operation(&bytes), expected, "{bytes:02x?}");
        }
    }
}
