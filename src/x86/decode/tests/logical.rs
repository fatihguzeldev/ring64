use super::{at, missing, operation};
use crate::memory::{Access, Cause, Fault};
use crate::x86::decode::{self, DecodeError};
use crate::x86::instruction::{Alu, DataOperand as Operand, Operation, RegisterView, Width};

use Alu::{And, Or, Test, Xor};
use Operand::{Immediate, Register};
use Width::{W32, W64};

fn alu(kind: Alu, dst: u8, src: Operand, width: Width) -> Operation {
    Operation::Alu {
        kind,
        dst: RegisterView::low(dst),
        src,
        width,
    }
}

#[test]
fn register_logical_literals_are_admitted_with_complete_instruction_boundaries() {
    for (bytes, expected) in [
        (
            &[0x45, 0x21, 0xc8][..],
            alu(And, 8, Register(RegisterView::low(9)), W32),
        ),
        (
            &[0x45, 0x23, 0xc1][..],
            alu(And, 8, Register(RegisterView::low(9)), W32),
        ),
        (
            &[0x4d, 0x09, 0xc8][..],
            alu(Or, 8, Register(RegisterView::low(9)), W64),
        ),
        (
            &[0x4d, 0x0b, 0xc1][..],
            alu(Or, 8, Register(RegisterView::low(9)), W64),
        ),
        (
            &[0x4d, 0x31, 0xc8][..],
            alu(Xor, 8, Register(RegisterView::low(9)), W64),
        ),
        (
            &[0x4d, 0x33, 0xc1][..],
            alu(Xor, 8, Register(RegisterView::low(9)), W64),
        ),
        (
            &[0x85, 0xc0][..],
            alu(Test, 0, Register(RegisterView::low(0)), W32),
        ),
        (
            &[0x45, 0x85, 0xc0][..],
            alu(Test, 8, Register(RegisterView::low(8)), W32),
        ),
        (&[0x48, 0x83, 0xc8, 0][..], alu(Or, 0, Immediate(0), W64)),
        (
            &[0x48, 0x83, 0xe0, 0x80][..],
            alu(And, 0, Immediate(0xffff_ffff_ffff_ff80), W64),
        ),
        (
            &[0x48, 0x83, 0xf0, 0xff][..],
            alu(Xor, 0, Immediate(u64::MAX), W64),
        ),
        (
            &[0x48, 0x81, 0xe0, 0, 0, 0, 0x80][..],
            alu(And, 0, Immediate(0xffff_ffff_8000_0000), W64),
        ),
        (
            &[0x48, 0x81, 0xc8, 0, 0, 0, 0x80][..],
            alu(Or, 0, Immediate(0xffff_ffff_8000_0000), W64),
        ),
        (
            &[0x48, 0x81, 0xf0, 0xff, 0xff, 0xff, 0xff][..],
            alu(Xor, 0, Immediate(u64::MAX), W64),
        ),
        (
            &[0x4f, 0xf7, 0xc0, 0, 0, 0, 0x80][..],
            alu(Test, 8, Immediate(0xffff_ffff_8000_0000), W64),
        ),
    ] {
        assert_eq!(operation(bytes), expected, "{bytes:02x?}");
        let last = at(u64::MAX - bytes.len() as u64 + 1, bytes).unwrap();
        assert_eq!(last.next_pc, 0, "{bytes:02x?}");
        assert_eq!(last.operation, expected, "{bytes:02x?}");
    }
}

#[test]
fn logical_register_directions_keep_all_banks_aliases_and_ignored_rex_x() {
    for (opcode, reg_destination, kind) in [
        (0x21, false, And),
        (0x23, true, And),
        (0x09, false, Or),
        (0x0b, true, Or),
        (0x31, false, Xor),
        (0x33, true, Xor),
        (0x85, false, Test),
    ] {
        for (width, width_bit) in [(W32, 0), (W64, 8)] {
            for dst in 0..16 {
                for src in [dst, (dst + 5) & 15] {
                    let (reg, rm) = if reg_destination {
                        (dst, src)
                    } else {
                        (src, dst)
                    };
                    let rex = 0x40 | width_bit | ((reg >> 3) << 2) | (rm >> 3);
                    let modrm = 0xc0 | ((reg & 7) << 3) | (rm & 7);
                    for ignored_x in [0, 2] {
                        assert_eq!(
                            operation(&[rex | ignored_x, opcode, modrm]),
                            alu(kind, dst, Register(RegisterView::low(src)), width)
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn logical_immediate_groups_keep_raw_selectors_and_signed_width_patterns() {
    let groups = [(4, And), (1, Or), (6, Xor)];
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
                    for dst in 0..16 {
                        for ignored_rx in [0, 2, 4, 6] {
                            let rex = 0x40 | width_bit | (dst >> 3) | ignored_rx;
                            let modrm = 0xc0 | (selector << 3) | (dst & 7);
                            let mut bytes = vec![rex, opcode, modrm];
                            bytes.extend_from_slice(raw);
                            assert_eq!(
                                operation(&bytes),
                                alu(kind, dst, Immediate(expected), width),
                                "{bytes:02x?}"
                            );
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn logical_modrm_and_immediates_keep_the_first_required_byte_failure() {
    for bytes in [
        &[0x21, 0xc8][..],
        &[0x4f, 0x33, 0xc1][..],
        &[0x48, 0x83, 0xe0, 0x80][..],
        &[0x48, 0x81, 0xc8, 0, 0, 0, 0x80][..],
        &[0x4f, 0xf7, 0xc0, 0, 0, 0, 0x80][..],
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
    let denied = Fault {
        address: 0x1004,
        width: 1,
        access: Access::Execute,
        cause: Cause::Permission,
        failing: 0x1004,
    };
    assert_eq!(
        decode::decode(0x1000, |pc| {
            [0x48, 0xf7, 0xc0, 0x80]
                .get((pc - 0x1000) as usize)
                .copied()
                .ok_or(denied)
        }),
        Err(DecodeError::Fetch(denied))
    );
}

#[test]
fn unsupported_logical_selectors_do_not_request_operand_tails() {
    let mut packets = Vec::new();
    for selector in [1, 4, 5, 6, 7] {
        packets.push(vec![0x4f, 0xf7, 0xc0 | (selector << 3)]);
    }
    for bytes in packets {
        let pc = u64::MAX - bytes.len() as u64 + 1;
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
        assert_eq!(
            reads,
            (0..bytes.len())
                .map(|offset| pc + offset as u64)
                .collect::<Vec<_>>(),
            "{bytes:02x?}"
        );
    }
}

#[test]
fn logical_extensions_admit_byte_and_accumulator_forms_but_keep_other_prefixes_unsupported() {
    for prefix in [0x67, 0x26, 0x2e, 0x36, 0x3e, 0x64, 0x65, 0xf0, 0xf2, 0xf3] {
        assert_eq!(
            at(0x1000, &[prefix, 0x45, 0x21, 0xc8]),
            Err(DecodeError::Unsupported)
        );
    }
    for opcode in [0x20, 0x22, 0x08, 0x0a, 0x30, 0x32, 0x84, 0x80, 0xf6] {
        assert!(matches!(
            at(0x1000, &[0x4f, opcode, 0xc0, 0xff]).unwrap().operation,
            Operation::Alu {
                width: Width::W8,
                ..
            }
        ));
    }
    for opcode in [0x25, 0x0d, 0x35, 0xa9] {
        for prefix in [None, Some(0x48)] {
            let mut bytes = prefix.into_iter().collect::<Vec<_>>();
            bytes.extend([opcode, 0, 0, 0, 0]);
            let kind = match opcode {
                0x25 => And,
                0x0d => Or,
                0x35 => Xor,
                0xa9 => Test,
                _ => unreachable!(),
            };
            assert_eq!(
                operation(&bytes),
                alu(
                    kind,
                    0,
                    Immediate(0),
                    if prefix.is_some() { W64 } else { W32 }
                )
            );
        }
    }
    assert_eq!(
        at(0x1000, &[0x48, 0x49, 0x21, 0xc0]),
        Err(DecodeError::Unsupported)
    );
}
