use super::{DecodeError, at, missing, operation};
use crate::memory::{Access, Cause, Fault};
use crate::x86::decode::decode;
use crate::x86::instruction::{
    Address, AddressBase, AddressIndex, Location, Operation, RegisterView as R, Width,
};

#[test]
fn full_product_forms_are_admitted_and_require_address_tails() {
    for bytes in [&[0xf6, 0xe4][..], &[0x66, 0xf7, 0xe9][..]] {
        assert!(at(0x1000, bytes).is_ok(), "{bytes:02x?}");
    }
    assert_eq!(
        at(0x1000, &[0x48, 0xf7, 0x24]),
        Err(DecodeError::Fetch(missing(0x1003)))
    );
}

#[test]
fn truncated_imul_forms_are_admitted_and_require_immediates() {
    for bytes in [
        &[0x0f, 0xaf, 0xc1][..],
        &[0x66, 0x69, 0xc1, 0xff, 0xff][..],
        &[0x48, 0x6b, 0xc1, 0xff][..],
    ] {
        assert!(at(0x1000, bytes).is_ok(), "{bytes:02x?}");
    }
    assert_eq!(
        at(0x1000, &[0x48, 0x69, 0xc1, 0xff, 0xff, 0xff]),
        Err(DecodeError::Fetch(missing(0x1006)))
    );
}

#[test]
fn divide_forms_are_admitted_and_require_address_tails() {
    for bytes in [&[0xf6, 0xf4][..], &[0x4f, 0xf7, 0xf9][..]] {
        assert!(at(0x1000, bytes).is_ok(), "{bytes:02x?}");
    }
    assert_eq!(
        at(0x1000, &[0x66, 0xf7, 0x7c, 0x24]),
        Err(DecodeError::Fetch(missing(0x1004)))
    );
}

fn prefixes() -> impl Iterator<Item = (Vec<u8>, Width, Option<u8>)> {
    [false, true].into_iter().flat_map(|operand16| {
        std::iter::once(None)
            .chain((0x40..=0x4f).map(Some))
            .map(move |rex| {
                let mut bytes = Vec::new();
                if operand16 {
                    bytes.push(0x66);
                }
                bytes.extend(rex);
                let width = if rex.is_some_and(|value| value & 8 != 0) {
                    Width::W64
                } else if operand16 {
                    Width::W16
                } else {
                    Width::W32
                };
                (bytes, width, rex)
            })
    })
}

#[test]
fn implicit_pairs_cover_all_widths_source_banks_and_ignored_selector_extensions() {
    for (prefix, wide, rex) in prefixes() {
        for (opcode, width) in [(0xf6, Width::W8), (0xf7, wide)] {
            for selector in 4..8 {
                for low in 0..8 {
                    let mut bytes = prefix.clone();
                    bytes.extend([opcode, 0xc0 | selector << 3 | low]);
                    let bank = low | rex.map_or(0, |value| (value & 1) << 3);
                    let src =
                        Location::Register(if width == Width::W8 && rex.is_none() && low >= 4 {
                            R::high_byte(low - 4)
                        } else {
                            R::low(bank)
                        });
                    let signed = selector & 1 != 0;
                    assert_eq!(
                        operation(&bytes),
                        if selector < 6 {
                            Operation::Multiply { signed, src, width }
                        } else {
                            Operation::Divide { signed, src, width }
                        },
                        "{bytes:02x?}"
                    );
                }
            }
        }
    }
}

#[test]
fn truncated_imul_covers_every_destination_source_bank_and_immediate_kind() {
    for (prefix, width, rex) in prefixes() {
        for destination in 0..8 {
            for source in 0..8 {
                let dst = R::low(destination | rex.map_or(0, |value| (value & 4) << 1));
                let src =
                    Location::Register(R::low(source | rex.map_or(0, |value| (value & 1) << 3)));
                for (opcode, immediate, value) in [
                    (&[0x0f, 0xaf][..], &[][..], None),
                    (&[0x6b][..], &[0xff][..], Some(width.mask())),
                    (
                        &[0x69][..],
                        if width == Width::W16 {
                            &[0, 0x80][..]
                        } else {
                            &[0, 0, 0, 0x80][..]
                        },
                        Some(match width {
                            Width::W16 => 0x8000,
                            Width::W32 => 0x8000_0000,
                            Width::W64 => 0xffff_ffff_8000_0000,
                            Width::W8 => unreachable!(),
                        }),
                    ),
                ] {
                    let mut bytes = prefix.clone();
                    bytes.extend(opcode);
                    bytes.push(0xc0 | destination << 3 | source);
                    bytes.extend(immediate);
                    assert_eq!(
                        operation(&bytes),
                        Operation::Imul {
                            dst,
                            src,
                            immediate: value,
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
fn every_family_keeps_its_memory_source_and_complete_rip_relative_length() {
    for (prefix, wide, rex) in prefixes() {
        let src = Location::Memory(Address {
            base: AddressBase::Register(5 | rex.map_or(0, |value| (value & 1) << 3)),
            index: Some(AddressIndex {
                register: 5 | rex.map_or(0, |value| (value & 2) << 2),
                scale: 4,
            }),
            displacement: i64::from(i32::MIN),
        });
        for (opcode, width) in [(0xf6, Width::W8), (0xf7, wide)] {
            for selector in 4..8 {
                let mut bytes = prefix.clone();
                bytes.extend([opcode, 0x84 | selector << 3, 0xad, 0, 0, 0, 0x80]);
                let signed = selector & 1 != 0;
                assert_eq!(
                    operation(&bytes),
                    if selector < 6 {
                        Operation::Multiply { signed, src, width }
                    } else {
                        Operation::Divide { signed, src, width }
                    },
                    "{bytes:02x?}"
                );
            }
        }
        for opcode in [&[0x0f, 0xaf][..], &[0x69][..], &[0x6b][..]] {
            let mut bytes = prefix.clone();
            bytes.extend(opcode);
            bytes.extend([0x3d, 0xf0, 0xff, 0xff, 0xff]);
            let immediate = match opcode {
                [0x69] => {
                    bytes.extend(std::iter::repeat_n(
                        0xff,
                        if wide == Width::W16 { 2 } else { 4 },
                    ));
                    Some(wide.mask())
                }
                [0x6b] => {
                    bytes.push(0xff);
                    Some(wide.mask())
                }
                _ => None,
            };
            assert_eq!(
                operation(&bytes),
                Operation::Imul {
                    dst: R::low(7 | rex.map_or(0, |value| (value & 4) << 1)),
                    src: Location::Memory(Address {
                        base: AddressBase::NextPc,
                        index: None,
                        displacement: -16,
                    }),
                    immediate,
                    width: wide,
                },
                "{bytes:02x?}"
            );
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
fn every_admitted_tail_and_immediate_is_required_before_domain_wrap() {
    for (prefix, wide, _) in prefixes() {
        for opcode in [0xf6, 0xf7] {
            for selector in 4..8 {
                let mut bytes = prefix.clone();
                bytes.extend([opcode, 0x84 | selector << 3, 0xad, 0, 0, 0, 0x80]);
                assert_required_bytes(&bytes);
            }
        }
        for opcode in [&[0x0f, 0xaf][..], &[0x69][..], &[0x6b][..]] {
            let mut bytes = prefix.clone();
            bytes.extend(opcode);
            bytes.extend([0x84, 0xad, 0, 0, 0, 0x80]);
            let immediate_bytes = match opcode {
                [0x69] if wide == Width::W16 => 2,
                [0x69] => 4,
                [0x6b] => 1,
                _ => 0,
            };
            bytes.extend(std::iter::repeat_n(0xff, immediate_bytes));
            assert_required_bytes(&bytes);
        }
    }
}

#[test]
fn imul_immediates_keep_their_width_limited_signed_patterns() {
    for (prefix, width, _) in prefixes() {
        for (byte, value) in [
            (0, 0),
            (0x7f, 0x7f),
            (0x80, 0xffff_ffff_ffff_ff80),
            (0xff, u64::MAX),
        ] {
            let mut bytes = prefix.clone();
            bytes.extend([0x6b, 0xc1, byte]);
            assert!(matches!(
                operation(&bytes),
                Operation::Imul { immediate: Some(actual), .. } if actual == value & width.mask()
            ));
        }
        for (value, expected) in [
            (0, 0),
            (0x7fff_ffff, 0x7fff_ffff),
            (0x8000_0000, 0xffff_ffff_8000_0000),
            (u32::MAX, u64::MAX),
        ] {
            let mut bytes = prefix.clone();
            bytes.extend([0x69, 0xc1]);
            let raw = value.to_le_bytes();
            bytes.extend(&raw[..if width == Width::W16 { 2 } else { 4 }]);
            assert!(matches!(
                operation(&bytes),
                Operation::Imul { immediate: Some(actual), .. } if actual == expected & width.mask()
            ));
        }
    }
}

#[test]
fn excluded_group_one_still_stops_before_every_hypothetical_address_tail() {
    for (prefix, _, _) in prefixes() {
        for opcode in [0xf6, 0xf7] {
            for mode in 0..4 {
                let mut bytes = prefix.clone();
                bytes.extend([opcode, mode << 6 | 0x0c]);
                let pc = u64::MAX - bytes.len() as u64 + 1;
                let mut reads = Vec::new();
                assert_eq!(
                    decode(pc, |address| {
                        reads.push(address);
                        bytes
                            .get(address.wrapping_sub(pc) as usize)
                            .copied()
                            .ok_or_else(|| missing(address))
                    }),
                    Err(DecodeError::Unsupported),
                    "{bytes:02x?}"
                );
                assert_eq!(
                    reads,
                    (0..bytes.len()).map(|i| pc + i as u64).collect::<Vec<_>>()
                );
            }
        }
    }
}

#[test]
fn new_forms_keep_unsupported_prefix_frontiers_without_requesting_an_opcode() {
    for prefix in [
        &[0x26][..],
        &[0x2e][..],
        &[0x36][..],
        &[0x3e][..],
        &[0x64][..],
        &[0x65][..],
        &[0x67][..],
        &[0xf0][..],
        &[0xf2][..],
        &[0xf3][..],
        &[0x66, 0x66][..],
        &[0x48, 0x66][..],
        &[0x48, 0x49][..],
        &[0x66, 0x48, 0x49][..],
    ] {
        for suffix in [
            &[0xf6, 0xe4][..],
            &[0x0f, 0xaf, 0xc1][..],
            &[0x69, 0xc1][..],
        ] {
            let bytes = [prefix, suffix].concat();
            let mut reads = Vec::new();
            assert_eq!(
                decode(0x1000, |address| {
                    reads.push(address);
                    assert!(address < 0x1000 + prefix.len() as u64);
                    Ok(bytes[(address - 0x1000) as usize])
                }),
                Err(DecodeError::Unsupported),
                "{bytes:02x?}"
            );
            assert_eq!(reads.len(), prefix.len());
        }
    }
}

#[test]
fn required_fetches_preserve_the_memory_owners_complete_fault() {
    let bytes = [0x66, 0x4f, 0x69, 0x84, 0xad, 0, 0, 0, 0x80, 0, 0, 0, 0x80];
    for length in 0..bytes.len() {
        let denied = Fault {
            address: 0x9000,
            width: 17,
            access: Access::Execute,
            cause: Cause::Permission,
            failing: 0x9005,
        };
        assert_eq!(
            decode(0x1000, |address| {
                bytes[..length]
                    .get((address - 0x1000) as usize)
                    .copied()
                    .ok_or(denied)
            }),
            Err(DecodeError::Fetch(denied))
        );
    }
}
