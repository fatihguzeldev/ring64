use super::{DecodeError, at, missing, operation};
use crate::memory::{Access, Cause, Fault};
use crate::x86::instruction::{
    Address, AddressBase, Bit, BitIndex, Carry, Count, DoubleShift, Location, Operation,
    RegisterView as R, Shift, Unary, Width,
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
                                ..Address::default()
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
fn ff_selects_transfer_family_before_requesting_unsupported_address_tails() {
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
                if matches!(selector, 2 | 4 | 6) {
                    if mode == 3 {
                        let decoded = at(0x1000, &bytes).unwrap();
                        assert!(matches!(
                            decoded.operation,
                            Operation::Call {
                                width: Width::W64,
                                ..
                            } | Operation::JumpRegister {
                                width: Width::W64,
                                ..
                            } | Operation::Push { .. }
                        ));
                    } else {
                        assert_eq!(
                            at(0x1000, &bytes),
                            Err(DecodeError::Fetch(missing(0x1000 + bytes.len() as u64))),
                            "{bytes:02x?}"
                        );
                    }
                } else {
                    assert_eq!(
                        at(0x1000, &bytes),
                        Err(DecodeError::Unsupported),
                        "{bytes:02x?}"
                    );
                }
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

#[test]
fn shift_rotate_and_double_shift_encodings_are_admitted() {
    for bytes in [
        &[0xd0, 0xe0][..],
        &[0x66, 0xd3, 0xd0][..],
        &[0x48, 0xc1, 0xf8, 0xff][..],
        &[0x0f, 0xa4, 0xc8, 1][..],
        &[0x66, 0x4f, 0x0f, 0xad, 0xc8][..],
    ] {
        assert!(at(0x1000, bytes).is_ok(), "{bytes:02x?}");
    }
}

#[test]
fn group_two_forms_cover_all_views_counts_and_selector_ignores() {
    for (selector, kind) in [
        (0, Shift::Rol),
        (1, Shift::Ror),
        (2, Shift::Rcl),
        (3, Shift::Rcr),
        (4, Shift::Shl),
        (5, Shift::Shr),
        (7, Shift::Sar),
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
                for (opcode, count) in [
                    (0xc0, Count::Immediate(255)),
                    (0xc1, Count::Immediate(255)),
                    (0xd0, Count::Immediate(1)),
                    (0xd1, Count::Immediate(1)),
                    (0xd2, Count::Cl),
                    (0xd3, Count::Cl),
                ] {
                    let width = if opcode & 1 == 0 { Width::W8 } else { wide };
                    for low in 0..8 {
                        let bank = low | rex.map_or(0, |value| (value & 1) << 3);
                        let dst = if width == Width::W8 && rex.is_none() && low >= 4 {
                            R::high_byte(low - 4)
                        } else {
                            R::low(bank)
                        };
                        let mut bytes = prefix.clone();
                        bytes.extend([opcode, 0xc0 | selector << 3 | low]);
                        if opcode <= 0xc1 {
                            bytes.push(255);
                        }
                        assert_eq!(
                            operation(&bytes),
                            Operation::Shift {
                                kind,
                                dst: Location::Register(dst),
                                count,
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
fn double_shifts_keep_every_source_and_destination_bank_at_selected_width() {
    for operand16 in [false, true] {
        for rex in std::iter::once(None).chain((0x40..=0x4f).map(Some)) {
            let mut prefix = Vec::new();
            if operand16 {
                prefix.push(0x66);
            }
            prefix.extend(rex);
            let width = if rex.is_some_and(|value| value & 8 != 0) {
                Width::W64
            } else if operand16 {
                Width::W16
            } else {
                Width::W32
            };
            for (opcode, kind, count) in [
                (0xa4, DoubleShift::Left, Count::Immediate(255)),
                (0xa5, DoubleShift::Left, Count::Cl),
                (0xac, DoubleShift::Right, Count::Immediate(255)),
                (0xad, DoubleShift::Right, Count::Cl),
            ] {
                for reg in 0..8 {
                    for rm in 0..8 {
                        let mut bytes = prefix.clone();
                        bytes.extend([0x0f, opcode, 0xc0 | (reg << 3) | rm]);
                        if opcode & 1 == 0 {
                            bytes.push(255);
                        }
                        assert_eq!(
                            operation(&bytes),
                            Operation::DoubleShift {
                                kind,
                                dst: Location::Register(R::low(
                                    rm | rex.map_or(0, |value| (value & 1) << 3)
                                )),
                                src: R::low(reg | rex.map_or(0, |value| (value & 4) << 1)),
                                count,
                                width,
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
fn count_memory_forms_keep_full_address_terms_and_count_source() {
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
            let address = Address {
                base: AddressBase::Register(3 | rex.map_or(0, |value| (value & 1) << 3)),
                index: None,
                displacement: -128,
                ..Address::default()
            };
            for (selector, kind) in [
                (0, Shift::Rol),
                (1, Shift::Ror),
                (2, Shift::Rcl),
                (3, Shift::Rcr),
                (4, Shift::Shl),
                (5, Shift::Shr),
                (7, Shift::Sar),
            ] {
                for (opcode, count) in [
                    (0xc0, Count::Immediate(255)),
                    (0xc1, Count::Immediate(255)),
                    (0xd0, Count::Immediate(1)),
                    (0xd1, Count::Immediate(1)),
                    (0xd2, Count::Cl),
                    (0xd3, Count::Cl),
                ] {
                    let mut bytes = prefix.clone();
                    bytes.extend([opcode, 0x43 | selector << 3, 0x80]);
                    if opcode <= 0xc1 {
                        bytes.push(255);
                    }
                    assert_eq!(
                        operation(&bytes),
                        Operation::Shift {
                            kind,
                            dst: Location::Memory(address),
                            count,
                            width: if opcode & 1 == 0 { Width::W8 } else { wide },
                        },
                        "{bytes:02x?}"
                    );
                }
            }
            for (opcode, kind, count) in [
                (0xa4, DoubleShift::Left, Count::Immediate(255)),
                (0xa5, DoubleShift::Left, Count::Cl),
                (0xac, DoubleShift::Right, Count::Immediate(255)),
                (0xad, DoubleShift::Right, Count::Cl),
            ] {
                let mut bytes = prefix.clone();
                bytes.extend([0x0f, opcode, 0x4b, 0x80]);
                if opcode & 1 == 0 {
                    bytes.push(255);
                }
                assert_eq!(
                    operation(&bytes),
                    Operation::DoubleShift {
                        kind,
                        dst: Location::Memory(address),
                        src: R::low(1 | rex.map_or(0, |value| (value & 4) << 1)),
                        count,
                        width: wide,
                    },
                    "{bytes:02x?}"
                );
            }
        }
    }
}

#[test]
fn count_encodings_require_every_address_and_immediate_byte_in_order() {
    for prefix in [&[][..], &[0x66][..], &[0x4f][..], &[0x66, 0x4f][..]] {
        for opcode in [0xc0, 0xc1, 0xd0, 0xd1, 0xd2, 0xd3] {
            for selector in [0, 1, 2, 3, 4, 5, 7] {
                let mut bytes = prefix.to_vec();
                bytes.extend([opcode, 0x84 | selector << 3, 0xad, 0, 0, 0, 0x80]);
                if opcode <= 0xc1 {
                    bytes.push(255);
                }
                assert_required_bytes(&bytes);
            }
        }
        for opcode in [0xa4, 0xa5, 0xac, 0xad] {
            let mut bytes = prefix.to_vec();
            bytes.extend([0x0f, opcode, 0x8c, 0xad, 0, 0, 0, 0x80]);
            if opcode & 1 == 0 {
                bytes.push(255);
            }
            assert_required_bytes(&bytes);
        }
    }
}

#[test]
fn group_two_selector_six_is_unsupported_before_address_or_count_bytes() {
    for prefix in [&[][..], &[0x66][..], &[0x4f][..], &[0x66, 0x4f][..]] {
        for opcode in [0xc0, 0xc1, 0xd0, 0xd1, 0xd2, 0xd3] {
            for mode in 0..4 {
                let mut bytes = prefix.to_vec();
                bytes.extend([opcode, (mode << 6) | (6 << 3) | 4]);
                assert_eq!(
                    at(0x1000, &bytes),
                    Err(DecodeError::Unsupported),
                    "{bytes:02x?}"
                );
            }
        }
    }
}

#[test]
fn bit_test_family_is_admitted() {
    for bytes in [
        &[0x0f, 0xa3, 0xc8][..],
        &[0x66, 0x0f, 0xba, 0x23, 0xff][..],
        &[0x4f, 0x0f, 0xbb, 0x03][..],
    ] {
        assert!(at(0x1000, bytes).is_ok(), "{bytes:02x?}");
    }
}

#[test]
fn bit_scan_forms_are_admitted() {
    for bytes in [
        &[0x0f, 0xbc, 0xc1][..],
        &[0x66, 0x0f, 0xbd, 0x03][..],
        &[0x48, 0x0f, 0xbc, 0xc0][..],
    ] {
        assert!(at(0x1000, bytes).is_ok(), "{bytes:02x?}");
    }
}

#[test]
fn byte_swap_forms_are_admitted_at_defined_widths() {
    for bytes in [
        &[0x0f, 0xc8][..],
        &[0x48, 0x0f, 0xcf][..],
        &[0x66, 0x4f, 0x0f, 0xc8][..],
    ] {
        assert!(at(0x1000, bytes).is_ok(), "{bytes:02x?}");
    }
}

fn wide_prefix_cases() -> Vec<(Vec<u8>, Width, u8, u8)> {
    let mut cases = Vec::new();
    for operand16 in [false, true] {
        for rex in std::iter::once(None).chain((0x40..=0x4f).map(Some)) {
            let mut prefix = Vec::new();
            if operand16 {
                prefix.push(0x66);
            }
            prefix.extend(rex);
            let width = if rex.is_some_and(|byte| byte >= 0x48) {
                Width::W64
            } else if operand16 {
                Width::W16
            } else {
                Width::W32
            };
            let reg_extension = match rex {
                Some(0x44..=0x47 | 0x4c..=0x4f) => 8,
                _ => 0,
            };
            let base_extension = u8::from(rex.is_some_and(|byte| byte % 2 != 0)) * 8;
            cases.push((prefix, width, reg_extension, base_extension));
        }
    }
    cases
}

#[test]
fn bit_register_indices_keep_both_encoded_register_banks_and_memory_addresses() {
    for (prefix, width, reg_extension, base_extension) in wide_prefix_cases() {
        for (opcode, kind) in [
            (0xa3, Bit::Test),
            (0xab, Bit::Set),
            (0xb3, Bit::Reset),
            (0xbb, Bit::Complement),
        ] {
            for register in 0..8 {
                for rm in 0..8 {
                    let mut bytes = prefix.clone();
                    bytes.extend([0x0f, opcode, 0xc0 | register << 3 | rm]);
                    assert_eq!(
                        operation(&bytes),
                        Operation::Bit {
                            kind,
                            dst: Location::Register(R::low(rm + base_extension)),
                            index: BitIndex::Register(R::low(register + reg_extension)),
                            width,
                        },
                        "{bytes:02x?}"
                    );
                }
                let mut bytes = prefix.clone();
                bytes.extend([0x0f, opcode, 0x43 | register << 3, 0x80]);
                assert_eq!(
                    operation(&bytes),
                    Operation::Bit {
                        kind,
                        dst: Location::Memory(Address {
                            base: AddressBase::Register(3 + base_extension),
                            index: None,
                            displacement: -128,
                            ..Address::default()
                        }),
                        index: BitIndex::Register(R::low(register + reg_extension)),
                        width,
                    },
                    "{bytes:02x?}"
                );
            }
        }
    }
}

#[test]
fn bit_immediates_preserve_raw_bytes_and_ignore_the_selector_rex_extension() {
    for (prefix, width, _, base_extension) in wide_prefix_cases() {
        for (selector, kind) in [
            (4, Bit::Test),
            (5, Bit::Set),
            (6, Bit::Reset),
            (7, Bit::Complement),
        ] {
            for index in [0, 16, 32, 64, 255] {
                for rm in 0..8 {
                    let mut bytes = prefix.clone();
                    bytes.extend([0x0f, 0xba, 0xc0 | selector << 3 | rm, index]);
                    assert_eq!(
                        operation(&bytes),
                        Operation::Bit {
                            kind,
                            dst: Location::Register(R::low(rm + base_extension)),
                            index: BitIndex::Immediate(index),
                            width,
                        },
                        "{bytes:02x?}"
                    );
                }
                let mut bytes = prefix.clone();
                bytes.extend([0x0f, 0xba, 0x43 | selector << 3, 0x80, index]);
                assert_eq!(
                    operation(&bytes),
                    Operation::Bit {
                        kind,
                        dst: Location::Memory(Address {
                            base: AddressBase::Register(3 + base_extension),
                            index: None,
                            displacement: -128,
                            ..Address::default()
                        }),
                        index: BitIndex::Immediate(index),
                        width,
                    },
                    "{bytes:02x?}"
                );
            }
        }
    }
}

#[test]
fn bit_scans_keep_selected_source_and_destination_widths_without_byte_aliases() {
    for (prefix, width, reg_extension, base_extension) in wide_prefix_cases() {
        for (opcode, reverse) in [(0xbc, false), (0xbd, true)] {
            for register in 0..8 {
                for rm in 0..8 {
                    let mut bytes = prefix.clone();
                    bytes.extend([0x0f, opcode, 0xc0 | register << 3 | rm]);
                    assert_eq!(
                        operation(&bytes),
                        Operation::Scan {
                            reverse,
                            dst: R::low(register + reg_extension),
                            src: Location::Register(R::low(rm + base_extension)),
                            width,
                        },
                        "{bytes:02x?}"
                    );
                }
                let mut bytes = prefix.clone();
                bytes.extend([0x0f, opcode, 0x43 | register << 3, 0x80]);
                assert_eq!(
                    operation(&bytes),
                    Operation::Scan {
                        reverse,
                        dst: R::low(register + reg_extension),
                        src: Location::Memory(Address {
                            base: AddressBase::Register(3 + base_extension),
                            index: None,
                            displacement: -128,
                            ..Address::default()
                        }),
                        width,
                    },
                    "{bytes:02x?}"
                );
            }
        }
    }
}

#[test]
fn byte_swap_uses_the_opcode_base_extension_and_excludes_undefined_word_forms() {
    for (prefix, width, _, base_extension) in wide_prefix_cases() {
        for low in 0..8 {
            let mut bytes = prefix.clone();
            bytes.extend([0x0f, 0xc8 + low]);
            if width == Width::W16 {
                assert_eq!(at(0x1000, &bytes), Err(DecodeError::Unsupported));
            } else {
                assert_eq!(
                    operation(&bytes),
                    Operation::Bswap {
                        dst: R::low(low + base_extension),
                        width,
                    },
                    "{bytes:02x?}"
                );
                assert_required_bytes(&bytes);
            }
        }
    }
}

#[test]
fn bit_and_scan_encodings_complete_every_address_tail_and_immediate_before_execution() {
    for prefix in [&[][..], &[0x66][..], &[0x4f][..], &[0x66, 0x4f][..]] {
        for opcode in [0xa3, 0xab, 0xb3, 0xbb, 0xbc, 0xbd] {
            let mut bytes = prefix.to_vec();
            bytes.extend([0x0f, opcode, 0x8c, 0xad, 0, 0, 0, 0x80]);
            assert_required_bytes(&bytes);
        }
        for selector in 4..8 {
            let mut bytes = prefix.to_vec();
            bytes.extend([0x0f, 0xba, 0x84 | selector << 3, 0xad, 0, 0, 0, 0x80, 255]);
            assert_required_bytes(&bytes);
        }
    }
    let bytes = [0x66, 0x44, 0x0f, 0xba, 0x35, 0, 0, 0, 0, 255];
    assert_eq!(
        operation(&bytes),
        Operation::Bit {
            kind: Bit::Reset,
            dst: Location::Memory(Address {
                base: AddressBase::NextPc,
                index: None,
                displacement: 0,
                ..Address::default()
            }),
            index: BitIndex::Immediate(255),
            width: Width::W16,
        }
    );
    assert_required_bytes(&bytes);
}

#[test]
fn bit_family_exclusions_stop_at_the_deciding_prefix_or_selector() {
    for prefix in [&[][..], &[0x66][..], &[0x4f][..], &[0x66, 0x4f][..]] {
        for selector in 0..4 {
            for mode in 0..4 {
                let mut bytes = prefix.to_vec();
                bytes.extend([0x0f, 0xba, mode << 6 | selector << 3 | 4]);
                assert_eq!(
                    at(0x1000, &bytes),
                    Err(DecodeError::Unsupported),
                    "{bytes:02x?}"
                );
            }
        }
    }
    for bytes in [
        &[0xf0, 0x0f, 0xab][..],
        &[0xf3, 0x0f, 0xbc][..],
        &[0xf3, 0x0f, 0xbd][..],
    ] {
        assert_eq!(at(0x1000, bytes), Err(DecodeError::Unsupported));
    }
}
