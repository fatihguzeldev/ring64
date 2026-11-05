use super::{at, missing, operation};
use crate::memory::{Access, Cause, Fault};
use crate::x86::decode::{self, DecodeError};
use crate::x86::instruction::{Address, AddressBase, AddressIndex, Operation, Width};

use AddressBase::{NextPc, None as NoBase, Register};
use Width::{W32, W64};

fn address(base: AddressBase, index: Option<(u8, u8)>, displacement: i64) -> Address {
    Address {
        base,
        index: index.map(|(register, scale)| AddressIndex { register, scale }),
        displacement,
    }
}

fn load(dst: u8, width: Width, address: Address) -> Operation {
    Operation::Load {
        dst,
        width,
        address,
    }
}

fn store(src: u8, width: Width, address: Address) -> Operation {
    Operation::Store {
        src,
        width,
        address,
    }
}

#[test]
fn sib_literals_keep_extended_base_index_source_and_signed_displacements() {
    for (bytes, expected) in [
        (
            &[0x48, 0x8b, 0x04, 0x24][..],
            load(0, W64, address(Register(4), None, 0)),
        ),
        (
            &[0x49, 0x8b, 0x04, 0x24][..],
            load(0, W64, address(Register(12), None, 0)),
        ),
        (
            &[0x4b, 0x8b, 0x04, 0x24][..],
            load(0, W64, address(Register(12), Some((12, 1)), 0)),
        ),
        (
            &[0x47, 0x89, 0x44, 0x8c, 0xf0][..],
            store(8, W32, address(Register(12), Some((9, 4)), -16)),
        ),
        (
            &[0x42, 0x8b, 0x04, 0x0d, 0xfc, 0xff, 0xff, 0xff][..],
            load(0, W32, address(NoBase, Some((9, 1)), -4)),
        ),
        (
            &[0x89, 0x0c, 0x8b][..],
            store(1, W32, address(Register(3), Some((1, 4)), 0)),
        ),
        (
            &[0x48, 0x8b, 0x84, 0x8b, 0, 0, 0, 0x80][..],
            load(0, W64, address(Register(3), Some((1, 4)), i32::MIN.into())),
        ),
        (
            &[0x48, 0x89, 0x84, 0x8b, 0xff, 0xff, 0xff, 0x7f][..],
            store(0, W64, address(Register(3), Some((1, 4)), i32::MAX.into())),
        ),
    ] {
        assert_eq!(operation(bytes), expected, "{bytes:02x?}");
    }
}

#[test]
fn sib_scales_and_all_encodable_register_banks_are_distinct() {
    for (sib, scale) in [(0x0b, 1), (0x4b, 2), (0x8b, 4), (0xcb, 8)] {
        assert_eq!(
            operation(&[0x48, 0x8b, 0x04, sib]),
            load(0, W64, address(Register(3), Some((1, scale)), 0))
        );
    }
    for base in 0..16 {
        let mode = u8::from(base & 7 == 5);
        let mut bytes = vec![0x48 | (base >> 3), 0x8b, (mode << 6) | 4, 0x20 | (base & 7)];
        if mode == 1 {
            bytes.push(0);
        }
        assert_eq!(
            operation(&bytes),
            load(0, W64, address(Register(base), None, 0))
        );
    }
    for index in (0..16).filter(|&register| register != 4) {
        let bytes = [
            0x48 | ((index >> 3) << 1),
            0x8b,
            0x04,
            0x83 | ((index & 7) << 3),
        ];
        assert_eq!(
            operation(&bytes),
            load(0, W64, address(Register(3), Some((index, 4)), 0))
        );
    }
    for (prefix, dst, width) in [
        (0x40, 0, W32),
        (0x44, 8, W32),
        (0x48, 0, W64),
        (0x4c, 8, W64),
    ] {
        assert_eq!(
            operation(&[prefix, 0x8b, 0x04, 0x0b]),
            load(dst, width, address(Register(3), Some((1, 1)), 0))
        );
    }
}

#[test]
fn sib_absent_base_and_index_use_different_rex_rules() {
    for (prefix, index) in [
        (0x48, None),
        (0x49, None),
        (0x4a, Some(12)),
        (0x4b, Some(12)),
    ] {
        for (sib, scale) in [(0x25, 1), (0x65, 2), (0xa5, 4), (0xe5, 8)] {
            assert_eq!(
                operation(&[prefix, 0x8b, 0x04, sib, 0xfc, 0xff, 0xff, 0xff]),
                load(
                    0,
                    W64,
                    address(NoBase, index.map(|register| (register, scale)), -4)
                )
            );
        }
    }
    for (prefix, base) in [(0x48, 5), (0x49, 13)] {
        for (modrm, displacement, expected) in [
            (0x44, &[0x80][..], -128),
            (0x44, &[0x7f][..], 127),
            (0x84, &[0, 0, 0, 0x80][..], i32::MIN.into()),
            (0x84, &[0xff, 0xff, 0xff, 0x7f][..], i32::MAX.into()),
        ] {
            let mut bytes = vec![prefix, 0x8b, modrm, 0x25];
            bytes.extend_from_slice(displacement);
            assert_eq!(
                operation(&bytes),
                load(0, W64, address(Register(base), None, expected))
            );
        }
    }
}

#[test]
fn rip_relative_forms_ignore_rex_base_and_index_fields_and_keep_complete_next_pc() {
    for (prefix, register, width) in [
        (0x40, 0, W32),
        (0x41, 0, W32),
        (0x42, 0, W32),
        (0x43, 0, W32),
        (0x44, 8, W32),
        (0x45, 8, W32),
        (0x46, 8, W32),
        (0x47, 8, W32),
        (0x48, 0, W64),
        (0x49, 0, W64),
        (0x4a, 0, W64),
        (0x4b, 0, W64),
        (0x4c, 8, W64),
        (0x4d, 8, W64),
        (0x4e, 8, W64),
        (0x4f, 8, W64),
    ] {
        for (opcode, expected) in [
            (0x8b, load(register, width, address(NextPc, None, -4))),
            (0x89, store(register, width, address(NextPc, None, -4))),
        ] {
            let bytes = [prefix, opcode, 0x05, 0xfc, 0xff, 0xff, 0xff];
            assert_eq!(operation(&bytes), expected);
            let last = at(u64::MAX - 6, &bytes).unwrap();
            assert_eq!(last.next_pc, 0);
            assert_eq!(last.operation, expected);
        }
    }
    assert_eq!(
        operation(&[0x8b, 0x05, 0, 0, 0, 0]),
        load(0, W32, address(NextPc, None, 0))
    );
}

#[test]
fn every_required_sib_and_displacement_byte_keeps_its_fetch_failure() {
    for bytes in [
        &[0x48, 0x8b, 0x04, 0x8b][..],
        &[0x48, 0x8b, 0x44, 0x8b, 0x80][..],
        &[0x48, 0x8b, 0x84, 0x8b, 0, 0, 0, 0x80][..],
        &[0x49, 0x8b, 0x04, 0x25, 0xfc, 0xff, 0xff, 0xff][..],
        &[0x49, 0x89, 0x05, 0xfc, 0xff, 0xff, 0xff][..],
    ] {
        for length in 0..bytes.len() {
            assert_eq!(
                at(0x1000, &bytes[..length]),
                Err(DecodeError::Fetch(missing(0x1000 + length as u64))),
                "{bytes:02x?} truncated to {length}"
            );
        }
    }
    let bytes = [0x48, 0x8b, 0x84, 0x8b, 0, 0, 0, 0x80];
    for length in 3..bytes.len() {
        let pc = u64::MAX - length as u64 + 1;
        assert_eq!(
            at(pc, &bytes[..length]),
            Err(DecodeError::Fetch(Fault {
                address: pc,
                width: length as u32 + 1,
                access: Access::Execute,
                cause: Cause::AddressRange,
                failing: 1u128 << 64,
            }))
        );
    }
    let denied = Fault {
        address: 0x1003,
        width: 1,
        access: Access::Execute,
        cause: Cause::Permission,
        failing: 0x1003,
    };
    assert_eq!(
        decode::decode(0x1000, |pc| {
            [0x48, 0x8b, 0x04]
                .get((pc - 0x1000) as usize)
                .copied()
                .ok_or(denied)
        }),
        Err(DecodeError::Fetch(denied))
    );
}

#[test]
fn new_address_forms_do_not_admit_other_prefixes_or_memory_arithmetic() {
    for bytes in [
        &[0x66, 0x48, 0x8b, 0x04][..],
        &[0x67, 0x8b, 0x04][..],
        &[0xf0, 0x8b, 0x04][..],
        &[0xf2, 0x8b, 0x04][..],
        &[0xf3, 0x8b, 0x04][..],
        &[0x01, 0x04][..],
        &[0x29, 0x04][..],
        &[0x39, 0x04][..],
        &[0x83, 0x04][..],
    ] {
        assert_eq!(at(0x1000, bytes), Err(DecodeError::Unsupported));
    }
}
