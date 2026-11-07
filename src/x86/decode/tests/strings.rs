use super::*;
use crate::x86::context::{ExecutionContext, Segment};
use crate::x86::instruction::{Repeat, StringKind};

fn context(mode: &str, default32: bool) -> ExecutionContext {
    if mode == "long64" {
        return ExecutionContext::default();
    }
    let mut segments = serde_json::Map::new();
    for name in ["cs", "ss", "ds", "es", "fs", "gs"] {
        segments.insert(name.into(), serde_json::json!({
            "base":"0x0", "limit": if mode == "virtual8086" {0xffffu32} else {u32::MAX},
            "default32":default32,"usable":true,
            "type":if name == "cs" && mode != "virtual8086" {"readable-code"} else {"read-write"},
        }));
    }
    ExecutionContext::from_json(&serde_json::json!({"mode":mode,"segments":segments})).unwrap()
}

fn in_context(bytes: &[u8], context: &ExecutionContext) -> Operation {
    let instruction = super::super::decode_with_context(0x1000, context, |address| {
        bytes
            .get((address - 0x1000) as usize)
            .copied()
            .ok_or_else(|| DecodeError::Fetch(missing(address)))
    })
    .unwrap();
    assert_eq!(instruction.next_pc, 0x1000 + bytes.len() as u64);
    instruction.operation
}

#[test]
fn string_families_use_implicit_width_address_size_and_source_segment() {
    for (opcode, kind) in [
        (0xa4, StringKind::Movs),
        (0xaa, StringKind::Stos),
        (0xac, StringKind::Lods),
        (0xa6, StringKind::Cmps),
        (0xae, StringKind::Scas),
    ] {
        for (mode, default32, operand, address) in [
            ("long64", true, Width::W32, Width::W64),
            ("real", false, Width::W16, Width::W16),
            ("real", true, Width::W32, Width::W32),
            ("virtual8086", false, Width::W16, Width::W16),
            ("protected", false, Width::W16, Width::W16),
            ("protected", true, Width::W32, Width::W32),
            ("compatibility", false, Width::W16, Width::W16),
            ("compatibility", true, Width::W32, Width::W32),
        ] {
            let context = context(mode, default32);
            for byte in [true, false] {
                for operand_override in [false, true] {
                    for address_override in [false, true] {
                        let mut bytes = vec![0x64];
                        if operand_override {
                            bytes.extend([0x66, 0x66]);
                        }
                        if address_override {
                            bytes.extend([0x67, 0x67]);
                        }
                        bytes.push(opcode + u8::from(!byte));
                        let width = if byte {
                            Width::W8
                        } else if operand_override {
                            if operand == Width::W16 {
                                Width::W32
                            } else {
                                Width::W16
                            }
                        } else {
                            operand
                        };
                        let address_width = if address_override {
                            match address {
                                Width::W16 => Width::W32,
                                Width::W32 => Width::W16,
                                _ => Width::W32,
                            }
                        } else {
                            address
                        };
                        assert_eq!(
                            in_context(&bytes, &context),
                            Operation::String {
                                kind,
                                width,
                                address_width,
                                source_segment: Segment::Fs,
                                repeat: Repeat::None,
                            },
                            "{mode} {default32} {bytes:02x?}"
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn repeats_select_each_admitted_family_and_use_the_last_condition() {
    for (opcode, kind, repeat) in [
        (0xa4, StringKind::Movs, Repeat::Count),
        (0xaa, StringKind::Stos, Repeat::Count),
        (0xac, StringKind::Lods, Repeat::Count),
        (0xa6, StringKind::Cmps, Repeat::WhileEqual),
        (0xae, StringKind::Scas, Repeat::WhileEqual),
    ] {
        for prefix in [&[0xf3][..], &[0xf2, 0xf3][..], &[0xf3, 0xf3][..]] {
            let mut bytes = prefix.to_vec();
            bytes.push(opcode);
            assert_eq!(
                operation(&bytes),
                Operation::String {
                    kind,
                    width: Width::W8,
                    address_width: Width::W64,
                    source_segment: Segment::Ds,
                    repeat
                }
            );
        }
    }
    for (opcode, kind) in [(0xa7, StringKind::Cmps), (0xaf, StringKind::Scas)] {
        for prefix in [&[0xf2][..], &[0xf3, 0xf2][..]] {
            let mut bytes = prefix.to_vec();
            bytes.push(opcode);
            assert_eq!(
                operation(&bytes),
                Operation::String {
                    kind,
                    width: Width::W32,
                    address_width: Width::W64,
                    source_segment: Segment::Ds,
                    repeat: Repeat::WhileNotEqual
                }
            );
        }
    }
}

#[test]
fn string_rex_and_legacy_prefix_order_matches_inherited_selection() {
    for (prefix, width) in [
        (&[0x4f][..], Width::W64),
        (&[0x4f, 0x66][..], Width::W16),
        (&[0x66, 0x4f][..], Width::W64),
        (&[0x4f, 0xf3][..], Width::W32),
        (&[0xf3, 0x4f][..], Width::W64),
        (&[0x4f, 0xf3, 0x66][..], Width::W16),
    ] {
        let mut bytes = prefix.to_vec();
        bytes.push(0xa5);
        assert_eq!(
            operation(&bytes),
            Operation::String {
                kind: StringKind::Movs,
                width,
                address_width: Width::W64,
                source_segment: Segment::Ds,
                repeat: if prefix.contains(&0xf3) {
                    Repeat::Count
                } else {
                    Repeat::None
                }
            }
        );
        *bytes.last_mut().unwrap() = 0xa4;
        assert!(matches!(
            operation(&bytes),
            Operation::String {
                width: Width::W8,
                ..
            }
        ));
    }
    for segment in [0x26, 0x2e, 0x36, 0x3e] {
        assert!(matches!(
            operation(&[segment, 0xa4]),
            Operation::String {
                source_segment: Segment::Ds,
                ..
            }
        ));
    }
    assert!(matches!(
        operation(&[0x65, 0x26, 0xa4]),
        Operation::String {
            source_segment: Segment::Gs,
            ..
        }
    ));
    assert!(matches!(
        in_context(&[0x36, 0xa4], &context("protected", true)),
        Operation::String {
            source_segment: Segment::Ss,
            ..
        }
    ));
    for set in [false, true] {
        assert_eq!(
            operation(&[0x4f, 0x66, 0x67, 0x64, 0xfc + u8::from(set)]),
            Operation::Direction { set }
        );
    }
}

#[test]
fn string_prefix_failures_distinguish_invalid_unsupported_fetch_and_length() {
    for opcode in [
        0xa4, 0xa5, 0xa6, 0xa7, 0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf, 0xfc, 0xfd,
    ] {
        assert_eq!(at(0x1000, &[0xf0, opcode]), Err(DecodeError::Invalid));
        for prefix in [&[0xf0, 0xf0][..], &[0xf0, 0xf3][..], &[0xf2, 0xf0][..]] {
            let mut bytes = prefix.to_vec();
            bytes.push(opcode);
            assert_eq!(at(0x1000, &bytes), Err(DecodeError::Unsupported));
        }
    }
    for bytes in [
        &[0xf2, 0xa4][..],
        &[0xf2, 0xaa][..],
        &[0xf2, 0xac][..],
        &[0xf3, 0xfc][..],
        &[0xf2, 0xfd][..],
        &[0xf3, 0x8b][..],
        &[0xf3, 0x6c][..],
        &[0xf3, 0x6f][..],
    ] {
        assert_eq!(at(0x1000, bytes), Err(DecodeError::Unsupported));
    }
    for bytes in [
        &[0xf3][..],
        &[0x48, 0xf2][..],
        &[0xf0][..],
        &[0xf3, 0x64][..],
        &[0xf2, 0x0f][..],
    ] {
        assert_eq!(
            at(0x1000, bytes),
            Err(DecodeError::Fetch(missing(0x1000 + bytes.len() as u64)))
        );
    }
    let mut bytes = vec![0xf3; 14];
    bytes.push(0xa4);
    assert!(matches!(
        operation(&bytes),
        Operation::String {
            repeat: Repeat::Count,
            ..
        }
    ));
    bytes.insert(0, 0xf3);
    let mut reads = Vec::new();
    assert_eq!(
        decode(0x1000, |address| {
            reads.push(address);
            Ok(bytes[(address - 0x1000) as usize])
        }),
        Err(DecodeError::Invalid)
    );
    assert_eq!(reads, (0x1000..0x100f).collect::<Vec<_>>());
}
