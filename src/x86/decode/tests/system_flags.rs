use super::*;
use crate::x86::context::{ExecutionContext, Segment};
use crate::x86::instruction::{
    Location, ProtectionInstruction, ProtectionKind, SystemFlagsDescriptor, SystemFlagsKind,
};

fn contextual(bytes: &[u8], mode: &str, code32: bool) -> Result<Instruction, DecodeError> {
    let segments=["cs","ss","ds","es","fs","gs"].into_iter().map(|name| {
        (name.to_owned(),serde_json::json!({"base":"0x0","limit":if mode=="virtual8086"{0xffffu32}else{u32::MAX},"default32":code32,"usable":true,"type":if name=="cs"&&mode!="virtual8086"{"readable-code"}else{"read-write"}}))
    }).collect::<serde_json::Map<_,_>>();
    let c =
        ExecutionContext::from_json(&serde_json::json!({"mode":mode,"segments":segments})).unwrap();
    super::super::decode_with_context(0x1000, &c, |pc| {
        bytes
            .get(pc.wrapping_sub(0x1000) as usize)
            .copied()
            .ok_or(DecodeError::Fetch(missing(pc)))
    })
}

#[test]
fn flags_stack_prefix_order_has_no_long_operand32_form() {
    for (prefix, width) in [
        (&[][..], Width::W64),
        (&[0x66], Width::W16),
        (&[0x48], Width::W64),
        (&[0x66, 0x48], Width::W64),
        (&[0x48, 0x66], Width::W16),
        (&[0x67], Width::W64),
        (&[0xf2], Width::W64),
        (&[0xf3, 0x66], Width::W16),
    ] {
        for (opcode, kind) in [(0x9c, SystemFlagsKind::Push), (0x9d, SystemFlagsKind::Pop)] {
            let mut bytes = prefix.to_vec();
            bytes.push(opcode);
            assert_eq!(
                operation(&bytes),
                Operation::SystemFlags(SystemFlagsDescriptor { kind, width })
            );
        }
    }
    for mode in ["real", "virtual8086", "protected", "compatibility"] {
        for code32 in [false, true] {
            if mode == "virtual8086" && code32 {
                continue;
            }
            for override_size in [false, true] {
                for (opcode, kind) in [(0x9c, SystemFlagsKind::Push), (0x9d, SystemFlagsKind::Pop)]
                {
                    let mut bytes = if override_size { vec![0x66] } else { vec![] };
                    bytes.push(opcode);
                    let instruction = contextual(&bytes, mode, code32).unwrap();
                    assert_eq!(
                        instruction.operation,
                        Operation::SystemFlags(SystemFlagsDescriptor {
                            kind,
                            width: if code32 != override_size {
                                Width::W32
                            } else {
                                Width::W16
                            }
                        })
                    );
                    assert_eq!(instruction.encoded_len(), bytes.len() as u32);
                }
            }
        }
    }
}

#[test]
fn interrupt_controls_ignore_size_repeat_and_address_prefixes() {
    for (opcode, kind) in [(0xfa, SystemFlagsKind::Cli), (0xfb, SystemFlagsKind::Sti)] {
        for prefix in [&[][..], &[0x66, 0x67, 0x48], &[0xf3], &[0xf2]] {
            let mut bytes = prefix.to_vec();
            bytes.push(opcode);
            assert_eq!(
                operation(&bytes),
                Operation::SystemFlags(SystemFlagsDescriptor {
                    kind,
                    width: Width::W16
                })
            );
        }
    }
}

#[test]
fn mov_ss_uses_fixed_selector_rex_base_and_old_source_segment() {
    assert_eq!(
        operation(&[0x4d, 0x8e, 0xd0]),
        Operation::Protection(ProtectionInstruction {
            kind: ProtectionKind::LoadSegment(Segment::Ss),
            width: Width::W16,
            operand: Location::Register(RegisterView::low(8)),
            register: 0
        })
    );
    let Operation::Protection(p) = operation(&[0xf3, 0x66, 0x36, 0x8e, 0x54, 0x8b, 0x7f]) else {
        panic!("MOV SS")
    };
    assert_eq!(p.kind, ProtectionKind::LoadSegment(Segment::Ss));
    assert_eq!(p.width, Width::W16);
    let Location::Memory(address) = p.operand else {
        panic!("memory")
    };
    assert_eq!(address.segment, Segment::Ds); // long64 ignores the SS override.
    let p = contextual(&[0x36, 0x8e, 0x10], "protected", true).unwrap();
    let Operation::Protection(p) = p.operation else {
        panic!("MOV SS")
    };
    let Location::Memory(address) = p.operand else {
        panic!("memory")
    };
    assert_eq!(address.segment, Segment::Ss);
    assert!(
        crate::x86::instruction::ProtectionDescriptor::try_decode(p.descriptor().encode())
            .is_some()
    );
}

#[test]
fn pop_ss_nonlong_slot_width_and_deciding_opcode_frontiers() {
    for mode in ["real", "virtual8086", "protected", "compatibility"] {
        for code32 in [false, true] {
            if mode == "virtual8086" && code32 {
                continue;
            }
            for (bytes, overridden) in [(&[0x17][..], false), (&[0xf3, 0x66, 0x17], true)] {
                let instruction = contextual(bytes, mode, code32).unwrap();
                assert_eq!(
                    instruction.operation,
                    Operation::PopSs {
                        width: if code32 != overridden {
                            Width::W32
                        } else {
                            Width::W16
                        }
                    }
                );
            }
        }
    }
    assert_eq!(at(0x1000, &[0x17]), Err(DecodeError::Invalid));
    for opcode in [0x9c, 0x9d, 0xfa, 0xfb, 0x17] {
        assert_eq!(at(0x1000, &[0xf0, opcode]), Err(DecodeError::Invalid));
    }
    let complete = [0xf0, 0x8e, 0x94, 0x8b, 0x78, 0x56, 0x34, 0x12];
    for count in 1..complete.len() {
        assert!(
            matches!(at(0x1000, &complete[..count]), Err(DecodeError::Fetch(_))),
            "count{count}"
        );
    }
    assert_eq!(at(0x1000, &complete), Err(DecodeError::Invalid));
    let mut fifteen = vec![0x66; 14];
    fifteen.push(0x9c);
    assert_eq!(at(0x1000, &fifteen).unwrap().encoded_len(), 15);
    fifteen.insert(0, 0x66);
    assert_eq!(at(0x1000, &fifteen), Err(DecodeError::Invalid));
    assert_eq!(
        at(0x1000, &[0xf0, 0xf3, 0x9c]),
        Err(DecodeError::Unsupported)
    );
}
