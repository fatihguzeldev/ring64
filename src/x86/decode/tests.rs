use crate::memory::{Access, Cause, Fault};

use super::{DecodeError, decode};
use crate::x86::instruction::{
    Address, AddressBase, Alu, Condition, DataOperand as Operand, Instruction, Operation,
    RegisterView, Width,
};

mod addressing;
mod arithmetic_bits;
mod conditions;
mod exchange;
mod far;
mod float;
mod integer_memory;
mod logical;
mod modes;
mod multiply_divide;
mod near_control;
mod numeric_state;
mod protection;
mod scalar_data;
mod stack;
mod streaming;
mod strings;
mod system_flags;
mod task;
mod vectors;
mod x87;

fn missing(address: u64) -> Fault {
    Fault {
        address,
        width: 1,
        access: Access::Execute,
        cause: Cause::Unmapped,
        failing: address.into(),
    }
}

fn at(pc: u64, bytes: &[u8]) -> Result<Instruction, DecodeError> {
    decode(pc, |address| {
        address
            .checked_sub(pc)
            .and_then(|offset| usize::try_from(offset).ok())
            .and_then(|offset| bytes.get(offset))
            .copied()
            .ok_or_else(|| missing(address))
    })
}

fn operation(bytes: &[u8]) -> Operation {
    let instruction = at(0x1000, bytes).unwrap();
    assert_eq!(instruction.pc, 0x1000);
    assert_eq!(instruction.next_pc, 0x1000 + bytes.len() as u64);
    instruction.operation
}

#[test]
fn immediate_moves_preserve_raw_bits_and_use_the_opcode_register_extension() {
    assert_eq!(
        operation(&[0xb8, 0xef, 0xcd, 0xab, 0x89]),
        Operation::Mov {
            dst: RegisterView::low(0),
            src: Operand::Immediate(0x89ab_cdef),
            width: Width::W32,
        }
    );
    assert_eq!(
        operation(&[0x41, 0xbf, 0xff, 0xff, 0xff, 0xff]),
        Operation::Mov {
            dst: RegisterView::low(15),
            src: Operand::Immediate(0xffff_ffff),
            width: Width::W32,
        }
    );
    assert_eq!(
        operation(&[0x4f, 0xb8, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11]),
        Operation::Mov {
            dst: RegisterView::low(8),
            src: Operand::Immediate(0x1122_3344_5566_7788),
            width: Width::W64,
        }
    );
}

#[test]
fn register_moves_decode_both_directions_and_default_width_with_rex() {
    for bytes in [&[0x89, 0xd0][..], &[0x8b, 0xc2][..]] {
        assert_eq!(
            operation(bytes),
            Operation::Mov {
                dst: RegisterView::low(0),
                src: Operand::Register(RegisterView::low(2)),
                width: Width::W32
            }
        );
    }
    assert_eq!(
        operation(&[0x45, 0x89, 0xc8]),
        Operation::Mov {
            dst: RegisterView::low(8),
            src: Operand::Register(RegisterView::low(9)),
            width: Width::W32
        }
    );
    assert_eq!(
        operation(&[0x4d, 0x8b, 0xc1]),
        Operation::Mov {
            dst: RegisterView::low(8),
            src: Operand::Register(RegisterView::low(9)),
            width: Width::W64
        }
    );
}

#[test]
fn register_arithmetic_decodes_each_operation_at_both_widths() {
    for (bytes, kind, width) in [
        (&[0x01, 0xd0][..], Alu::Add, Width::W32),
        (&[0x48, 0x01, 0xd0][..], Alu::Add, Width::W64),
        (&[0x29, 0xd0][..], Alu::Sub, Width::W32),
        (&[0x48, 0x29, 0xd0][..], Alu::Sub, Width::W64),
        (&[0x39, 0xd0][..], Alu::Cmp, Width::W32),
        (&[0x48, 0x39, 0xd0][..], Alu::Cmp, Width::W64),
    ] {
        assert_eq!(
            operation(bytes),
            Operation::Alu {
                kind,
                dst: RegisterView::low(0),
                src: Operand::Register(RegisterView::low(2)),
                width
            }
        );
    }
    assert_eq!(
        operation(&[0x45, 0x39, 0xc8]),
        Operation::Alu {
            kind: Alu::Cmp,
            dst: RegisterView::low(8),
            src: Operand::Register(RegisterView::low(9)),
            width: Width::W32,
        }
    );
}

#[test]
fn arithmetic_immediates_are_signed_to_the_operand_width() {
    for (bytes, kind, width, value) in [
        (
            &[0x81, 0xc0, 0xff, 0xff, 0xff, 0xff][..],
            Alu::Add,
            Width::W32,
            0xffff_ffff,
        ),
        (
            &[0x48, 0x81, 0xc0, 0xff, 0xff, 0xff, 0xff][..],
            Alu::Add,
            Width::W64,
            u64::MAX,
        ),
        (&[0x83, 0xe8, 0xff][..], Alu::Sub, Width::W32, 0xffff_ffff),
        (
            &[0x48, 0x83, 0xe8, 0xff][..],
            Alu::Sub,
            Width::W64,
            u64::MAX,
        ),
        (
            &[0x81, 0xf8, 0, 0, 0, 0x80][..],
            Alu::Cmp,
            Width::W32,
            0x8000_0000,
        ),
        (
            &[0x48, 0x81, 0xf8, 0, 0, 0, 0x80][..],
            Alu::Cmp,
            Width::W64,
            0xffff_ffff_8000_0000,
        ),
        (&[0x83, 0xc0, 0x80][..], Alu::Add, Width::W32, 0xffff_ff80),
        (&[0x48, 0x83, 0xc0, 0x7f][..], Alu::Add, Width::W64, 0x7f),
        (
            &[0x81, 0xe8, 0xff, 0xff, 0xff, 0x7f][..],
            Alu::Sub,
            Width::W32,
            0x7fff_ffff,
        ),
        (
            &[0x48, 0x81, 0xe8, 0xff, 0xff, 0xff, 0x7f][..],
            Alu::Sub,
            Width::W64,
            0x7fff_ffff,
        ),
        (&[0x83, 0xf8, 0xff][..], Alu::Cmp, Width::W32, 0xffff_ffff),
        (
            &[0x48, 0x83, 0xf8, 0xff][..],
            Alu::Cmp,
            Width::W64,
            u64::MAX,
        ),
    ] {
        assert_eq!(
            operation(bytes),
            Operation::Alu {
                kind,
                dst: RegisterView::low(0),
                src: Operand::Immediate(value),
                width
            }
        );
    }
}

#[test]
fn rex_r_does_not_extend_an_opcode_group_selector() {
    assert_eq!(
        operation(&[0x4c, 0x83, 0xc0, 1]),
        Operation::Alu {
            kind: Alu::Add,
            dst: RegisterView::low(0),
            src: Operand::Immediate(1),
            width: Width::W64,
        }
    );
    assert_eq!(
        operation(&[0x45, 0x81, 0xef, 0xff, 0xff, 0xff, 0xff]),
        Operation::Alu {
            kind: Alu::Sub,
            dst: RegisterView::low(15),
            src: Operand::Immediate(0xffff_ffff),
            width: Width::W32,
        }
    );
}

#[test]
fn memory_operands_keep_the_full_base_identity_and_signed_displacement() {
    assert_eq!(
        operation(&[0x8b, 3]),
        Operation::Load {
            dst: RegisterView::low(0),
            address: Address {
                base: AddressBase::Register(3),
                index: None,
                displacement: 0,
                ..Address::default()
            },
            width: Width::W32
        }
    );
    assert_eq!(
        operation(&[0x48, 0x89, 3]),
        Operation::Store {
            src: Operand::Register(RegisterView::low(0)),
            address: Address {
                base: AddressBase::Register(3),
                index: None,
                displacement: 0,
                ..Address::default()
            },
            width: Width::W64
        }
    );
    assert_eq!(
        operation(&[0x45, 0x8b, 0x45, 0]),
        Operation::Load {
            dst: RegisterView::low(8),
            address: Address {
                base: AddressBase::Register(13),
                index: None,
                displacement: 0,
                ..Address::default()
            },
            width: Width::W32
        }
    );
    assert_eq!(
        operation(&[0x4d, 0x89, 0x45, 0xfc]),
        Operation::Store {
            src: Operand::Register(RegisterView::low(8)),
            address: Address {
                base: AddressBase::Register(13),
                index: None,
                displacement: -4,
                ..Address::default()
            },
            width: Width::W64
        }
    );
    assert_eq!(
        operation(&[0x4a, 0x8b, 0x83, 0, 0, 0, 0x80]),
        Operation::Load {
            dst: RegisterView::low(0),
            address: Address {
                base: AddressBase::Register(3),
                index: None,
                displacement: -2_147_483_648,
                ..Address::default()
            },
            width: Width::W64
        }
    );
    assert_eq!(
        operation(&[0x89, 0xbd, 0xff, 0xff, 0xff, 0x7f]),
        Operation::Store {
            src: Operand::Register(RegisterView::low(7)),
            address: Address {
                base: AddressBase::Register(5),
                index: None,
                displacement: 2_147_483_647,
                segment: crate::x86::context::Segment::Ss,
                ..Address::default()
            },
            width: Width::W32
        }
    );
    assert_eq!(
        operation(&[0x8b, 0x43, 0x80]),
        Operation::Load {
            dst: RegisterView::low(0),
            address: Address {
                base: AddressBase::Register(3),
                index: None,
                displacement: -128,
                ..Address::default()
            },
            width: Width::W32
        }
    );
    assert_eq!(
        operation(&[0x8b, 0x43, 0x7f]),
        Operation::Load {
            dst: RegisterView::low(0),
            address: Address {
                base: AddressBase::Register(3),
                index: None,
                displacement: 127,
                ..Address::default()
            },
            width: Width::W32
        }
    );
}

#[test]
fn relative_targets_use_the_following_pc_and_signed_displacements() {
    for (bytes, expected) in [
        (&[0xeb, 0xfe][..], Operation::Jump { target: 0x1000 }),
        (
            &[0xe9, 0xfb, 0xef, 0xff, 0xff][..],
            Operation::Jump { target: 0 },
        ),
        (
            &[0x75, 0xf7][..],
            Operation::Jcc {
                condition: Condition::NotEqual,
                target: 0xff9,
            },
        ),
        (
            &[0x0f, 0x85, 0xfa, 0xef, 0xff, 0xff][..],
            Operation::Jcc {
                condition: Condition::NotEqual,
                target: 0,
            },
        ),
    ] {
        assert_eq!(operation(bytes), expected);
    }
    assert_eq!(
        at(u64::MAX - 7, &[0xeb, 6]).unwrap().operation,
        Operation::Jump { target: 0 }
    );
    // A target is decoded even if execution must later reject it when taken.
    assert_eq!(
        at(0x7fff_ffff_fff0, &[0x75, 0x0e]).unwrap().operation,
        Operation::Jcc {
            condition: Condition::NotEqual,
            target: 0x8000_0000_0000
        }
    );
}

#[test]
fn valid_forms_outside_the_subset_are_unsupported_without_operand_effects() {
    for bytes in [&[0x82, 0xd0, 1][..], &[0xf4][..]] {
        assert_eq!(
            at(0x1000, bytes),
            Err(DecodeError::Unsupported),
            "{bytes:02x?}"
        );
    }
}

#[test]
fn truncation_reports_only_the_first_required_unavailable_byte() {
    for bytes in [
        &[0xb8, 1, 2][..],
        &[0x48][..],
        &[0x48, 0x89][..],
        &[0x81, 0xc0, 1, 2, 3][..],
        &[0x8b, 0x83, 1, 2, 3][..],
        &[0xeb][..],
        &[0x0f][..],
        &[0x0f, 0x85, 1, 2, 3][..],
    ] {
        assert_eq!(
            at(0x1000, bytes),
            Err(DecodeError::Fetch(missing(0x1000 + bytes.len() as u64)))
        );
    }
    let bytes = [0xb8, 0, 0, 0, 0, 0x48, 0xb8];
    assert_eq!(at(0x1000, &bytes).unwrap().next_pc, 0x1005);
}

#[test]
fn required_byte_failure_keeps_the_memory_owners_metadata() {
    let fault = Fault {
        address: 0x8000_0000_0000,
        width: 1,
        access: Access::Execute,
        cause: Cause::Noncanonical,
        failing: 0x8000_0000_0000,
    };
    assert_eq!(
        decode(0x8000_0000_0000, |_| Err(fault)),
        Err(DecodeError::Fetch(fault))
    );
}

#[test]
fn last_instruction_byte_may_be_max_but_required_bytes_may_not_wrap() {
    assert_eq!(at(u64::MAX - 4, &[0xb8, 0, 0, 0, 0]).unwrap().next_pc, 0);
    let pc = u64::MAX;
    let mut reads = Vec::new();
    let decoded = decode(pc, |address| {
        reads.push(address);
        Ok(0xb8)
    });
    assert_eq!(
        decoded,
        Err(DecodeError::Fetch(Fault {
            address: pc,
            width: 2,
            access: Access::Execute,
            cause: Cause::AddressRange,
            failing: 1u128 << 64
        }))
    );
    assert_eq!(reads, vec![u64::MAX]);
}

#[test]
fn overlapping_entries_are_independently_decoded_at_the_requested_pc() {
    let bytes = [0xb8, 0xb9, 3, 0, 0, 0];
    assert_eq!(
        at(0x1000, &bytes).unwrap(),
        Instruction {
            pc: 0x1000,
            next_pc: 0x1005,
            operation: Operation::Mov {
                dst: RegisterView::low(0),
                src: Operand::Immediate(0x3b9),
                width: Width::W32
            }
        }
    );
    assert_eq!(
        at(0x1001, &bytes[1..]).unwrap(),
        Instruction {
            pc: 0x1001,
            next_pc: 0x1006,
            operation: Operation::Mov {
                dst: RegisterView::low(1),
                src: Operand::Immediate(3),
                width: Width::W32
            }
        }
    );
}

#[test]
fn integrated_literal_has_the_declared_instruction_boundaries_and_loop_target() {
    let bytes = [
        0xb8, 0, 0, 0, 0, 0xb9, 3, 0, 0, 0, 0x48, 1, 0xc8, 0x48, 0x83, 0xe9, 1, 0x75, 0xf7, 0x48,
        0x89, 3,
    ];
    let cases = [
        (
            0,
            5,
            Operation::Mov {
                dst: RegisterView::low(0),
                src: Operand::Immediate(0),
                width: Width::W32,
            },
        ),
        (
            5,
            10,
            Operation::Mov {
                dst: RegisterView::low(1),
                src: Operand::Immediate(3),
                width: Width::W32,
            },
        ),
        (
            10,
            13,
            Operation::Alu {
                kind: Alu::Add,
                dst: RegisterView::low(0),
                src: Operand::Register(RegisterView::low(1)),
                width: Width::W64,
            },
        ),
        (
            13,
            17,
            Operation::Alu {
                kind: Alu::Sub,
                dst: RegisterView::low(1),
                src: Operand::Immediate(1),
                width: Width::W64,
            },
        ),
        (
            17,
            19,
            Operation::Jcc {
                condition: Condition::NotEqual,
                target: 0x100a,
            },
        ),
        (
            19,
            22,
            Operation::Store {
                src: Operand::Register(RegisterView::low(0)),
                address: Address {
                    base: AddressBase::Register(3),
                    index: None,
                    displacement: 0,
                    ..Address::default()
                },
                width: Width::W64,
            },
        ),
    ];
    for (offset, end, expected) in cases {
        let pc = 0x1000 + offset as u64;
        assert_eq!(
            at(pc, &bytes[offset..]).unwrap(),
            Instruction {
                pc,
                next_pc: 0x1000 + end,
                operation: expected,
            }
        );
    }
}

#[test]
fn decoding_an_instruction_does_not_probe_its_future_or_branch_target() {
    let mut reads = Vec::new();
    let instruction = decode(0x1000, |address| {
        reads.push(address);
        match address {
            0x1000 => Ok(0xeb),
            0x1001 => Ok(0x7f),
            _ => panic!("unexpected lookahead at {address:x}"),
        }
    })
    .unwrap();
    assert_eq!(instruction.operation, Operation::Jump { target: 0x1081 });
    assert_eq!(reads, [0x1000, 0x1001]);
}

#[test]
fn selected_floating_point_and_control_encodings_are_executable() {
    for code in [
        &[0x0f, 0x54, 0xc1][..],
        &[0x0f, 0x12, 0xc1],
        &[0x66, 0x0f, 0x16, 0x00],
        &[0x0f, 0xae, 0x10],
        &[0xf3, 0x0f, 0x58, 0xc1],
        &[0xf2, 0x0f, 0x2c, 0xc1],
    ] {
        assert!(at(0x1000, code).is_ok(), "{code:02x?}");
    }
}
