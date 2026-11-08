use super::{at, missing, operation};
use crate::x86::context::{ExecutionContext, Segment};
use crate::x86::decode::{DecodeError, decode_with_context};
use crate::x86::float::{Format, Kind, Op};
use crate::x86::instruction::{
    Address, AddressBase, AddressIndex, FloatInstruction, Location, Operation, RegisterView,
    VectorBinary, VectorInstruction, VectorOperand, Width,
};

fn numeric(bytes: &[u8]) -> FloatInstruction {
    match operation(bytes) {
        Operation::Float(f) => f,
        other => panic!("expected numeric instruction, got{other:?}"),
    }
}
fn op(kind: Kind, format: Format, scalar: bool) -> Op {
    Op {
        kind,
        format,
        scalar,
        integer64: false,
        predicate: 0,
    }
}

#[test]
fn numeric_opcode_selectors_have_exact_formats_sources_and_scalar_merge_views() {
    for (opcode, kind) in [
        (0x58, Kind::Add),
        (0x5c, Kind::Sub),
        (0x59, Kind::Mul),
        (0x5e, Kind::Div),
        (0x51, Kind::Sqrt),
        (0x5d, Kind::Min),
        (0x5f, Kind::Max),
        (0xc2, Kind::Cmp),
    ] {
        for (prefix, format, scalar) in [
            (None, Format::F32, false),
            (Some(0x66), Format::F64, false),
            (Some(0xf3), Format::F32, true),
            (Some(0xf2), Format::F64, true),
        ] {
            let mut code = prefix.into_iter().collect::<Vec<_>>();
            code.extend([0x0f, opcode, 0xc1]);
            if kind == Kind::Cmp {
                code.push(0xff);
            }
            let mut expected = op(kind, format, scalar);
            if kind == Kind::Cmp {
                expected.predicate = 0xff;
            }
            assert_eq!(
                numeric(&code),
                FloatInstruction {
                    op: expected,
                    dst: 0,
                    src: Location::Register(RegisterView::low(1))
                }
            );
            assert_eq!(
                numeric(&code).source_bytes(),
                if scalar {
                    if format == Format::F32 { 4 } else { 8 }
                } else {
                    16
                }
            );
        }
    }
    for (opcode, kind) in [(0x2f, Kind::Comi), (0x2e, Kind::Ucomi)] {
        for prefix in [None, Some(0x66)] {
            let mut code = prefix.into_iter().collect::<Vec<_>>();
            code.extend([0x0f, opcode, 0xc1]);
            let f = numeric(&code);
            assert_eq!(
                f.op,
                op(
                    kind,
                    if prefix.is_some() {
                        Format::F64
                    } else {
                        Format::F32
                    },
                    true
                )
            );
            assert!(f.writes_flags());
        }
        for prefix in [0xf2, 0xf3] {
            assert_eq!(
                at(0x1000, &[prefix, 0x0f, opcode]),
                Err(DecodeError::Unsupported)
            );
        }
    }
    for (opcode, kind) in [(0x53, Kind::Rcp), (0x52, Kind::Rsqrt)] {
        for prefix in [None, Some(0xf3)] {
            let mut code = prefix.into_iter().collect::<Vec<_>>();
            code.extend([0x0f, opcode, 0xc1]);
            assert_eq!(numeric(&code).op, op(kind, Format::F32, prefix.is_some()));
        }
        for prefix in [0x66, 0xf2] {
            assert_eq!(
                at(0x1000, &[prefix, 0x0f, opcode]),
                Err(DecodeError::Unsupported)
            );
        }
    }
}

#[test]
fn conversions_have_exact_narrow_source_spans_gpr_widths_and_rex_extensions() {
    for (prefix, opcode, kind, format, scalar, source_bytes) in [
        (None, 0x5a, Kind::FloatConvert, Format::F32, false, 8),
        (Some(0x66), 0x5a, Kind::FloatConvert, Format::F64, false, 16),
        (Some(0xf3), 0x5a, Kind::FloatConvert, Format::F32, true, 4),
        (Some(0xf2), 0x5a, Kind::FloatConvert, Format::F64, true, 8),
        (None, 0x5b, Kind::IntToFloat, Format::F32, false, 16),
        (Some(0x66), 0x5b, Kind::FloatToInt, Format::F32, false, 16),
        (Some(0xf3), 0x5b, Kind::TruncToInt, Format::F32, false, 16),
        (Some(0xf3), 0xe6, Kind::IntToFloat, Format::F64, false, 8),
        (Some(0xf2), 0xe6, Kind::FloatToInt, Format::F64, false, 16),
        (Some(0x66), 0xe6, Kind::TruncToInt, Format::F64, false, 16),
    ] {
        let mut code = prefix.into_iter().collect::<Vec<_>>();
        code.extend([0x4d, 0x0f, opcode, 0xc1]);
        let f = numeric(&code);
        assert_eq!(f.op, op(kind, format, scalar));
        assert_eq!(f.source_bytes(), source_bytes);
        assert_eq!(f.dst, 8);
        assert_eq!(f.src, Location::Register(RegisterView::low(9)));
    }
    for (opcode, kind) in [
        (0x2a, Kind::IntToFloat),
        (0x2d, Kind::FloatToInt),
        (0x2c, Kind::TruncToInt),
    ] {
        for (prefix, format) in [(0xf3, Format::F32), (0xf2, Format::F64)] {
            for wide in [false, true] {
                let f = numeric(&[prefix, if wide { 0x4d } else { 0x45 }, 0x0f, opcode, 0xc1]);
                let mut expected = op(kind, format, true);
                expected.integer64 = wide;
                assert_eq!(f.op, expected);
                assert_eq!(f.source_is_gpr(), kind == Kind::IntToFloat);
                assert_eq!(f.destination_is_gpr(), kind != Kind::IntToFloat);
                assert_eq!(f.dst, 8);
                assert_eq!(f.src, Location::Register(RegisterView::low(9)));
                assert_eq!(
                    f.source_bytes(),
                    if kind == Kind::IntToFloat {
                        if wide { 8 } else { 4 }
                    } else if format == Format::F32 {
                        4
                    } else {
                        8
                    }
                );
            }
        }
    }
}

#[test]
fn raw_logic_interleave_and_half_directions_reuse_bit_preserving_vector_models() {
    for (prefix, width) in [(None, Width::W32), (Some(0x66), Width::W64)] {
        for (opcode, kind) in [
            (0x54, VectorBinary::And),
            (0x55, VectorBinary::AndNot),
            (0x56, VectorBinary::Or),
            (0x57, VectorBinary::Xor),
            (0x14, VectorBinary::UnpackLow(width)),
            (0x15, VectorBinary::UnpackHigh(width)),
        ] {
            let mut code = prefix.into_iter().collect::<Vec<_>>();
            code.extend([0x0f, opcode, 0xc1]);
            assert_eq!(
                operation(&code),
                Operation::Vector(VectorInstruction::Binary {
                    kind,
                    dst: 0,
                    src: VectorOperand::Register(1)
                })
            );
        }
        for opcode in [0x12, 0x13, 0x16, 0x17] {
            let mut code = prefix.into_iter().collect::<Vec<_>>();
            code.extend([0x0f, opcode, 0x00]);
            assert_eq!(
                operation(&code),
                Operation::Vector(VectorInstruction::HalfMove {
                    register: 0,
                    operand: VectorOperand::Memory(Address {
                        base: AddressBase::Register(0),
                        ..Address::default()
                    }),
                    high: opcode >= 0x16,
                    store: opcode & 1 != 0
                })
            );
            code.pop();
            code.push(0xc1);
            if prefix.is_none() && opcode & 1 == 0 {
                assert_eq!(
                    operation(&code),
                    Operation::Vector(VectorInstruction::HalfMove {
                        register: 0,
                        operand: VectorOperand::Register(1),
                        high: opcode == 0x16,
                        store: false
                    })
                );
            } else {
                assert_eq!(at(0x1000, &code), Err(DecodeError::Invalid));
            }
        }
    }
}

#[test]
fn mxcsr_groups_preserve_deciding_class_and_complete_valid_tails_before_lock_rejection() {
    for (selector, store) in [(2, false), (3, true)] {
        for rex in [0x40, 0x44, 0x48, 0x4c] {
            assert_eq!(
                operation(&[rex, 0x0f, 0xae, selector << 3]),
                Operation::Mxcsr {
                    address: Address {
                        base: AddressBase::Register(0),
                        ..Address::default()
                    },
                    store
                }
            );
        }
        assert_eq!(
            at(0x1000, &[0x0f, 0xae, 0xc4 | (selector << 3)]),
            Err(DecodeError::Invalid)
        );
    }
    for selector in [4, 5, 6, 7] {
        assert_eq!(
            at(0x1000, &[0x0f, 0xae, 4 | (selector << 3)]),
            Err(DecodeError::Unsupported)
        );
    }
    for selector in [0, 1] {
        assert_eq!(
            at(0x1000, &[0x0f, 0xae, 4 | (selector << 3)]),
            Err(DecodeError::Fetch(missing(0x1003)))
        );
    }
    for prefix in [0x66, 0xf2, 0xf3] {
        assert_eq!(
            at(0x1000, &[prefix, 0x0f, 0xae]),
            Err(DecodeError::Unsupported)
        );
    }
    for full in [
        &[0x0f, 0xae, 0x94, 0x24, 0, 0, 0, 0][..],
        &[0xf0, 0x0f, 0xae, 0x94, 0x24, 0, 0, 0, 0],
        &[0xf3, 0x0f, 0xc2, 0x84, 0x24, 0, 0, 0, 0, 0xff],
        &[0xf0, 0xf3, 0x0f, 0x58, 0x84, 0x24, 0, 0, 0, 0],
    ] {
        // Mixed LOCK/repeat stops at the deciding prefix rather than fetching a tail.
        if full.starts_with(&[0xf0, 0xf3]) {
            assert_eq!(at(0x1000, full), Err(DecodeError::Unsupported));
            continue;
        }
        for length in 1..full.len() {
            assert_eq!(
                at(0x1000, &full[..length]),
                Err(DecodeError::Fetch(missing(0x1000 + length as u64))),
                "{full:02x?} / {length}"
            );
        }
        if full[0] == 0xf0 {
            assert_eq!(at(0x1000, full), Err(DecodeError::Invalid));
        }
    }
}

#[test]
fn numeric_addresses_use_full_existing_sib_segment_and_completed_next_pc_grammar() {
    let f = numeric(&[
        0xf3, 0x64, 0x67, 0x44, 0x0f, 0x58, 0x84, 0x8d, 0xf0, 0xff, 0xff, 0xff,
    ]);
    assert_eq!(f.dst, 8);
    assert_eq!(
        f.src,
        Location::Memory(Address {
            base: AddressBase::Register(5),
            index: Some(AddressIndex {
                register: 1,
                scale: 4
            }),
            displacement: -16,
            size: Width::W32,
            segment: Segment::Fs
        })
    );
    let f = numeric(&[0xf3, 0x0f, 0xc2, 0x05, 0xf8, 0xff, 0xff, 0xff, 0xaa]);
    assert_eq!(
        f.src,
        Location::Memory(Address {
            base: AddressBase::NextPc,
            index: None,
            displacement: -8,
            size: Width::W64,
            segment: Segment::Ds
        })
    );
    assert_eq!(
        at(
            0x1000,
            &[0xf3, 0x0f, 0xc2, 0x05, 0xf8, 0xff, 0xff, 0xff, 0xaa]
        )
        .unwrap()
        .next_pc,
        0x1009
    );
}

#[test]
fn imported_modes_select_numeric_addresses_without_narrowing_float_or_gpr_results() {
    for mode in ["real", "protected", "compatibility", "virtual8086"] {
        for code32 in [false, true] {
            for stack32 in [false, true] {
                if mode == "virtual8086" && (code32 || stack32) {
                    continue;
                }
                let segments=["cs","ss","ds","es","fs","gs"].into_iter().map(|name|(name.to_string(),serde_json::json!({"base":"0x0","limit":if mode=="virtual8086"{0xffffu32}else{u32::MAX},"default32":if mode=="virtual8086"{false}else if name=="cs"{code32}else if name=="ss"{stack32}else{true},"usable":true,"type":if name=="cs"&&mode!="virtual8086"{"readable-code"}else{"read-write"}}))).collect::<serde_json::Map<_,_>>();
                let context = ExecutionContext::from_json(
                    &serde_json::json!({"mode":mode,"segments":segments}),
                )
                .unwrap();
                for address_override in [false, true] {
                    let address16 = code32 == address_override;
                    for (opcode, kind) in [
                        (0x58, Kind::Add),
                        (0x2d, Kind::FloatToInt),
                        (0x2a, Kind::IntToFloat),
                    ] {
                        let mut code = vec![0xf3];
                        if address_override {
                            code.push(0x67);
                        }
                        code.extend([0x0f, opcode, if address16 { 7 } else { 0 }]);
                        let decoded = decode_with_context(0x1000, &context, |at| {
                            code.get((at - 0x1000) as usize).copied().ok_or_else(|| {
                                DecodeError::Fetch(missing(0x1000 + code.len() as u64))
                            })
                        })
                        .unwrap();
                        let Operation::Float(f) = decoded.operation else {
                            panic!("float")
                        };
                        assert_eq!(f.op, op(kind, Format::F32, true));
                        assert_eq!(f.source_bytes(), 4);
                        let Location::Memory(address) = f.src else {
                            panic!("memory")
                        };
                        assert_eq!(
                            address.size,
                            if address16 { Width::W16 } else { Width::W32 }
                        );
                        assert_eq!(
                            address.base,
                            AddressBase::Register(if address16 { 3 } else { 0 })
                        );
                    }
                }
            }
        }
    }
}
