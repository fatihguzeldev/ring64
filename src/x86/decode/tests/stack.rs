use super::{at, missing, operation};
use crate::memory::{Access, Cause, Fault};
use crate::x86::decode::{self, DecodeError};
use crate::x86::instruction::{Instruction, Operand, Operation};

use Operand::{Immediate, Register};
use Operation::{Call, JumpRegister, Pop, Push, Return};

#[test]
fn stack_and_near_transfer_literals_require_their_complete_encodings() {
    for (bytes, expected) in [
        (&[0x50][..], Push { src: Register(0) }),
        (&[0x54][..], Push { src: Register(4) }),
        (&[0x4f, 0x54][..], Push { src: Register(12) }),
        (&[0x58][..], Pop { dst: 0 }),
        (&[0x5c][..], Pop { dst: 4 }),
        (&[0x4f, 0x5c][..], Pop { dst: 12 }),
        (
            &[0x4f, 0x6a, 0x80][..],
            Push {
                src: Immediate(0xffff_ffff_ffff_ff80),
            },
        ),
        (
            &[0x47, 0x68, 0, 0, 0, 0x80][..],
            Push {
                src: Immediate(0xffff_ffff_8000_0000),
            },
        ),
        (
            &[0xe8, 0x0b, 0, 0, 0][..],
            Call {
                target: Immediate(0x1010),
            },
        ),
        (
            &[0x4f, 0xe8, 0, 0, 0, 0][..],
            Call {
                target: Immediate(0x1006),
            },
        ),
        (
            &[0xff, 0xd0][..],
            Call {
                target: Register(0),
            },
        ),
        (
            &[0x47, 0xff, 0xd4][..],
            Call {
                target: Register(12),
            },
        ),
        (&[0x47, 0xff, 0xe4][..], JumpRegister { target: 12 }),
        (&[0xc3][..], Return { cleanup: 0 }),
        (&[0x4f, 0xc2, 0, 0x80][..], Return { cleanup: 0x8000 }),
    ] {
        assert_eq!(operation(bytes), expected, "{bytes:02x?}");
    }
}

#[test]
fn stack_registers_and_indirect_targets_use_rex_b_for_every_bank() {
    for prefix in std::iter::once(None).chain((0x40..=0x4f).map(Some)) {
        for low in 0..8 {
            let register = low | prefix.map_or(0, |rex| (rex & 1) << 3);
            for (tail, expected) in [
                (
                    vec![0x50 + low],
                    Push {
                        src: Register(register),
                    },
                ),
                (vec![0x58 + low], Pop { dst: register }),
                (
                    vec![0xff, 0xd0 | low],
                    Call {
                        target: Register(register),
                    },
                ),
                (vec![0xff, 0xe0 | low], JumpRegister { target: register }),
            ] {
                let mut bytes: Vec<_> = prefix.into_iter().collect();
                bytes.extend(tail);
                assert_eq!(operation(&bytes), expected, "{bytes:02x?}");
            }
        }
    }
}

#[test]
fn push_immediates_sign_extend_to_64_bits_independently_of_every_rex_field() {
    for (opcode, raw, expected) in [
        (0x6a, &[0][..], 0),
        (0x6a, &[0x7f][..], 0x7f),
        (0x6a, &[0x80][..], 0xffff_ffff_ffff_ff80),
        (0x6a, &[0xff][..], u64::MAX),
        (0x68, &[0, 0, 0, 0][..], 0),
        (0x68, &[0xff, 0xff, 0xff, 0x7f][..], 0x7fff_ffff),
        (0x68, &[0, 0, 0, 0x80][..], 0xffff_ffff_8000_0000),
        (0x68, &[0xff, 0xff, 0xff, 0xff][..], u64::MAX),
    ] {
        for prefix in std::iter::once(None).chain((0x40..=0x4f).map(Some)) {
            let mut bytes: Vec<_> = prefix.into_iter().collect();
            bytes.push(opcode);
            bytes.extend_from_slice(raw);
            assert_eq!(
                operation(&bytes),
                Push {
                    src: Immediate(expected)
                },
                "{bytes:02x?}"
            );
        }
    }
}

#[test]
fn relative_calls_add_signed_rel32_to_the_complete_next_pc() {
    for (raw, unprefixed, prefixed) in [
        ([0, 0, 0, 0], 0x1005, 0x1006),
        ([0xff, 0xff, 0xff, 0x7f], 0x8000_1004, 0x8000_1005),
        (
            [0, 0, 0, 0x80],
            0xffff_ffff_8000_1005,
            0xffff_ffff_8000_1006,
        ),
        ([0xff, 0xff, 0xff, 0xff], 0x1004, 0x1005),
        ([0xfb, 0xff, 0xff, 0xff], 0x1000, 0x1001),
    ] {
        for prefix in std::iter::once(None).chain((0x40..=0x4f).map(Some)) {
            let mut bytes: Vec<_> = prefix.into_iter().collect();
            bytes.push(0xe8);
            bytes.extend(raw);
            assert_eq!(
                operation(&bytes),
                Call {
                    target: Immediate(if prefix.is_some() {
                        prefixed
                    } else {
                        unprefixed
                    })
                },
                "{bytes:02x?}"
            );
        }
    }
    for (pc, bytes, next, target) in [
        (
            0x1_0000_1000,
            &[0x4f, 0xe8, 0, 0, 0, 0][..],
            0x1_0000_1006,
            0x1_0000_1006,
        ),
        (
            0xffff_8000_0000_1000,
            &[0xe8, 0x0b, 0, 0, 0][..],
            0xffff_8000_0000_1005,
            0xffff_8000_0000_1010,
        ),
        (
            0x7fff_ffff_fff0,
            &[0xe8, 0x0b, 0, 0, 0][..],
            0x7fff_ffff_fff5,
            0x8000_0000_0000,
        ),
        (0, &[0xe8, 0xfa, 0xff, 0xff, 0xff][..], 5, u64::MAX),
        (u64::MAX - 4, &[0xe8, 0, 0, 0, 0][..], 0, 0),
        (u64::MAX - 5, &[0x4f, 0xe8, 0, 0, 0, 0][..], 0, 0),
    ] {
        assert_eq!(
            at(pc, bytes).unwrap(),
            Instruction {
                pc,
                next_pc: next,
                operation: Call {
                    target: Immediate(target)
                }
            },
            "{bytes:02x?} at {pc:x}"
        );
    }
}

#[test]
fn return_cleanup_is_unsigned_16_bit_and_never_rex_width_dependent() {
    for prefix in std::iter::once(None).chain((0x40..=0x4f).map(Some)) {
        let mut plain: Vec<_> = prefix.into_iter().collect();
        plain.push(0xc3);
        assert_eq!(operation(&plain), Return { cleanup: 0 });
        for (raw, expected) in [
            ([0, 0], 0),
            ([0xff, 0x7f], 0x7fff),
            ([0, 0x80], 0x8000),
            ([0xff, 0xff], 0xffff),
        ] {
            let mut bytes: Vec<_> = prefix.into_iter().collect();
            bytes.push(0xc2);
            bytes.extend(raw);
            assert_eq!(
                operation(&bytes),
                Return { cleanup: expected },
                "{bytes:02x?}"
            );
        }
    }
}

#[test]
fn admitted_stack_tails_report_the_first_required_byte_failure() {
    for prefix in std::iter::once(None).chain((0x40..=0x4f).map(Some)) {
        for tail in [
            &[0x50][..],
            &[0x58][..],
            &[0x6a, 0x80][..],
            &[0x68, 0, 0, 0, 0x80][..],
            &[0xe8, 0, 0, 0, 0][..],
            &[0xff, 0xd4][..],
            &[0xff, 0xe4][..],
            &[0xc3][..],
            &[0xc2, 0, 0x80][..],
        ] {
            let mut bytes: Vec<_> = prefix.into_iter().collect();
            bytes.extend_from_slice(tail);
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
            assert_eq!(at(pc, &bytes).unwrap().next_pc, 0, "{bytes:02x?}");
        }
    }
}

#[test]
fn required_stack_immediate_bytes_keep_the_memory_owners_fault_metadata() {
    for bytes in [
        &[0x4f, 0x6a, 0x80][..],
        &[0x47, 0x68, 0, 0, 0, 0x80][..],
        &[0x4f, 0xe8, 0, 0, 0, 0][..],
        &[0x4f, 0xc2, 0, 0x80][..],
    ] {
        let denied = Fault {
            address: 0x1000 + bytes.len() as u64 - 1,
            width: 1,
            access: Access::Execute,
            cause: Cause::Permission,
            failing: 0x1000 + bytes.len() as u128 - 1,
        };
        let mut reads = Vec::new();
        let decoded = decode::decode(0x1000, |pc| {
            reads.push(pc);
            if pc == denied.address {
                Err(denied)
            } else {
                Ok(bytes[(pc - 0x1000) as usize])
            }
        });
        assert_eq!(decoded, Err(DecodeError::Fetch(denied)));
        assert_eq!(reads, (0x1000..=denied.address).collect::<Vec<_>>());
    }
}

#[test]
fn unsupported_ff_forms_stop_at_modrm_without_fetching_an_address() {
    for prefix in std::iter::once(None).chain((0x40..=0x4f).map(Some)) {
        for modrm in 0..=255 {
            let selector = (modrm >> 3) & 7;
            if selector <= 1 || (modrm >> 6 == 3 && matches!(selector, 2 | 4)) {
                continue;
            }
            let mut bytes: Vec<_> = prefix.into_iter().collect();
            bytes.extend([0xff, modrm]);
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
            assert_eq!(reads, (pc..=u64::MAX).collect::<Vec<_>>());
        }
    }
}

#[test]
fn alternate_pop_encodings_remain_unsupported_without_a_modrm_fetch() {
    for prefix in std::iter::once(None).chain((0x40..=0x4f).map(Some)) {
        let mut bytes: Vec<_> = prefix.into_iter().collect();
        bytes.push(0x8f);
        let pc = u64::MAX - bytes.len() as u64 + 1;
        assert_eq!(at(pc, &bytes), Err(DecodeError::Unsupported));
        bytes.push(0xc4);
        let mut reads = Vec::new();
        let decoded = decode::decode(0x1000, |address| {
            reads.push(address);
            Ok(bytes[(address - 0x1000) as usize])
        });
        assert_eq!(decoded, Err(DecodeError::Unsupported));
        assert_eq!(reads.len(), bytes.len() - 1);
    }
}

#[test]
fn stack_admission_keeps_legacy_prefixes_and_old_branch_prefixes_outside_coverage() {
    for tail in [
        &[0x50][..],
        &[0x58][..],
        &[0x6a, 0x80][..],
        &[0x68, 0, 0, 0, 0x80][..],
        &[0xe8, 0, 0, 0, 0][..],
        &[0xff, 0xd0][..],
        &[0xff, 0xe0][..],
        &[0xc3][..],
        &[0xc2, 0, 0x80][..],
    ] {
        for prefix in [
            0x66, 0x67, 0x26, 0x2e, 0x36, 0x3e, 0x64, 0x65, 0xf0, 0xf2, 0xf3,
        ] {
            let mut bytes = vec![prefix, 0x4f];
            bytes.extend_from_slice(tail);
            assert_eq!(at(0x1000, &bytes), Err(DecodeError::Unsupported));
        }
        let mut bytes = vec![0x48, 0x4f];
        bytes.extend_from_slice(tail);
        assert_eq!(at(0x1000, &bytes), Err(DecodeError::Unsupported));
    }
    for prefix in 0x40..=0x4f {
        for tail in [
            &[0xeb, 0][..],
            &[0xe9, 0, 0, 0, 0][..],
            &[0x75, 0][..],
            &[0x0f, 0x85, 0, 0, 0, 0][..],
        ] {
            let mut bytes = vec![prefix];
            bytes.extend_from_slice(tail);
            assert_eq!(at(0x1000, &bytes), Err(DecodeError::Unsupported));
        }
    }
}
