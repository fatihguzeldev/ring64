use super::{at, missing, operation};
use crate::x86::context::{ExecutionContext, Segment};
use crate::x86::decode::{DecodeError, decode_with_context};
use crate::x86::instruction::{
    Address, AddressBase, Alu, Bit, Location, MemoryAluOperands, Operation, RegisterView, Width,
};

#[test]
fn exchange_views_and_opcode_register_nop_are_distinct() {
    for bytes in [
        &[0x90][..],
        &[0x44, 0x90],
        &[0x48, 0x90],
        &[0x41, 0x66, 0x90],
    ] {
        assert_eq!(operation(bytes), Operation::Nop);
    }
    for (bytes, bank, width) in [
        (&[0x41, 0x90][..], 8, Width::W32),
        (&[0x66, 0x41, 0x90], 8, Width::W16),
        (&[0x49, 0x90], 8, Width::W64),
        (&[0x87, 0xc0], 0, Width::W32),
    ] {
        assert_eq!(
            operation(bytes),
            Operation::Exchange {
                dst: Location::Register(RegisterView::low(bank)),
                src: RegisterView::low(0),
                width
            }
        );
    }
    assert_eq!(
        operation(&[0x86, 0xe0]),
        Operation::Exchange {
            dst: Location::Register(RegisterView::low(0)),
            src: RegisterView::high_byte(0),
            width: Width::W8
        }
    );
    assert_eq!(
        operation(&[0x40, 0x86, 0xe0]),
        Operation::Exchange {
            dst: Location::Register(RegisterView::low(0)),
            src: RegisterView::low(4),
            width: Width::W8
        }
    );
    assert_eq!(operation(&[0xf3, 0x90]), Operation::Nop);
}

#[test]
fn exchanges_share_complete_address_grammar_and_rex_view_extensions() {
    let address = Address {
        base: AddressBase::Register(12),
        displacement: -8,
        size: Width::W32,
        segment: Segment::Fs,
        ..Address::default()
    };
    for (opcode, second) in [(0x87, None), (0x0f, Some(0xc1)), (0x0f, Some(0xb1))] {
        let mut bytes = vec![0x67, 0x64, 0x4d, opcode];
        if let Some(second) = second {
            bytes.push(second);
        }
        bytes.extend([0x44, 0x24, 0xf8]);
        let expected = match second {
            None => Operation::Exchange {
                dst: Location::Memory(address),
                src: RegisterView::low(8),
                width: Width::W64,
            },
            Some(0xc1) => Operation::Xadd {
                dst: Location::Memory(address),
                src: RegisterView::low(8),
                width: Width::W64,
            },
            _ => Operation::CompareExchange {
                dst: Location::Memory(address),
                src: RegisterView::low(8),
                width: Width::W64,
            },
        };
        assert_eq!(operation(&bytes), expected);
    }
    assert_eq!(
        operation(&[0x0f, 0xc0, 0xe0]),
        Operation::Xadd {
            dst: Location::Register(RegisterView::low(0)),
            src: RegisterView::high_byte(0),
            width: Width::W8
        }
    );
    assert_eq!(
        operation(&[0x0f, 0xb0, 0xc4]),
        Operation::CompareExchange {
            dst: Location::Register(RegisterView::high_byte(0)),
            src: RegisterView::low(0),
            width: Width::W8
        }
    );
}

#[test]
fn compare_exchange_pair_width_selector_and_operand_mode_have_exact_deciding_points() {
    let address = Address {
        base: AddressBase::Register(6),
        ..Address::default()
    };
    for prefix in [&[][..], &[0x66], &[0x44], &[0x48, 0x66]] {
        let mut bytes = prefix.to_vec();
        bytes.extend([0x0f, 0xc7, 0x0e]);
        assert_eq!(operation(&bytes), Operation::CompareExchange8b { address });
    }
    for bytes in [
        &[0x48, 0x0f, 0xc7, 0x0c][..],
        &[0x66, 0x48, 0x0f, 0xc7, 0x0c],
        &[0x0f, 0xc7, 0x34],
        &[0x44, 0x0f, 0xc7, 0x34],
    ] {
        assert_eq!(at(0x1000, bytes), Err(DecodeError::Unsupported));
    }
    for bytes in [
        &[0x0f, 0xc7, 0xc8][..],
        &[0x48, 0x0f, 0xc7, 0xc8],
        &[0xf0, 0x48, 0x0f, 0xc7, 0xc8],
    ] {
        assert_eq!(at(0x1000, bytes), Err(DecodeError::Invalid));
    }
    assert!(matches!(
        at(0x1000, &[0x48, 0x0f, 0xc7]),
        Err(DecodeError::Fetch(_))
    ));
}

#[test]
fn selected_lock_forms_require_full_encoding_then_validate_the_destination() {
    let legal = [
        vec![0xf0, 0x01, 0x03],
        vec![0xf0, 0x83, 0x03, 0],
        vec![0xf0, 0xfe, 0x03],
        vec![0xf0, 0xff, 0x0b],
        vec![0xf0, 0xf6, 0x13],
        vec![0xf0, 0xf7, 0x1b],
        vec![0xf0, 0x0f, 0xab, 0x03],
        vec![0xf0, 0x0f, 0xba, 0x2b, 0],
        vec![0xf0, 0x87, 0x03],
        vec![0xf0, 0x0f, 0xc1, 0x03],
        vec![0xf0, 0x0f, 0xb1, 0x03],
        vec![0xf0, 0x0f, 0xc7, 0x0b],
    ];
    for bytes in legal {
        for length in 1..bytes.len() {
            assert!(
                matches!(at(0x1000, &bytes[..length]), Err(DecodeError::Fetch(_))),
                "{bytes:02x?} length{length}"
            );
        }
        let without_lock = operation(&bytes[1..]);
        assert_eq!(operation(&bytes), without_lock, "{bytes:02x?}");
    }
    for bytes in [
        vec![0xf0, 0x01, 0xc0],
        vec![0xf0, 0x03, 0x84, 0x24, 1, 2, 3, 4],
        vec![0xf0, 0x83, 0x3c, 0x24, 1],
        vec![0xf0, 0xf7, 0x04, 0x24, 1, 2, 3, 4],
        vec![0xf0, 0xf7, 0x24, 0x24],
        vec![0xf0, 0x0f, 0xa3, 0x04, 0x24],
        vec![0xf0, 0x0f, 0xba, 0x24, 0x24, 1],
        vec![0xf0, 0x0f, 0xc1, 0xc0],
        vec![0xf0, 0x0f, 0xb1, 0xc0],
        vec![0xf0, 0x87, 0xc0],
        vec![0xf0, 0x90],
        vec![0xf0, 0xff, 0x5c, 0x24, 0],
    ] {
        for length in 1..bytes.len() {
            assert!(
                matches!(at(0x1000, &bytes[..length]), Err(DecodeError::Fetch(_))),
                "{bytes:02x?} length{length}"
            );
        }
        assert_eq!(
            at(0x1000, &bytes),
            Err(DecodeError::Invalid),
            "{bytes:02x?}"
        );
    }
    for bytes in [
        &[0xf0, 0xf6, 0x0c][..],
        &[0xf0, 0x0f, 0xba, 0x1c],
        &[0xf0, 0x0f, 0xc7, 0x34],
        &[0xf0, 0x0f, 0x40],
        &[0xf0, 0x0f, 0xc8],
        &[0xf0, 0xf0],
        &[0xf0, 0xf3],
        &[0xf2, 0xf0],
    ] {
        assert_eq!(
            at(0x1000, bytes),
            Err(DecodeError::Unsupported),
            "{bytes:02x?}"
        );
    }
}

#[test]
fn selected_lock_opcode_groups_keep_every_modifying_family_and_reject_readonly_members() {
    for opcode in [
        0x00, 0x01, 0x08, 0x09, 0x10, 0x11, 0x18, 0x19, 0x20, 0x21, 0x28, 0x29, 0x30, 0x31,
    ] {
        assert!(
            matches!(operation(&[0xf0,opcode,0x03]),Operation::MemoryAlu{kind,operands:MemoryAluOperands::MemoryFirst(_),..} if kind.writes_result())
        );
    }
    for opcode in [0x38, 0x39, 0x3a, 0x3b, 0x84, 0x85] {
        assert_eq!(at(0x1000, &[0xf0, opcode, 0x03]), Err(DecodeError::Invalid));
    }
    for opcode in [0x80, 0x81, 0x83] {
        for selector in 0..8 {
            let mut bytes = vec![0xf0, opcode, selector << 3 | 3];
            bytes.extend(vec![0; if opcode == 0x81 { 4 } else { 1 }]);
            let decoded = at(0x1000, &bytes);
            if selector == 7 {
                assert_eq!(decoded, Err(DecodeError::Invalid));
            } else {
                assert!(decoded.is_ok());
            }
        }
    }
    for (opcode, kind) in [
        (0xab, Bit::Set),
        (0xb3, Bit::Reset),
        (0xbb, Bit::Complement),
    ] {
        assert!(matches!(operation(&[0xf0,0x0f,opcode,0x03]),Operation::Bit{kind:k,..} if k==kind));
    }
    assert!(matches!(
        operation(&[0xf0, 0x83, 0x03, 1]),
        Operation::MemoryAlu { kind: Alu::Add, .. }
    ));
}

#[test]
fn exchange_families_follow_imported_mode_widths_without_old_cpu_feature_gates() {
    for mode in ["real", "virtual8086", "protected", "compatibility"] {
        for code32 in [false, true] {
            if mode == "virtual8086" && code32 {
                continue;
            }
            let mut segments = serde_json::Map::new();
            for name in ["cs", "ss", "ds", "es", "fs", "gs"] {
                segments.insert(name.into(),serde_json::json!({"base":"0x0","limit":if mode=="virtual8086"{0xffffu32}else{u32::MAX},"default32":code32,"usable":true,"type":if name=="cs" && mode!="virtual8086"{"readable-code"}else{"read-write"}}));
            }
            let context =
                ExecutionContext::from_json(&serde_json::json!({"mode":mode,"segments":segments}))
                    .unwrap();
            for override_operand in [false, true] {
                for tail in [
                    &[0x87, 0xc1][..],
                    &[0x0f, 0xc1, 0xc1],
                    &[0x0f, 0xb1, 0xc1],
                    &[0x0f, 0xc7, 0x0f],
                ] {
                    let mut bytes = vec![];
                    if override_operand {
                        bytes.push(0x66);
                    }
                    bytes.extend(tail);
                    let decoded = decode_with_context(0x1000, &context, |a| {
                        bytes
                            .get((a - 0x1000) as usize)
                            .copied()
                            .ok_or_else(|| DecodeError::Fetch(missing(a)))
                    })
                    .unwrap();
                    match decoded.operation {
                        Operation::Exchange { width, .. }
                        | Operation::Xadd { width, .. }
                        | Operation::CompareExchange { width, .. } => assert_eq!(
                            width,
                            if code32 != override_operand {
                                Width::W32
                            } else {
                                Width::W16
                            }
                        ),
                        Operation::CompareExchange8b { .. } => {}
                        other => panic!("{other:?}"),
                    }
                }
            }
        }
    }
}

#[test]
fn exchange_required_bytes_and_length_limit_preserve_exact_boundaries() {
    for tail in [
        vec![0x86, 0x84, 0x24, 1, 2, 3, 4],
        vec![0x0f, 0xc1, 0x84, 0x24, 1, 2, 3, 4],
        vec![0x0f, 0xb1, 0x84, 0x24, 1, 2, 3, 4],
        vec![0x0f, 0xc7, 0x8c, 0x24, 1, 2, 3, 4],
    ] {
        for lock in [false, true] {
            let mut bytes = vec![];
            if lock {
                bytes.push(0xf0);
            }
            bytes.extend(&tail);
            for n in 1..bytes.len() {
                assert!(
                    matches!(at(0x1000, &bytes[..n]), Err(DecodeError::Fetch(_))),
                    "{bytes:02x?} {n}"
                );
            }
            let prefix_count = 15 - bytes.len();
            let mut full = vec![0x66; prefix_count];
            full.extend(&bytes);
            assert!(at(0x1000, &full).is_ok());
            full.insert(0, 0x66);
            assert_eq!(at(0x1000, &full), Err(DecodeError::InstructionLength));
        }
    }
}
