use super::{at, missing, operation};
use crate::x86::context::{ExecutionContext, Segment};
use crate::x86::decode::{DecodeError, decode_with_context};
use crate::x86::instruction::{
    Address, AddressBase, AddressIndex, Operation, Width, X87Instruction,
};
use crate::x86::x87::{Format, Kind, Op};

fn x87(bytes: &[u8]) -> X87Instruction {
    let Operation::X87(instruction) = operation(bytes) else {
        panic!("expected x87")
    };
    assert_eq!(Op::decode(instruction.op.encode()), instruction.op);
    instruction
}

fn expected(kind: Kind, format: Format, index: u8, pop: u8, encoding: u16) -> Op {
    Op {
        kind,
        format,
        index,
        pop,
        encoding,
        ..Op::default()
    }
}

#[test]
fn standalone_wait_needs_no_following_opcode_and_keeps_its_own_retirement_boundary() {
    for pc in [0x1000, u64::MAX] {
        let instruction = at(pc, &[0x9b]).unwrap();
        assert_eq!(instruction.next_pc, pc.wrapping_add(1));
    }
    let first = at(0x1000, &[0x9b, 0xdb, 0xe3]).unwrap();
    assert_eq!(first.next_pc, 0x1001);
    assert_eq!(at(0x1000, &[0xf0, 0x9b]), Err(DecodeError::Invalid));
    assert_eq!(
        at(0x1000, &[0xd9]),
        Err(DecodeError::Fetch(missing(0x1001)))
    );
    assert_eq!(
        x87(&[0x9b]).op,
        Op {
            kind: Kind::Wait,
            ..Op::default()
        }
    );
}

#[test]
fn selected_register_directions_pop_counts_and_indices_are_not_rex_extended() {
    use Kind::*;
    for (opcode, base, kind, destination_index, pop) in [
        (0xd8, 0xc0, Add, false, 0),
        (0xd8, 0xc8, Mul, false, 0),
        (0xd8, 0xe0, Sub, false, 0),
        (0xd8, 0xe8, SubReverse, false, 0),
        (0xd8, 0xf0, Div, false, 0),
        (0xd8, 0xf8, DivReverse, false, 0),
        (0xdc, 0xc0, Add, true, 0),
        (0xdc, 0xc8, Mul, true, 0),
        (0xdc, 0xe0, SubReverse, true, 0),
        (0xdc, 0xe8, Sub, true, 0),
        (0xdc, 0xf0, DivReverse, true, 0),
        (0xdc, 0xf8, Div, true, 0),
        (0xde, 0xc0, Add, true, 1),
        (0xde, 0xc8, Mul, true, 1),
        (0xde, 0xe0, SubReverse, true, 1),
        (0xde, 0xe8, Sub, true, 1),
        (0xde, 0xf0, DivReverse, true, 1),
        (0xde, 0xf8, Div, true, 1),
        (0xd8, 0xd0, Compare, false, 0),
        (0xd8, 0xd8, Compare, false, 1),
        (0xdd, 0xe0, CompareUnordered, false, 0),
        (0xdd, 0xe8, CompareUnordered, false, 1),
        (0xdb, 0xf0, CompareFlags, false, 0),
        (0xdb, 0xe8, CompareUnorderedFlags, false, 0),
        (0xdf, 0xf0, CompareFlags, false, 1),
        (0xdf, 0xe8, CompareUnorderedFlags, false, 1),
        (0xd9, 0xc0, Load, false, 0),
        (0xd9, 0xc8, Exchange, false, 0),
        (0xdd, 0xc0, Free, false, 0),
        (0xdd, 0xd0, Store, false, 0),
        (0xdd, 0xd8, Store, false, 1),
    ] {
        for index in 0..8 {
            let modrm = base + index;
            let mut expected = expected(
                kind,
                Format::Register,
                index,
                pop,
                (u16::from(opcode & 7) << 8) | u16::from(modrm),
            );
            expected.dest_index = destination_index;
            for prefix in [vec![], vec![0x4f], vec![0x66, 0xf2, 0xf3, 0x4f]] {
                let mut bytes = prefix;
                bytes.extend([opcode, modrm]);
                assert_eq!(
                    x87(&bytes),
                    X87Instruction {
                        op: expected,
                        address: None
                    },
                    "{bytes:02x?}"
                );
            }
        }
    }
    for (opcode, modrm, kind) in [(0xda, 0xe9, CompareUnordered), (0xde, 0xd9, Compare)] {
        assert_eq!(
            x87(&[opcode, modrm]).op,
            expected(
                kind,
                Format::Register,
                1,
                2,
                (u16::from(opcode & 7) << 8) | u16::from(modrm)
            )
        );
    }
}

#[test]
fn every_esc_selector_admits_exactly_the_documented_selection_and_rejects_lock() {
    let mut registers = 0;
    let mut memory = 0;
    for opcode in 0xd8..=0xdf {
        for modrm in 0xc0..=0xff {
            let selected = match opcode {
                0xd8 => true,
                0xd9 => {
                    matches!(modrm, 0xc0..=0xd0 | 0xe0 | 0xe1 | 0xe4 | 0xe5 | 0xe8..=0xee | 0xf6 | 0xf7 | 0xfa | 0xfc)
                }
                0xda => matches!(modrm, 0xc0..=0xdf | 0xe9),
                0xdb => matches!(modrm, 0xc0..=0xdf | 0xe2 | 0xe3 | 0xe8..=0xf7),
                0xdc => matches!(modrm, 0xc0..=0xcf | 0xe0..=0xff),
                0xdd => matches!(modrm, 0xc0..=0xc7 | 0xd0..=0xef),
                0xde => matches!(modrm, 0xc0..=0xcf | 0xd9 | 0xe0..=0xff),
                0xdf => matches!(modrm, 0xe0 | 0xe8..=0xf7),
                _ => unreachable!(),
            };
            let decoded = at(0x1000, &[opcode, modrm]);
            if selected {
                assert!(decoded.is_ok(), "{opcode:02x} {modrm:02x}");
                assert_eq!(
                    at(0x1000, &[0xf0, opcode, modrm]),
                    Err(DecodeError::Invalid)
                );
                registers += 1;
            } else {
                assert_eq!(
                    decoded,
                    Err(DecodeError::Unsupported),
                    "{opcode:02x} {modrm:02x}"
                );
            }
        }
        for selector in 0..8 {
            let selected = match opcode {
                0xd8 | 0xda | 0xdc | 0xde => true,
                0xd9 => matches!(selector, 0 | 2..=7),
                0xdd => matches!(selector, 0 | 2..=4 | 6 | 7),
                0xdb | 0xdf => matches!(selector, 0 | 2 | 3 | 5 | 7),
                _ => unreachable!(),
            };
            let modrm = (selector << 3) | 3;
            let decoded = at(0x1000, &[opcode, modrm]);
            if selected {
                assert!(decoded.is_ok(), "{opcode:02x} /{selector}");
                assert_eq!(
                    at(0x1000, &[0xf0, opcode, modrm]),
                    Err(DecodeError::Invalid)
                );
                memory += 1;
            } else {
                assert_eq!(
                    decoded,
                    Err(DecodeError::Unsupported),
                    "{opcode:02x} /{selector}"
                );
            }
        }
    }
    assert_eq!((registers, memory), (333, 55));
}

#[test]
fn conditional_moves_fixed_controls_and_constants_retain_their_distinct_operation_fields() {
    for (opcode, condition_base) in [(0xda, 0), (0xdb, 4)] {
        for condition in 0..4 {
            for index in 0..8 {
                let modrm = 0xc0 + condition * 8 + index;
                let mut expected = expected(
                    Kind::ConditionalMove,
                    Format::Register,
                    index,
                    0,
                    (u16::from(opcode & 7) << 8) | u16::from(modrm),
                );
                expected.condition = condition_base + condition;
                assert_eq!(x87(&[opcode, modrm]).op, expected);
            }
        }
    }
    for (opcode, modrm, kind, format) in [
        (0xd9, 0xd0, Kind::Nop, Format::None),
        (0xd9, 0xe0, Kind::ChangeSign, Format::None),
        (0xd9, 0xe1, Kind::Abs, Format::None),
        (0xd9, 0xe4, Kind::Test, Format::None),
        (0xd9, 0xe5, Kind::Examine, Format::None),
        (0xd9, 0xf6, Kind::DecTop, Format::None),
        (0xd9, 0xf7, Kind::IncTop, Format::None),
        (0xd9, 0xfa, Kind::Sqrt, Format::None),
        (0xd9, 0xfc, Kind::Round, Format::None),
        (0xdb, 0xe2, Kind::Clear, Format::None),
        (0xdb, 0xe3, Kind::Init, Format::None),
        (0xdf, 0xe0, Kind::StoreStatus, Format::Ax),
    ] {
        let op = x87(&[opcode, modrm]).op;
        assert_eq!(
            op,
            expected(
                kind,
                format,
                0,
                0,
                (u16::from(opcode & 7) << 8) | u16::from(modrm)
            )
        );
        assert_eq!(
            op.is_waiting(),
            !matches!(kind, Kind::Clear | Kind::Init | Kind::StoreStatus)
        );
    }
    for index in 0..7 {
        assert_eq!(
            x87(&[0xd9, 0xe8 + index]).op,
            expected(
                Kind::Constant,
                Format::None,
                index,
                0,
                0x1e8 + u16::from(index)
            )
        );
    }
}

#[test]
fn memory_forms_have_opcode_defined_formats_and_complete_original_fop() {
    use Format::*;
    use Kind::*;
    let mut forms = Vec::new();
    for (opcode, format) in [(0xd8, F32), (0xdc, F64), (0xda, I32), (0xde, I16)] {
        for (selector, kind) in [
            (0, Add),
            (1, Mul),
            (2, Compare),
            (3, Compare),
            (4, Sub),
            (5, SubReverse),
            (6, Div),
            (7, DivReverse),
        ] {
            forms.push((opcode, selector, kind, format, u8::from(selector == 3)));
        }
    }
    forms.extend([
        (0xd9, 0, Load, F32, 0),
        (0xdd, 0, Load, F64, 0),
        (0xdb, 5, Load, F80, 0),
        (0xdf, 0, Load, I16, 0),
        (0xdb, 0, Load, I32, 0),
        (0xdf, 5, Load, I64, 0),
        (0xd9, 2, Store, F32, 0),
        (0xdd, 2, Store, F64, 0),
        (0xd9, 3, Store, F32, 1),
        (0xdd, 3, Store, F64, 1),
        (0xdb, 7, Store, F80, 1),
        (0xdf, 2, Store, I16, 0),
        (0xdb, 2, Store, I32, 0),
        (0xdf, 3, Store, I16, 1),
        (0xdb, 3, Store, I32, 1),
        (0xdf, 7, Store, I64, 1),
        (0xd9, 5, LoadControl, None, 0),
        (0xd9, 7, StoreControl, None, 0),
        (0xdd, 7, StoreStatus, None, 0),
    ]);
    for (opcode, selector, kind, format, pop) in forms {
        let modrm = (selector << 3) | 3;
        for prefix in [vec![], vec![0x66], vec![0xf2, 0xf3], vec![0x4c]] {
            let mut bytes = prefix;
            bytes.extend([opcode, modrm]);
            let decoded = x87(&bytes);
            assert_eq!(
                decoded.op,
                expected(
                    kind,
                    format,
                    0,
                    pop,
                    (u16::from(opcode & 7) << 8) | u16::from(modrm)
                ),
                "{bytes:02x?}"
            );
            assert_eq!(
                decoded.address,
                Some(Address {
                    base: AddressBase::Register(3),
                    ..Address::default()
                })
            );
            assert!(matches!(decoded.op.memory_bytes(), 2 | 4 | 8 | 10));
        }
    }
}

#[test]
fn required_x87_address_tails_precede_lock_rejection_but_unselected_forms_stop_at_modrm() {
    for full in [
        &[0xd9, 0x84, 0x24, 1, 2, 3, 4][..],
        &[0xf0, 0xd9, 0x84, 0x24, 1, 2, 3, 4],
        &[0xf0, 0xdb, 0xbc, 0x24, 1, 2, 3, 4],
    ] {
        for length in 1..full.len() {
            assert_eq!(
                at(0x1000, &full[..length]),
                Err(DecodeError::Fetch(missing(0x1000 + length as u64))),
                "{full:02x?} length{length}"
            );
        }
        if full.contains(&0xf0) {
            assert_eq!(at(0x1000, full), Err(DecodeError::Invalid));
        } else {
            assert!(at(0x1000, full).is_ok());
        }
    }
    for prefix in [&[0xf3, 0xf0][..], &[0xf0, 0xf2]] {
        assert_eq!(at(0x1000, prefix), Err(DecodeError::Unsupported));
    }
    for code in [
        [0xdf, 0x24],
        [0xdf, 0x34],
        [0xdd, 0x0c],
        [0xdb, 0x0c],
        [0xdf, 0x0c],
        [0xdc, 0xd0],
        [0xdc, 0xd8],
        [0xd9, 0xd8],
        [0xdd, 0xc8],
        [0xde, 0xd0],
        [0xdf, 0xc0],
        [0xdb, 0xe0],
        [0xdb, 0xe1],
        [0xdb, 0xe4],
        [0xd9, 0xf0],
        [0xd9, 0xf1],
        [0xd9, 0xf2],
        [0xd9, 0xf3],
        [0xd9, 0xf4],
        [0xd9, 0xf5],
        [0xd9, 0xf8],
        [0xd9, 0xf9],
        [0xd9, 0xfb],
        [0xd9, 0xfd],
        [0xd9, 0xfe],
        [0xd9, 0xff],
    ] {
        assert_eq!(
            at(0x1000, &code),
            Err(DecodeError::Unsupported),
            "{code:02x?}"
        );
    }
    let mut longest = vec![0x66; 13];
    longest.extend([0xd9, 0xe8]);
    assert_eq!(at(0x1000, &longest).unwrap().encoded_len(), 15);
    longest.insert(0, 0x66);
    assert_eq!(at(0x1000, &longest), Err(DecodeError::InstructionLength));
    assert_eq!(
        at(u64::MAX, &[0xd9]),
        Err(DecodeError::Fetch(crate::memory::Fault {
            address: u64::MAX,
            width: 2,
            access: crate::memory::Access::Execute,
            cause: crate::memory::Cause::AddressRange,
            failing: 1u128 << 64
        }))
    );
}

#[test]
fn x87_memory_reuses_sib_rip_relative_address_prefixes_and_rex_cancellation() {
    let f = x87(&[
        0xf2, 0x66, 0x64, 0x67, 0x4f, 0xdb, 0xac, 0x8d, 0xf0, 0xff, 0xff, 0xff,
    ]);
    assert_eq!(f.op.kind, Kind::Load);
    assert_eq!(f.op.format, Format::F80);
    assert_eq!(f.op.encoding, 0x3ac);
    assert_eq!(
        f.address,
        Some(Address {
            base: AddressBase::Register(13),
            index: Some(AddressIndex {
                register: 9,
                scale: 4
            }),
            displacement: -16,
            size: Width::W32,
            segment: Segment::Fs
        })
    );
    let cancelled = x87(&[0x4f, 0x66, 0xdb, 0x6d, 0xf0]);
    assert_eq!(cancelled.address.unwrap().base, AddressBase::Register(5));
    assert_eq!(cancelled.address.unwrap().segment, Segment::Ss);
    let relative = x87(&[0xdb, 0x2d, 0xf8, 0xff, 0xff, 0xff]);
    assert_eq!(relative.address.unwrap().base, AddressBase::NextPc);
    assert_eq!(relative.address.unwrap().displacement, -8);
    assert_eq!(relative.address.unwrap().size, Width::W64);
}

#[test]
fn all_fourteen_profiles_change_addresses_without_changing_x87_formats_or_stack_indices() {
    let mut contexts = vec![ExecutionContext::default()];
    for mode in ["real", "protected", "compatibility", "virtual8086"] {
        for code32 in [false, true] {
            for stack32 in [false, true] {
                if mode == "virtual8086" && (code32 || stack32) {
                    continue;
                }
                let segments = ["cs", "ss", "ds", "es", "fs", "gs"].into_iter().map(|name| (name.to_string(), serde_json::json!({"base":"0x0","limit":if mode=="virtual8086"{0xffffu32}else{u32::MAX},"default32":if mode=="virtual8086"{false}else if name=="cs"{code32}else if name=="ss"{stack32}else{true},"usable":true,"type":if name=="cs" && mode!="virtual8086"{"readable-code"}else{"read-write"}}))).collect::<serde_json::Map<_,_>>();
                contexts.push(
                    ExecutionContext::from_json(
                        &serde_json::json!({"mode":mode,"segments":segments}),
                    )
                    .unwrap(),
                );
            }
        }
    }
    assert_eq!(contexts.len(), 14);
    for context in contexts {
        for override_address in [false, true] {
            let expected_width = if context.is_long64() {
                if override_address {
                    Width::W32
                } else {
                    Width::W64
                }
            } else if context.code32() != override_address {
                Width::W32
            } else {
                Width::W16
            };
            let mut bytes = vec![0xf3, 0x66];
            if override_address {
                bytes.push(0x67);
            }
            bytes.extend([
                0xdb,
                if expected_width == Width::W16 {
                    0x2f
                } else {
                    0x2b
                },
            ]);
            let instruction = decode_with_context(0x1000, &context, |pc| {
                bytes
                    .get((pc - 0x1000) as usize)
                    .copied()
                    .ok_or_else(|| DecodeError::Fetch(missing(pc)))
            })
            .unwrap();
            let Operation::X87(decoded) = instruction.operation else {
                panic!("x87")
            };
            assert_eq!(decoded.op.kind, Kind::Load);
            assert_eq!(decoded.op.format, Format::F80);
            let address = decoded.address.unwrap();
            assert_eq!(address.base, AddressBase::Register(3));
            assert_eq!(address.size, expected_width);
            assert_eq!(address.segment, Segment::Ds);
        }
    }
}
