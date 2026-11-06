use super::{DecodeError, at, missing, operation};
use crate::memory::{Access, Cause, Fault};
use crate::x86::instruction::{
    Address, AddressBase, Carry, Location, Operation, RegisterView as R, Unary, Width,
};

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

#[test]
fn unary_and_status_forms_are_admitted_before_operand16_transfer_policy() {
    for bytes in [
        &[0xfe, 0xc4][..],
        &[0x66, 0xff, 0xc8][..],
        &[0xf6, 0xd4][..],
        &[0x4f, 0xf7, 0xd8][..],
        &[0x66, 0x4f, 0xf8][..],
        &[0xf9][..],
        &[0xf5][..],
        &[0x4f, 0x9f][..],
        &[0x4f, 0x9e][..],
    ] {
        assert!(at(0x1000, bytes).is_ok(), "{bytes:02x?}");
    }
    assert_eq!(
        at(0x1000, &[0x66, 0xff]),
        Err(DecodeError::Fetch(missing(0x1002)))
    );
}

#[test]
fn unary_forms_cover_every_width_bank_high_byte_and_ignored_selector_extension() {
    for (byte_opcode, wide_opcode, selector, kind) in [
        (0xfe, 0xff, 0, Unary::Inc),
        (0xfe, 0xff, 1, Unary::Dec),
        (0xf6, 0xf7, 2, Unary::Not),
        (0xf6, 0xf7, 3, Unary::Neg),
    ] {
        for operand16 in [false, true] {
            for rex in std::iter::once(None).chain((0x40..=0x4f).map(Some)) {
                let mut prefix = Vec::new();
                if operand16 {
                    prefix.push(0x66);
                }
                prefix.extend(rex);
                let wide = if rex.is_some_and(|value| value & 8 != 0) {
                    Width::W64
                } else if operand16 {
                    Width::W16
                } else {
                    Width::W32
                };
                for (opcode, width) in [(byte_opcode, Width::W8), (wide_opcode, wide)] {
                    for low in 0..8 {
                        let bank = low | rex.map_or(0, |value| (value & 1) << 3);
                        let dst = if width == Width::W8 && rex.is_none() && low >= 4 {
                            R::high_byte(low - 4)
                        } else {
                            R::low(bank)
                        };
                        let mut bytes = prefix.clone();
                        bytes.extend([opcode, 0xc0 | selector << 3 | low]);
                        assert_eq!(
                            operation(&bytes),
                            Operation::Unary {
                                kind,
                                dst: Location::Register(dst),
                                width,
                            },
                            "{bytes:02x?}"
                        );
                    }
                    let mut bytes = prefix.clone();
                    bytes.extend([opcode, 0x40 | selector << 3 | 3, 0x80]);
                    assert_eq!(
                        operation(&bytes),
                        Operation::Unary {
                            kind,
                            dst: Location::Memory(Address {
                                base: AddressBase::Register(
                                    3 | rex.map_or(0, |value| (value & 1) << 3)
                                ),
                                index: None,
                                displacement: -128,
                            }),
                            width,
                        },
                        "{bytes:02x?}"
                    );
                }
            }
        }
    }
}

#[test]
fn implicit_status_operations_ignore_all_rex_fields_and_operand_override() {
    for operand16 in [false, true] {
        for rex in std::iter::once(None).chain((0x40..=0x4f).map(Some)) {
            for (opcode, expected) in [
                (0xf8, Operation::Carry { kind: Carry::Clear }),
                (0xf9, Operation::Carry { kind: Carry::Set }),
                (
                    0xf5,
                    Operation::Carry {
                        kind: Carry::Complement,
                    },
                ),
                (0x9f, Operation::Lahf),
                (0x9e, Operation::Sahf),
            ] {
                let mut bytes = Vec::new();
                if operand16 {
                    bytes.push(0x66);
                }
                bytes.extend(rex);
                bytes.push(opcode);
                assert_eq!(operation(&bytes), expected, "{bytes:02x?}");
            }
        }
    }
}

#[test]
fn ff_selects_the_family_before_rejecting_transfer_prefixes_or_address_tails() {
    for bytes in [
        &[0x66, 0xff][..],
        &[0x66, 0x4f, 0xff][..],
        &[0xff, 4][..],
        &[0xff, 0x0c][..],
    ] {
        assert_eq!(
            at(0x1000, bytes),
            Err(DecodeError::Fetch(missing(0x1000 + bytes.len() as u64)))
        );
    }
    for prefix in [&[0x66][..], &[0x66, 0x48][..]] {
        for selector in 2..8 {
            for mode in 0..4 {
                let mut bytes = prefix.to_vec();
                bytes.extend([0xff, (mode << 6) | (selector << 3) | 4]);
                assert_eq!(
                    at(0x1000, &bytes),
                    Err(DecodeError::Unsupported),
                    "{bytes:02x?}"
                );
            }
        }
    }
}

fn assert_required_bytes(bytes: &[u8]) {
    assert_eq!(
        at(0x1000, bytes).unwrap().next_pc,
        0x1000 + bytes.len() as u64
    );
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
    let pc = u64::MAX - bytes.len() as u64 + 1;
    assert_eq!(at(pc, bytes).unwrap().next_pc, 0, "{bytes:02x?}");
}

#[test]
fn unary_memory_forms_require_complete_sib_displacements_before_execution() {
    for prefix in [&[][..], &[0x66][..], &[0x4f][..], &[0x66, 0x4f][..]] {
        for (opcode, selectors) in [
            (0xfe, &[0, 1][..]),
            (0xff, &[0, 1]),
            (0xf6, &[2, 3]),
            (0xf7, &[2, 3]),
        ] {
            for selector in selectors {
                let mut bytes = prefix.to_vec();
                bytes.extend([opcode, 0x84 | selector << 3, 0xad, 0, 0, 0, 0x80]);
                assert_required_bytes(&bytes);
            }
        }
    }
}
