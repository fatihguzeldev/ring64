use super::*;
use crate::x86::context::{ExecutionContext, Segment};
use crate::x86::instruction::{FarDescriptor, FarInstruction, FarKind, FarOperand};

#[test]
fn far_private_descriptor_roundtrips_kinds_widths_and_rejects_reserved_shapes() {
    for kind in [FarKind::Call, FarKind::Jump, FarKind::Return] {
        for width in [Width::W16, Width::W32, Width::W64] {
            for memory in [false, true] {
                let d = FarDescriptor {
                    kind,
                    width,
                    memory,
                };
                assert_eq!(
                    FarDescriptor::try_decode(d.encode()),
                    if kind == FarKind::Return && memory {
                        None
                    } else {
                        Some(d)
                    }
                );
                assert_eq!(FarDescriptor::try_decode(d.encode() | 32), None);
            }
        }
    }
    for raw in [3, 7, 11, 12, 13, 14, 15] {
        assert_eq!(FarDescriptor::try_decode(raw), None);
    }
}

#[test]
fn far_long_memory_and_return_forms_use_source_operand_size_instead_of_near_size() {
    for (prefix, width) in [
        (&[][..], Width::W32),
        (&[0x66][..], Width::W16),
        (&[0x48][..], Width::W64),
        (&[0x66, 0x48][..], Width::W64),
        (&[0x48, 0x66][..], Width::W16),
    ] {
        for (opcode, kind) in [(0x1b, FarKind::Call), (0x2b, FarKind::Jump)] {
            let mut bytes = prefix.to_vec();
            bytes.extend([0xff, opcode]);
            let Operation::Far(f) = operation(&bytes) else {
                panic!("far memory")
            };
            assert_eq!((f.kind, f.width), (kind, width));
            assert!(matches!(
                f.operand,
                FarOperand::Memory(Address {
                    base: AddressBase::Register(3),
                    ..
                })
            ));
        }
        for (tail, cleanup) in [(&[0xcb][..], 0), (&[0xca, 0xff, 0xff][..], 65535)] {
            let mut bytes = prefix.to_vec();
            bytes.extend(tail);
            assert_eq!(
                operation(&bytes),
                Operation::Far(FarInstruction {
                    kind: FarKind::Return,
                    width,
                    operand: FarOperand::Return { cleanup }
                })
            );
        }
    }
}

fn legacy(
    bytes: &[u8],
    mode: &str,
    code32: bool,
    stack32: bool,
) -> Result<Instruction, DecodeError> {
    let mut raw = ExecutionContext::default().to_json();
    raw["mode"] = serde_json::json!(mode);
    raw["cpl"] = serde_json::json!(if mode == "virtual8086" { 3 } else { 0 });
    for name in ["cs", "ss", "ds", "es", "fs", "gs"] {
        raw["segments"][name]["selector"] = serde_json::json!(if mode == "virtual8086" {
            0
        } else if name == "cs" {
            8
        } else {
            16
        });
        raw["segments"][name]["base"] = serde_json::json!("0x0");
        raw["segments"][name]["limit"] = serde_json::json!(if mode == "virtual8086" {
            0xffffu32
        } else {
            u32::MAX
        });
        raw["segments"][name]["default32"] =
            serde_json::json!(if name == "ss" { stack32 } else { code32 });
        raw["segments"][name]["long"] = serde_json::json!(false);
        raw["segments"][name]["type"] =
            serde_json::json!(if name == "cs" && mode != "virtual8086" {
                "readable-code"
            } else {
                "read-write"
            });
    }
    let context = ExecutionContext::from_json(&raw).unwrap();
    super::super::decode_with_context(0x1000, &context, |pc| {
        bytes
            .get(pc.wrapping_sub(0x1000) as usize)
            .copied()
            .ok_or(DecodeError::Fetch(missing(pc)))
    })
}

#[test]
fn far_legacy_immediates_capture_offset_selector_and_all_starting_size_profiles() {
    for mode in ["real", "virtual8086", "protected", "compatibility"] {
        for code32 in [false, true] {
            for stack32 in [false, true] {
                if mode == "virtual8086" && (code32 || stack32) {
                    continue;
                }
                for override_size in [false, true] {
                    let width = if code32 != override_size {
                        Width::W32
                    } else {
                        Width::W16
                    };
                    for (opcode, kind) in [(0x9a, FarKind::Call), (0xea, FarKind::Jump)] {
                        let mut bytes = vec![];
                        if override_size {
                            bytes.push(0x66);
                        }
                        bytes.push(opcode);
                        bytes.extend(if width == Width::W16 {
                            vec![0x78, 0x56, 0xbc, 0x9a]
                        } else {
                            vec![0x78, 0x56, 0x34, 0x12, 0xbc, 0x9a]
                        });
                        let i = legacy(&bytes, mode, code32, stack32).unwrap();
                        assert_eq!(i.encoded_len(), bytes.len() as u32);
                        assert_eq!(
                            i.operation,
                            Operation::Far(FarInstruction {
                                kind,
                                width,
                                operand: FarOperand::Immediate {
                                    selector: 0x9abc,
                                    offset: if width == Width::W16 {
                                        0x5678
                                    } else {
                                        0x12345678
                                    }
                                }
                            })
                        );
                    }
                    for (tail, kind) in [
                        (&[0xff, 0x1b][..], FarKind::Call),
                        (&[0xff, 0x2b][..], FarKind::Jump),
                    ] {
                        let mut bytes = vec![];
                        if override_size {
                            bytes.push(0x66);
                        }
                        bytes.extend(tail);
                        let Operation::Far(op) =
                            legacy(&bytes, mode, code32, stack32).unwrap().operation
                        else {
                            panic!("memory")
                        };
                        assert_eq!((op.kind, op.width), (kind, width));
                        assert!(
                            matches!(op.operand,FarOperand::Memory(Address{size,..}) if size==if code32 {Width::W32} else {Width::W16})
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn far_selected_prefixes_keep_rex_group_address_and_cancellation_roles() {
    let Operation::Far(op) = operation(&[0x4f, 0xff, 0x9c, 0x8c, 0x78, 0x56, 0x34, 0x12]) else {
        panic!("SIB")
    };
    assert_eq!((op.kind, op.width), (FarKind::Call, Width::W64));
    assert!(matches!(
        op.operand,
        FarOperand::Memory(Address {
            base: AddressBase::Register(12),
            index: Some(crate::x86::instruction::AddressIndex {
                register: 9,
                scale: 4
            }),
            displacement: 0x12345678,
            size: Width::W64,
            segment: Segment::Ds
        })
    ));
    for (bytes, width) in [
        (&[0xf3, 0x48, 0xff, 0x1b][..], Width::W64),
        (&[0x48, 0xf3, 0xff, 0x1b][..], Width::W32),
        (&[0xf2, 0xf3, 0x66, 0xcb][..], Width::W16),
    ] {
        let Operation::Far(op) = operation(bytes) else {
            panic!("ignored repeat")
        };
        assert_eq!(op.width, width);
    }
    assert_eq!(
        at(0x1000, &[0xf3, 0xff]),
        Err(DecodeError::Fetch(missing(0x1002)))
    );
    assert_eq!(
        at(0x1000, &[0xf3, 0xff, 0x94]),
        Err(DecodeError::Unsupported)
    );
    for bytes in [
        &[0x9a][..],
        &[0xea],
        &[0xff, 0xdb],
        &[0xff, 0xeb],
        &[0xf3, 0xff, 0xdb],
    ] {
        assert_eq!(at(0x1000, bytes), Err(DecodeError::Invalid));
    }
}

#[test]
fn far_required_address_immediate_and_lock_tails_preserve_first_fetch_and_length() {
    let complete = [0xf0, 0xff, 0x9c, 0x8b, 0x78, 0x56, 0x34, 0x12];
    for len in 1..complete.len() {
        assert_eq!(
            at(0x1000, &complete[..len]),
            Err(DecodeError::Fetch(missing(0x1000 + len as u64)))
        );
    }
    assert_eq!(at(0x1000, &complete), Err(DecodeError::Invalid));
    let immediate = [0xf0, 0x9a, 0x78, 0x56, 0x34, 0x12, 0xbc, 0x9a];
    for len in 1..immediate.len() {
        assert!(matches!(
            legacy(&immediate[..len], "protected", true, true),
            Err(DecodeError::Fetch(_))
        ));
    }
    assert_eq!(
        legacy(&immediate, "protected", true, true),
        Err(DecodeError::Invalid)
    );
    for bytes in [&[0xf0, 0xca][..], &[0xf0, 0xca, 0xff]] {
        assert!(matches!(at(0x1000, bytes), Err(DecodeError::Fetch(_))));
    }
    assert_eq!(
        at(0x1000, &[0xf0, 0xca, 0xff, 0xff]),
        Err(DecodeError::Invalid)
    );
    let mut exact = vec![0x66; 12];
    exact.extend([0xca, 0xff, 0xff]);
    assert_eq!(at(0x1000, &exact).unwrap().encoded_len(), 15);
    exact.insert(0, 0x66);
    assert_eq!(at(0x1000, &exact), Err(DecodeError::Invalid));
    assert_eq!(at(u64::MAX, &[0xcb]).unwrap().next_pc, 0);
    assert!(
        matches!(at(u64::MAX,&[0xca]),Err(DecodeError::Fetch(Fault{cause:Cause::AddressRange,failing,..})) if failing==1u128<<64)
    );
}
