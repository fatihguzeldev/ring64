use super::super::decode_with_context;
use super::*;
use crate::x86::context::{ExecutionContext, Segment};
use crate::x86::instruction::{Operand as StackOperand, Unary};

fn context(mode: &str, code32: bool) -> ExecutionContext {
    let mut segments = serde_json::Map::new();
    for name in ["cs", "ss", "ds", "es", "fs", "gs"] {
        segments.insert(name.into(), serde_json::json!({
            "base":"0x0", "limit": if mode == "virtual8086" { 0xffffu32 } else { u32::MAX },
            "default32": if mode == "virtual8086" { false } else { code32 }, "usable":true,
            "type": if name == "cs" && mode != "virtual8086" { "readable-code" } else { "read-write" },
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
fn mode_selects_legacy_inc_instead_of_rex_and_preserves_real_width_defaults() {
    let bytes = [0x40, 0xb8, 0x78, 0x56, 0x34, 0x12];
    let legacy = decoded(0x1000, &bytes, &context("protected", true));
    assert_eq!(legacy.next_pc, 0x1001);
    assert_eq!(
        legacy.operation,
        Operation::Unary {
            kind: Unary::Inc,
            dst: crate::x86::instruction::Location::Register(RegisterView::low(0)),
            width: Width::W32
        }
    );
    let legacy16 = decoded(0x1000, &bytes, &context("real", false));
    assert!(matches!(
        legacy16.operation,
        Operation::Unary {
            width: Width::W16,
            ..
        }
    ));
    let long = decoded(0x1000, &bytes, &ExecutionContext::default());
    assert_eq!(long.encoded_len(), 6);
    assert!(matches!(
        long.operation,
        Operation::Mov {
            width: Width::W32,
            ..
        }
    ));
}

#[test]
fn address16_grammar_segments_and_address32_ip_relative_are_distinct() {
    let legacy = context("protected", true);
    let expected = [
        (3, Some(6), Segment::Ds),
        (3, Some(7), Segment::Ds),
        (5, Some(6), Segment::Ss),
        (5, Some(7), Segment::Ss),
        (6, None, Segment::Ds),
        (7, None, Segment::Ds),
    ];
    for (rm, (base, index, segment)) in expected.into_iter().enumerate() {
        let i = decoded(0x1000, &[0x67, 0x8b, rm as u8], &legacy);
        let Operation::Load { address, .. } = i.operation else {
            panic!("expected load")
        };
        assert_eq!(address.base, AddressBase::Register(base));
        assert_eq!(address.index.map(|i| i.register), index);
        assert_eq!((address.size, address.segment), (Width::W16, segment));
    }
    let abs = decoded(0x1000, &[0x8b, 5, 0x34, 0x12, 0, 0], &legacy);
    assert!(matches!(
        abs.operation,
        Operation::Load {
            address: Address {
                base: AddressBase::None,
                displacement: 0x1234,
                size: Width::W32,
                ..
            },
            ..
        }
    ));
    let rel = decoded(
        0x1000,
        &[0x67, 0x8b, 5, 0, 0, 0, 0],
        &ExecutionContext::default(),
    );
    assert!(matches!(
        rel.operation,
        Operation::Load {
            address: Address {
                base: AddressBase::NextPc,
                size: Width::W32,
                ..
            },
            ..
        }
    ));
    let direct16 = decoded(0x1000, &[0x67, 0x8b, 6, 0x34, 0x12], &legacy);
    assert!(matches!(
        direct16.operation,
        Operation::Load {
            address: Address {
                base: AddressBase::None,
                displacement: 0x1234,
                segment: Segment::Ds,
                ..
            },
            ..
        }
    ));
}

#[test]
fn long64_ignored_segments_keep_fs_and_legacy_prefixes_cancel_rex() {
    for bytes in [[0x64, 0x3e, 0x8b, 0], [0x3e, 0x64, 0x8b, 0]] {
        let i = decoded(0x1000, &bytes, &ExecutionContext::default());
        assert!(matches!(
            i.operation,
            Operation::Load {
                address: Address {
                    segment: Segment::Fs,
                    ..
                },
                ..
            }
        ));
    }
    let ah = decoded(
        0x1000,
        &[0x40, 0x66, 0x0f, 0xb6, 0xc4],
        &ExecutionContext::default(),
    );
    assert!(matches!(
        ah.operation,
        Operation::Extend {
            src: crate::x86::instruction::Location::Register(RegisterView {
                bank: 0,
                high_byte: true
            }),
            width: Width::W16,
            ..
        }
    ));
    let spl = decoded(
        0x1000,
        &[0x66, 0x40, 0x0f, 0xb6, 0xc4],
        &ExecutionContext::default(),
    );
    assert!(matches!(
        spl.operation,
        Operation::Extend {
            src: crate::x86::instruction::Location::Register(RegisterView {
                bank: 4,
                high_byte: false
            }),
            ..
        }
    ));
}

#[test]
fn near_and_stack_operand_sizes_are_independent_in_long64_and_legacy() {
    let long = ExecutionContext::default();
    assert!(matches!(
        decoded(0x1000, &[0x66, 0x50], &long).operation,
        Operation::Push {
            width: Width::W16,
            ..
        }
    ));
    assert!(matches!(
        decoded(0x1000, &[0x66, 0x48, 0x50], &long).operation,
        Operation::Push {
            width: Width::W64,
            ..
        }
    ));
    assert_eq!(
        decoded(0x1000, &[0x66, 0xe8, 1, 0, 0, 0], &long).operation,
        Operation::Call {
            target: StackOperand::Immediate(0x1007),
            width: Width::W64
        }
    );
    assert!(matches!(
        decoded(0x1000, &[0x66, 0xc3], &long).operation,
        Operation::Return {
            width: Width::W64,
            ..
        }
    ));
    let legacy = context("protected", true);
    let short = decoded(0x10000, &[0x66, 0x75, 0], &legacy);
    assert_eq!(short.next_pc, 0x10003);
    assert!(matches!(short.operation, Operation::Jcc { target: 3, .. }));
    let wide = decoded(
        0x1000,
        &[0x66, 0xe9, 0xfa, 0xef, 0, 0],
        &context("protected", false),
    );
    assert_eq!(wide.operation, Operation::Jump { target: 0x10000 });
}

#[test]
fn non64_sequential_eip_wrap_keeps_actual_encoded_length() {
    let i = decoded(u32::MAX as u64, &[0xf5], &context("protected", false));
    assert_eq!((i.next_pc, i.encoded_len()), (0, 1));
}

#[test]
fn all_legacy_code_defaults_select_each_inherited_scalar_family_width() {
    let samples: &[&[u8]] = &[
        &[0x89, 0xc8],       // MOV
        &[0x0f, 0xb6, 0xc4], // MOVZX from AH
        &[0x01, 0xc8],       // ADD
        &[0x85, 0xc8],       // TEST
        &[0xff, 0xc0],       // INC
        &[0xd3, 0xe0],       // SHL
        &[0x0f, 0xa5, 0xc8], // SHLD
        &[0x0f, 0xa3, 0xc8], // BT
        &[0x0f, 0xbc, 0xc8], // BSF
        &[0xf7, 0xe1],       // MUL
        &[0xf7, 0xf9],       // IDIV
        &[0x0f, 0xaf, 0xc1], // IMUL
        &[0x0f, 0x45, 0xc1], // CMOVNE
        &[0x99],             // CWD/CDQ
        &[0x50],             // PUSH
        &[0x58],             // POP
        &[0xff, 0xd0],       // CALL register
        &[0xff, 0xe0],       // JMP register
        &[0xc3],             // RET
    ];
    for (mode, code32) in [
        ("real", false),
        ("real", true),
        ("virtual8086", false),
        ("protected", false),
        ("protected", true),
        ("compatibility", false),
        ("compatibility", true),
    ] {
        let context = context(mode, code32);
        for (prefix, width) in [
            (&[][..], if code32 { Width::W32 } else { Width::W16 }),
            (&[0x66][..], if code32 { Width::W16 } else { Width::W32 }),
            (
                &[0x66, 0x66][..],
                if code32 { Width::W16 } else { Width::W32 },
            ),
        ] {
            for tail in samples {
                let bytes = [prefix, tail].concat();
                let instruction = decoded(0x1000, &bytes, &context);
                let observed = match instruction.operation {
                    Operation::Mov { width, .. }
                    | Operation::Extend { width, .. }
                    | Operation::Alu { width, .. }
                    | Operation::Unary { width, .. }
                    | Operation::Shift { width, .. }
                    | Operation::DoubleShift { width, .. }
                    | Operation::Bit { width, .. }
                    | Operation::Scan { width, .. }
                    | Operation::Multiply { width, .. }
                    | Operation::Divide { width, .. }
                    | Operation::Imul { width, .. }
                    | Operation::Cmov { width, .. }
                    | Operation::SignHigh { width }
                    | Operation::Push { width, .. }
                    | Operation::Pop { width, .. }
                    | Operation::Call { width, .. }
                    | Operation::JumpRegister { width, .. }
                    | Operation::Return { width, .. } => width,
                    other => panic!("unexpected family {other:?}"),
                };
                assert_eq!(observed, width, "{mode} D={code32}, {bytes:02x?}");
                assert_eq!(instruction.encoded_len(), bytes.len() as u32);
            }
        }
    }
}

#[test]
fn every_address16_form_has_its_own_base_index_displacement_and_segment() {
    let forms = [
        (AddressBase::Register(3), Some(6), Segment::Ds),
        (AddressBase::Register(3), Some(7), Segment::Ds),
        (AddressBase::Register(5), Some(6), Segment::Ss),
        (AddressBase::Register(5), Some(7), Segment::Ss),
        (AddressBase::Register(6), None, Segment::Ds),
        (AddressBase::Register(7), None, Segment::Ds),
        (AddressBase::Register(5), None, Segment::Ss),
        (AddressBase::Register(3), None, Segment::Ds),
    ];
    for (code32, prefix) in [(false, &[][..]), (true, &[0x67][..])] {
        let context = context("protected", code32);
        for mode in 0..3 {
            for (rm, &(mut base, index, mut segment)) in forms.iter().enumerate() {
                let mut bytes = prefix.to_vec();
                bytes.extend([0x8b, mode << 6 | rm as u8]);
                let displacement = match (mode, rm) {
                    (0, 6) => {
                        base = AddressBase::None;
                        segment = Segment::Ds;
                        bytes.extend([0xff, 0xff]);
                        0xffff
                    }
                    (0, _) => 0,
                    (1, _) => {
                        bytes.push(0x80);
                        -128
                    }
                    (2, _) => {
                        bytes.extend([0, 0x80]);
                        -32768
                    }
                    _ => unreachable!(),
                };
                let Operation::Load { address, .. } = decoded(0x1000, &bytes, &context).operation
                else {
                    panic!("expected load")
                };
                assert_eq!(
                    address,
                    Address {
                        base,
                        index: index.map(|register| crate::x86::instruction::AddressIndex {
                            register,
                            scale: 1
                        }),
                        displacement,
                        size: Width::W16,
                        segment
                    },
                    "{bytes:02x?}"
                );
            }
        }
    }
}

#[test]
fn actual_base_selects_ss_while_extended_bases_and_index_only_use_ds() {
    for (bytes, base, index, segment) in [
        (
            &[0x8b, 0x04, 0x24][..],
            AddressBase::Register(4),
            None,
            Segment::Ss,
        ),
        (
            &[0x8b, 0x45, 0][..],
            AddressBase::Register(5),
            None,
            Segment::Ss,
        ),
        (
            &[0x41, 0x8b, 0x04, 0x24][..],
            AddressBase::Register(12),
            None,
            Segment::Ds,
        ),
        (
            &[0x41, 0x8b, 0x45, 0][..],
            AddressBase::Register(13),
            None,
            Segment::Ds,
        ),
        (
            &[0x8b, 0x04, 0xad, 0, 0, 0, 0][..],
            AddressBase::None,
            Some(5),
            Segment::Ds,
        ),
    ] {
        for address32 in [false, true] {
            let mut input = if address32 { vec![0x67] } else { vec![] };
            input.extend(bytes);
            let Operation::Load { address, .. } =
                decoded(0x1000, &input, &ExecutionContext::default()).operation
            else {
                panic!("expected load")
            };
            assert_eq!(
                (
                    address.base,
                    address.index.map(|i| i.register),
                    address.segment
                ),
                (base, index, segment),
                "{input:02x?}"
            );
            assert_eq!(
                address.size,
                if address32 { Width::W32 } else { Width::W64 }
            );
        }
    }
}

#[test]
fn moffs_consumes_the_address_width_and_legacy_segment_selection_uses_last_override() {
    for (context, prefix, size, tail) in [
        (
            context("real", false),
            &[][..],
            Width::W16,
            &[0xff, 0xff][..],
        ),
        (
            context("protected", true),
            &[][..],
            Width::W32,
            &[0xff, 0xff, 0xff, 0xff][..],
        ),
        (
            context("protected", false),
            &[0x67][..],
            Width::W32,
            &[0xff, 0xff, 0xff, 0xff][..],
        ),
        (
            ExecutionContext::default(),
            &[0x67][..],
            Width::W32,
            &[0xff, 0xff, 0xff, 0xff][..],
        ),
        (
            ExecutionContext::default(),
            &[][..],
            Width::W64,
            &[0xff; 8][..],
        ),
    ] {
        let bytes = [prefix, &[0xa0], tail].concat();
        let i = decoded(0x1000, &bytes, &context);
        assert_eq!(i.encoded_len(), bytes.len() as u32);
        assert!(
            matches!(i.operation, Operation::Load { width: Width::W8, address: Address { displacement, size: actual, .. }, .. } if actual == size && displacement as u64 == size.mask())
        );
    }
    for (prefix, segment) in [
        (0x26, Segment::Es),
        (0x2e, Segment::Cs),
        (0x36, Segment::Ss),
        (0x3e, Segment::Ds),
        (0x64, Segment::Fs),
        (0x65, Segment::Gs),
    ] {
        let i = decoded(
            0x1000,
            &[0x64, prefix, 0x8b, 0],
            &context("protected", true),
        );
        assert!(
            matches!(i.operation, Operation::Load { address: Address { segment: actual, .. }, .. } if actual == segment)
        );
    }
}

#[test]
fn repeated_prefixes_respect_the_fifteen_byte_limit_without_an_extra_fetch() {
    for context in [ExecutionContext::default(), context("protected", true)] {
        let mut bytes = vec![0x66; 14];
        bytes.push(0xf5);
        assert_eq!(decoded(0x1000, &bytes, &context).encoded_len(), 15);
        bytes[14] = 0x67;
        let mut reads = 0;
        assert_eq!(
            decode_with_context(0x1000, &context, |_| {
                reads += 1;
                Ok(0x66)
            }),
            Err(DecodeError::InstructionLength)
        );
        assert_eq!(reads, 15);
        for length in 0..15 {
            let mut reads = 0;
            assert_eq!(
                decode_with_context(0x1000, &context, |address| {
                    reads += 1;
                    bytes
                        .get((address - 0x1000) as usize)
                        .filter(|_| reads <= length)
                        .copied()
                        .ok_or_else(|| DecodeError::Fetch(missing(address)))
                }),
                Err(DecodeError::Fetch(missing(0x1000 + length as u64)))
            );
            assert_eq!(reads, length + 1);
        }
    }
}

#[test]
fn mode_collisions_never_admit_another_modes_opcode_or_require_unneeded_bytes() {
    for (mode, code32) in [
        ("real", false),
        ("virtual8086", false),
        ("protected", false),
        ("protected", true),
        ("compatibility", false),
        ("compatibility", true),
    ] {
        let context = context(mode, code32);
        for opcode in 0x40..=0x4f {
            assert!(
                matches!(decoded(0x1000, &[opcode], &context).operation, Operation::Unary { kind, dst: crate::x86::instruction::Location::Register(RegisterView { bank, high_byte: false }), .. } if kind == if opcode < 0x48 { Unary::Inc } else { Unary::Dec } && bank == opcode & 7)
            );
        }
        for opcode in [0x60, 0x61] {
            assert!(matches!(
                decoded(0x1000, &[opcode], &context).operation,
                Operation::CompoundStack(_)
            ));
        }
        for opcode in [0x62, 0xc4, 0xc5] {
            assert_eq!(
                decode_with_context(0x1000, &context, |_| Ok(opcode)),
                Err(DecodeError::Unsupported)
            );
        }
        assert_eq!(
            decode_with_context(0x1000, &context, |_| Ok(0x63)),
            Err(if matches!(mode, "real" | "virtual8086") {
                DecodeError::Invalid
            } else {
                DecodeError::Unsupported
            })
        );
    }
    for opcode in [0x60, 0x61] {
        assert_eq!(at(0x1000, &[opcode]), Err(DecodeError::Invalid));
    }
    for opcode in [0x62, 0xc4, 0xc5] {
        assert_eq!(at(0x1000, &[opcode]), Err(DecodeError::Unsupported));
    }
}
