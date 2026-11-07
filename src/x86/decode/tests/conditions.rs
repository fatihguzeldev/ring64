use super::{at, missing, operation};
use crate::memory::{Access, Cause, Fault};
use crate::x86::decode::{self, DecodeError};
use crate::x86::instruction::{Condition, Operation};

const CONDITIONS: [(u8, u8, Condition); 16] = [
    (0x70, 0x80, Condition::Overflow),
    (0x71, 0x81, Condition::NotOverflow),
    (0x72, 0x82, Condition::Below),
    (0x73, 0x83, Condition::AboveOrEqual),
    (0x74, 0x84, Condition::Equal),
    (0x75, 0x85, Condition::NotEqual),
    (0x76, 0x86, Condition::BelowOrEqual),
    (0x77, 0x87, Condition::Above),
    (0x78, 0x88, Condition::Sign),
    (0x79, 0x89, Condition::NotSign),
    (0x7a, 0x8a, Condition::Parity),
    (0x7b, 0x8b, Condition::NotParity),
    (0x7c, 0x8c, Condition::Less),
    (0x7d, 0x8d, Condition::GreaterOrEqual),
    (0x7e, 0x8e, Condition::LessOrEqual),
    (0x7f, 0x8f, Condition::Greater),
];

#[test]
fn all_short_and_near_conditions_decode_to_their_named_predicate() {
    for (short, near, condition) in CONDITIONS {
        for bytes in [vec![short, 0x0e], vec![0x0f, near, 0x0a, 0, 0, 0]] {
            assert_eq!(
                operation(&bytes),
                Operation::Jcc {
                    condition,
                    target: 0x1010,
                },
                "{bytes:02x?}"
            );
            let high = at(0xffff_8000_0000_1000, &bytes).unwrap();
            assert_eq!(high.pc, 0xffff_8000_0000_1000);
            assert_eq!(high.next_pc, high.pc + bytes.len() as u64);
            assert_eq!(
                high.operation,
                Operation::Jcc {
                    condition,
                    target: 0xffff_8000_0000_1010,
                }
            );
        }
    }
    assert_eq!(
        operation(&[0x7c, 2]),
        Operation::Jcc {
            condition: Condition::Less,
            target: 0x1004,
        }
    );
    assert_eq!(
        at(0x1002, &[0x72, 2]).unwrap().operation,
        Operation::Jcc {
            condition: Condition::Below,
            target: 0x1006,
        }
    );
}

#[test]
fn every_jcc_sign_extends_its_own_displacement_after_the_complete_instruction() {
    for (short, near, condition) in CONDITIONS {
        for (raw, target) in [(0, 0x1002), (0x7f, 0x1081), (0x80, 0x0f82), (0xff, 0x1001)] {
            assert_eq!(
                operation(&[short, raw]),
                Operation::Jcc { condition, target }
            );
        }
        for (raw, target) in [
            ([0, 0, 0, 0], 0x1006),
            ([0xff, 0xff, 0xff, 0x7f], 0x8000_1005),
            ([0, 0, 0, 0x80], 0xffff_ffff_8000_1006),
            ([0xff, 0xff, 0xff, 0xff], 0x1005),
            ([0xfa, 0xff, 0xff, 0xff], 0x1000),
        ] {
            let mut bytes = vec![0x0f, near];
            bytes.extend(raw);
            assert_eq!(operation(&bytes), Operation::Jcc { condition, target });
        }
        for (bytes, target) in [
            (vec![short, 0], 0),
            (vec![short, 0xff], u64::MAX),
            (vec![0x0f, near, 0, 0, 0, 0], 0),
            (vec![0x0f, near, 1, 0, 0, 0], 1),
        ] {
            let last = at(u64::MAX - bytes.len() as u64 + 1, &bytes).unwrap();
            assert_eq!(last.next_pc, 0);
            assert_eq!(last.operation, Operation::Jcc { condition, target });
        }
        let unvalidated = at(0x7fff_ffff_fff0, &[short, 0x0e]).unwrap();
        assert_eq!(
            unvalidated.operation,
            Operation::Jcc {
                condition,
                target: 0x8000_0000_0000,
            }
        );
    }
}

#[test]
fn every_jcc_requires_each_encoded_displacement_byte_without_wrapping_fetches() {
    for (short, near, _) in CONDITIONS {
        for bytes in [vec![short, 0x80], vec![0x0f, near, 0, 0, 0, 0x80]] {
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
            address: 0x1003,
            width: 1,
            access: Access::Execute,
            cause: Cause::Permission,
            failing: 0x1003,
        };
        assert_eq!(
            decode::decode(0x1000, |pc| {
                [0x0f, near, 0x08]
                    .get((pc - 0x1000) as usize)
                    .copied()
                    .ok_or(denied)
            }),
            Err(DecodeError::Fetch(denied))
        );
    }
}

#[test]
fn condition_coverage_keeps_lock_rep_and_other_branch_families_unsupported() {
    let prefixes = [0xf0, 0xf2, 0xf3];
    for prefix in prefixes {
        for (short, near, _) in CONDITIONS {
            assert_eq!(
                at(0x1000, &[prefix, short, 0]),
                Err(DecodeError::Unsupported)
            );
            assert_eq!(
                at(0x1000, &[prefix, 0x0f, near, 0, 0, 0, 0]),
                Err(DecodeError::Unsupported)
            );
        }
    }
    for opcode in [0xe0, 0xe1, 0xe2, 0xe3] {
        assert_eq!(at(0x1000, &[opcode, 0]), Err(DecodeError::Unsupported));
    }
    for second in (0x40..=0x4f).chain(0x90..=0x9f) {
        assert_eq!(
            at(0x1000, &[0x0f, second]),
            Err(DecodeError::Fetch(missing(0x1002)))
        );
    }
    assert_eq!(at(0x1000, &[0x0f, 0x7f]), Err(DecodeError::Unsupported));
}
