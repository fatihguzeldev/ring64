use super::{at, missing, operation};
use crate::x86::context::{ExecutionContext, Segment};
use crate::x86::decode::{DecodeError, decode_with_context};
use crate::x86::instruction::{
    Address, AddressBase, CountCondition, Instruction, Operand, Operation, Width,
};

fn context(mode: &str, code32: bool) -> ExecutionContext {
    let mut segments = serde_json::Map::new();
    for name in ["cs", "ss", "ds", "es", "fs", "gs"] {
        segments.insert(name.into(), serde_json::json!({
            "base":"0x0", "limit": if mode == "virtual8086" {0xffffu32} else {u32::MAX},
            "default32": code32 && mode != "virtual8086", "usable":true,
            "type": if name == "cs" && mode != "virtual8086" {"readable-code"} else {"read-write"},
        }));
    }
    ExecutionContext::from_json(&serde_json::json!({"mode":mode,"segments":segments})).unwrap()
}

fn decoded(pc: u64, bytes: &[u8], context: &ExecutionContext) -> Instruction {
    decode_with_context(pc, context, |address| {
        bytes
            .get(address.wrapping_sub(pc) as usize)
            .copied()
            .ok_or_else(|| DecodeError::Fetch(missing(address)))
    })
    .unwrap()
}

#[test]
fn indirect_memory_forms_share_the_existing_complete_address_grammar() {
    let address = Address {
        base: AddressBase::Register(4),
        index: None,
        displacement: -8,
        size: Width::W64,
        segment: Segment::Ss,
    };
    for (bytes, expected) in [
        (
            &[0xff, 0x54, 0x24, 0xf8][..],
            Operation::Call {
                target: Operand::Memory(address),
                width: Width::W64,
            },
        ),
        (
            &[0xff, 0x64, 0x24, 0xf8][..],
            Operation::JumpMemory {
                address,
                width: Width::W64,
            },
        ),
        (
            &[0xff, 0x74, 0x24, 0xf8][..],
            Operation::Push {
                src: Operand::Memory(address),
                width: Width::W64,
            },
        ),
        (
            &[0x8f, 0x44, 0x24, 0xf8][..],
            Operation::PopMemory {
                address,
                width: Width::W64,
            },
        ),
    ] {
        assert_eq!(operation(bytes), expected, "{bytes:02x?}");
    }

    let rip_relative = Address {
        base: AddressBase::NextPc,
        displacement: 0x12345678,
        segment: Segment::Ds,
        ..Address::default()
    };
    assert_eq!(
        operation(&[0x66, 0xff, 0x15, 0x78, 0x56, 0x34, 0x12]),
        Operation::Call {
            target: Operand::Memory(rip_relative),
            width: Width::W64
        }
    );
    let extended = Address {
        base: AddressBase::Register(12),
        size: Width::W32,
        segment: Segment::Fs,
        ..Address::default()
    };
    assert_eq!(
        operation(&[0x67, 0x64, 0x45, 0x8f, 0x04, 0x24]),
        Operation::PopMemory {
            address: extended,
            width: Width::W64
        }
    );
}

#[test]
fn alternate_register_aliases_ignore_rex_r_and_use_rex_b() {
    for rex in 0x40..=0x4f {
        for low in 0..8 {
            let bank = low | (rex & 1) << 3;
            assert_eq!(
                operation(&[rex, 0xff, 0xf0 | low]),
                Operation::Push {
                    src: Operand::Register(bank),
                    width: Width::W64
                }
            );
            assert_eq!(
                operation(&[rex, 0x8f, 0xc0 | low]),
                Operation::Pop {
                    dst: bank,
                    width: Width::W64
                }
            );
        }
    }
    assert_eq!(
        operation(&[0x41, 0x66, 0xff, 0xf4]),
        Operation::Push {
            src: Operand::Register(4),
            width: Width::W16
        }
    );
    assert_eq!(
        operation(&[0x66, 0x41, 0xff, 0xf4]),
        Operation::Push {
            src: Operand::Register(12),
            width: Width::W16
        }
    );
}

#[test]
fn leave_slot_width_tracks_effective_prefix_order_only() {
    for (bytes, width) in [
        (&[0xc9][..], Width::W64),
        (&[0x66, 0xc9][..], Width::W16),
        (&[0x66, 0x48, 0xc9][..], Width::W64),
        (&[0x48, 0x66, 0xc9][..], Width::W16),
        (&[0x66, 0x48, 0x67, 0xc9][..], Width::W16),
        (&[0x64, 0x67, 0xc9][..], Width::W64),
    ] {
        assert_eq!(operation(bytes), Operation::Leave { width });
    }
}

#[test]
fn long_memory_transfer_widths_are_independent_of_stack_slot_overrides() {
    for (prefix, slot) in [
        (&[][..], Width::W64),
        (&[0x66][..], Width::W16),
        (&[0x66, 0x48][..], Width::W64),
        (&[0x48, 0x66][..], Width::W16),
    ] {
        for tail in [
            &[0xff, 0x10][..],
            &[0xff, 0x20][..],
            &[0xff, 0x30][..],
            &[0x8f, 0][..],
        ] {
            let mut bytes = prefix.to_vec();
            bytes.extend_from_slice(tail);
            match operation(&bytes) {
                Operation::Call { width, .. } | Operation::JumpMemory { width, .. } => {
                    assert_eq!(width, Width::W64)
                }
                Operation::Push { width, .. } | Operation::PopMemory { width, .. } => {
                    assert_eq!(width, slot)
                }
                other => panic!("unexpected {other:?}"),
            }
        }
    }
}

#[test]
fn every_imported_mode_selects_transfer_slot_and_count_widths_independently() {
    for mode in ["real", "protected", "compatibility", "virtual8086"] {
        for code32 in [false, true] {
            if mode == "virtual8086" && code32 {
                continue;
            }
            let profile = context(mode, code32);
            for operand_override in [false, true] {
                for address_override in [false, true] {
                    let slot = if code32 != operand_override {
                        Width::W32
                    } else {
                        Width::W16
                    };
                    let count = if code32 != address_override {
                        Width::W32
                    } else {
                        Width::W16
                    };
                    let mut prefix = Vec::new();
                    if operand_override {
                        prefix.push(0x66);
                    }
                    if address_override {
                        prefix.push(0x67);
                    }
                    for tail in [
                        &[0xff, 0x10][..],
                        &[0xff, 0x20][..],
                        &[0xff, 0x30][..],
                        &[0x8f, 0][..],
                        &[0xc9][..],
                    ] {
                        let mut bytes = prefix.clone();
                        bytes.extend_from_slice(tail);
                        let decoded = decoded(0x12345000, &bytes, &profile);
                        let (width, address) = match decoded.operation {
                            Operation::Call {
                                target: Operand::Memory(address),
                                width,
                            }
                            | Operation::Push {
                                src: Operand::Memory(address),
                                width,
                            } => (width, Some(address)),
                            Operation::JumpMemory { address, width }
                            | Operation::PopMemory { address, width } => (width, Some(address)),
                            Operation::Leave { width } => (width, None),
                            other => panic!("unexpected {other:?}"),
                        };
                        assert_eq!(width, slot, "{mode} {bytes:02x?}");
                        if let Some(address) = address {
                            assert_eq!(address.size, count);
                        }
                    }
                    for opcode in 0xe0..=0xe3 {
                        let mut bytes = prefix.clone();
                        bytes.extend([opcode, 0x80]);
                        let instruction = decoded(0x12345000, &bytes, &profile);
                        let target = (0x12345000u64 + bytes.len() as u64 - 128) & slot.mask();
                        assert_eq!(
                            instruction.operation,
                            Operation::CountBranch {
                                condition: match opcode {
                                    0xe0 => CountCondition::NotEqual,
                                    0xe1 => CountCondition::Equal,
                                    0xe2 => CountCondition::Always,
                                    _ => CountCondition::Zero,
                                },
                                count_width: count,
                                target,
                            }
                        );
                        assert_eq!(instruction.next_pc, 0x12345000 + bytes.len() as u64);
                    }
                }
            }
        }
    }
}

#[test]
fn long_counter_target_width_does_not_follow_count_or_operand_prefixes() {
    for (prefix, count_width) in [
        (&[][..], Width::W64),
        (&[0x66][..], Width::W64),
        (&[0x67][..], Width::W32),
        (&[0x67, 0x48][..], Width::W32),
        (&[0x66, 0x48][..], Width::W64),
    ] {
        for opcode in 0xe0..=0xe3 {
            let mut bytes = prefix.to_vec();
            bytes.extend([opcode, 0x7f]);
            let instruction = at(0x1_0000_1000, &bytes).unwrap();
            let Operation::CountBranch {
                count_width: actual,
                target,
                ..
            } = instruction.operation
            else {
                panic!("not count branch")
            };
            assert_eq!(actual, count_width);
            assert_eq!(target, 0x1_0000_1000 + bytes.len() as u64 + 127);
        }
    }
}

#[test]
fn near_memory_tails_and_single_lock_consume_every_required_byte() {
    for tail in [
        &[0x50][..],
        &[0x58][..],
        &[0x68, 0, 0, 0, 0][..],
        &[0x6a, 0x80][..],
        &[0xe8, 0, 0, 0, 0][..],
        &[0xff, 0xd0][..],
        &[0xff, 0xe0][..],
        &[0xc2, 0, 0][..],
        &[0xc3][..],
        &[0xff, 0x94, 0x25, 0x78, 0x56, 0x34, 0x12][..],
        &[0xff, 0xa4, 0x25, 0x78, 0x56, 0x34, 0x12][..],
        &[0xff, 0xb4, 0x25, 0x78, 0x56, 0x34, 0x12][..],
        &[0x8f, 0x84, 0x25, 0x78, 0x56, 0x34, 0x12][..],
        &[0xc9][..],
        &[0xe0, 0x80][..],
        &[0xe1, 0x7f][..],
        &[0xe2, 0][..],
        &[0xe3, 0xff][..],
    ] {
        for lock in [false, true] {
            let mut bytes = Vec::new();
            if lock {
                bytes.push(0xf0);
            }
            bytes.extend_from_slice(tail);
            for length in 0..bytes.len() {
                assert_eq!(
                    at(0x1000, &bytes[..length]),
                    Err(DecodeError::Fetch(missing(0x1000 + length as u64))),
                    "{bytes:02x?} cut {length}"
                );
            }
            if lock {
                assert_eq!(at(0x1000, &bytes), Err(DecodeError::Invalid));
            } else {
                assert!(at(0x1000, &bytes).is_ok());
            }
        }
        for prefix in [0xf2, 0xf3] {
            let mut bytes = vec![prefix];
            bytes.extend_from_slice(tail);
            assert_eq!(at(0x1000, &bytes), Err(DecodeError::Unsupported));
        }
    }
}

#[test]
fn near_forms_keep_fifteen_byte_and_required_fetch_boundaries() {
    for tail in [
        &[0xff, 0x54, 0x24, 0xf8][..],
        &[0x8f, 0x44, 0x24, 0xf8][..],
        &[0xe2, 0][..],
        &[0xc9][..],
    ] {
        let mut bytes = vec![0x2e; 15 - tail.len()];
        bytes.extend_from_slice(tail);
        assert_eq!(at(0x1000, &bytes).unwrap().encoded_len(), 15);
        let pc = u64::MAX - 14;
        assert_eq!(at(pc, &bytes).unwrap().next_pc, 0);
        bytes.insert(0, 0x2e);
        assert_eq!(at(0x1000, &bytes), Err(DecodeError::Invalid));
    }
}

#[test]
fn unfamiliar_selectors_and_xop_candidates_stop_before_address_fields() {
    for (opcode, selectors) in [(0xff, &[7][..]), (0x8f, &[1, 2, 3, 4, 5, 6, 7][..])] {
        for selector in selectors {
            for mode in 0..4 {
                let bytes = [opcode, (mode << 6) | (selector << 3) | 4];
                assert_eq!(
                    at(0x1000, &bytes),
                    Err(DecodeError::Unsupported),
                    "{bytes:02x?}"
                );
                let bytes = [0xf0, opcode, bytes[1]];
                assert_eq!(at(0x1000, &bytes), Err(DecodeError::Unsupported));
            }
        }
    }
}
