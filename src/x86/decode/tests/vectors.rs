use super::{at, missing, operation};
use crate::x86::context::{ExecutionContext, Segment};
use crate::x86::decode::{DecodeError, decode_with_context};
use crate::x86::instruction::{
    Address, AddressBase, AddressIndex, Location, Operation, RegisterView, VectorBinary as B,
    VectorCount, VectorInstruction as V, VectorMask, VectorOperand as O, VectorShift,
    VectorShuffle, Width,
};

fn vector(bytes: &[u8]) -> V {
    match operation(bytes) {
        Operation::Vector(instruction) => instruction,
        other => panic!("expected vector, received {other:?}"),
    }
}

fn context(mode: &str, code32: bool) -> ExecutionContext {
    let segments = ["cs", "ss", "ds", "es", "fs", "gs"].into_iter().map(|name| {
        (name.to_string(), serde_json::json!({
            "base":"0x0", "limit":if mode == "virtual8086" {0xffffu32} else {u32::MAX},
            "default32":code32 && mode != "virtual8086", "usable":true,
            "type":if name == "cs" && mode != "virtual8086" {"readable-code"} else {"read-write"}
        }))
    }).collect::<serde_json::Map<_,_>>();
    ExecutionContext::from_json(&serde_json::json!({"mode":mode,"segments":segments})).unwrap()
}

#[test]
fn selected_packed_integer_opcodes_have_exact_lane_and_signedness_models() {
    use Width::*;
    for (opcode, kind) in [
        (0xdb, B::And),
        (0xdf, B::AndNot),
        (0xeb, B::Or),
        (0xef, B::Xor),
        (0xfc, B::Add(W8)),
        (0xfd, B::Add(W16)),
        (0xfe, B::Add(W32)),
        (0xd4, B::Add(W64)),
        (0xf8, B::Sub(W8)),
        (0xf9, B::Sub(W16)),
        (0xfa, B::Sub(W32)),
        (0xfb, B::Sub(W64)),
        (0xec, B::SignedSaturatingAdd(W8)),
        (0xed, B::SignedSaturatingAdd(W16)),
        (0xdc, B::UnsignedSaturatingAdd(W8)),
        (0xdd, B::UnsignedSaturatingAdd(W16)),
        (0xe8, B::SignedSaturatingSub(W8)),
        (0xe9, B::SignedSaturatingSub(W16)),
        (0xd8, B::UnsignedSaturatingSub(W8)),
        (0xd9, B::UnsignedSaturatingSub(W16)),
        (0x74, B::CompareEqual(W8)),
        (0x75, B::CompareEqual(W16)),
        (0x76, B::CompareEqual(W32)),
        (0x64, B::CompareGreater(W8)),
        (0x65, B::CompareGreater(W16)),
        (0x66, B::CompareGreater(W32)),
        (0xda, B::MinUnsignedByte),
        (0xde, B::MaxUnsignedByte),
        (0xea, B::MinSignedWord),
        (0xee, B::MaxSignedWord),
        (0xe0, B::Average(W8)),
        (0xe3, B::Average(W16)),
        (0xd5, B::MulLowWord),
        (0xe5, B::MulHighWord { signed: true }),
        (0xe4, B::MulHighWord { signed: false }),
        (0xf4, B::MulUnsignedDword),
        (0xf5, B::MaddSignedWord),
        (0xf6, B::SumAbsoluteByteDifferences),
        (0x63, B::PackSigned(W16)),
        (0x6b, B::PackSigned(W32)),
        (0x67, B::PackUnsignedWord),
        (0x60, B::UnpackLow(W8)),
        (0x61, B::UnpackLow(W16)),
        (0x62, B::UnpackLow(W32)),
        (0x6c, B::UnpackLow(W64)),
        (0x68, B::UnpackHigh(W8)),
        (0x69, B::UnpackHigh(W16)),
        (0x6a, B::UnpackHigh(W32)),
        (0x6d, B::UnpackHigh(W64)),
    ] {
        assert_eq!(
            vector(&[0x66, 0x0f, opcode, 0xc1]),
            V::Binary {
                kind,
                dst: 0,
                src: O::Register(1)
            },
            "{opcode:02x}"
        );
        assert_eq!(
            vector(&[0x66, 0x4d, 0x0f, opcode, 0xc1]),
            V::Binary {
                kind,
                dst: 8,
                src: O::Register(9)
            }
        );
        assert_eq!(
            at(0x1000, &[0x0f, opcode]),
            if matches!(opcode, 0x6c | 0x6d) {
                Err(DecodeError::Unsupported)
            } else {
                Err(DecodeError::Fetch(missing(0x1002)))
            }
        );
        assert_eq!(
            at(0x1000, &[0x66, 0xf3, 0x0f, opcode]),
            Err(DecodeError::Unsupported)
        );
    }
}

#[test]
fn raw_move_forms_keep_full_narrow_merge_and_alignment_rules_distinct() {
    for (prefix, opcode, bytes, aligned) in [
        (&[][..], 0x10, 16, false),
        (&[0x66][..], 0x10, 16, false),
        (&[][..], 0x28, 16, true),
        (&[0x66][..], 0x28, 16, true),
        (&[0x66][..], 0x6f, 16, true),
        (&[0xf3][..], 0x6f, 16, false),
        (&[0xf3][..], 0x10, 4, false),
        (&[0xf2][..], 0x10, 8, false),
        (&[0xf3][..], 0x7e, 8, false),
    ] {
        let mut code = prefix.to_vec();
        code.extend([0x0f, opcode, 0xc1]);
        let merge = opcode == 0x10 && bytes < 16;
        assert_eq!(
            vector(&code),
            V::Move {
                register: 0,
                operand: O::Register(1),
                bytes,
                preserve_upper: merge,
                aligned,
                store: false
            }
        );
        *code.last_mut().unwrap() = 0x00;
        assert_eq!(
            vector(&code),
            V::Move {
                register: 0,
                operand: O::Memory(Address {
                    base: AddressBase::Register(0),
                    ..Address::default()
                }),
                bytes,
                preserve_upper: false,
                aligned,
                store: false
            }
        );
    }
    for (prefix, opcode, bytes, aligned) in [
        (&[][..], 0x11, 16, false),
        (&[0x66][..], 0x11, 16, false),
        (&[][..], 0x29, 16, true),
        (&[0x66][..], 0x29, 16, true),
        (&[0x66][..], 0x7f, 16, true),
        (&[0xf3][..], 0x7f, 16, false),
        (&[0xf3][..], 0x11, 4, false),
        (&[0xf2][..], 0x11, 8, false),
        (&[0x66][..], 0xd6, 8, false),
    ] {
        let mut code = prefix.to_vec();
        code.extend([0x0f, opcode, 0xc1]);
        assert_eq!(
            vector(&code),
            V::Move {
                register: 0,
                operand: O::Register(1),
                bytes,
                preserve_upper: opcode == 0x11 && bytes < 16,
                aligned,
                store: true
            }
        );
    }
}

#[test]
fn mandatory_prefix_selection_is_independent_of_physical_rex_cancellation() {
    let expected = vector(&[0xf3, 0x0f, 0x6f, 0xc1]);
    for code in [
        &[0x66, 0xf3, 0x0f, 0x6f, 0xc1][..],
        &[0xf3, 0x66, 0x0f, 0x6f, 0xc1][..],
        &[0xf2, 0xf3, 0x0f, 0x6f, 0xc1][..],
    ] {
        assert_eq!(vector(code), expected);
    }
    assert_eq!(
        vector(&[0xf3, 0x41, 0x66, 0x0f, 0x7e, 0xc0]),
        V::Move {
            register: 0,
            operand: O::Register(0),
            bytes: 8,
            preserve_upper: false,
            aligned: false,
            store: false
        }
    );
    assert_eq!(
        vector(&[0xf3, 0x66, 0x41, 0x0f, 0x7e, 0xc0]),
        V::Move {
            register: 0,
            operand: O::Register(8),
            bytes: 8,
            preserve_upper: false,
            aligned: false,
            store: false
        }
    );
    assert_eq!(
        at(0x1000, &[0x66, 0xf3, 0x0f, 0xfc]),
        Err(DecodeError::Unsupported)
    );
    assert_eq!(
        at(0x1000, &[0xf3, 0x0f, 0xb1]),
        Err(DecodeError::Unsupported)
    );
    assert_eq!(operation(&[0xf3, 0x90]), Operation::Nop);
}

#[test]
fn vector_gpr_widths_do_not_use_ordinary_word_operand_defaults() {
    for mode in ["real", "protected", "compatibility", "virtual8086"] {
        for code32 in [false, true] {
            if mode == "virtual8086" && code32 {
                continue;
            }
            let ctx = context(mode, code32);
            for opcode in [0x6e, 0x7e] {
                let bytes = [0x66, 0x0f, opcode, 0xc1];
                let decoded = decode_with_context(0x1000, &ctx, |pc| {
                    bytes
                        .get((pc - 0x1000) as usize)
                        .copied()
                        .ok_or_else(|| DecodeError::Fetch(missing(pc)))
                })
                .unwrap();
                let expected = if opcode == 0x6e {
                    V::ToXmm {
                        dst: 0,
                        src: Location::Register(RegisterView::low(1)),
                        width: Width::W32,
                    }
                } else {
                    V::FromXmm {
                        dst: Location::Register(RegisterView::low(1)),
                        src: 0,
                        width: Width::W32,
                    }
                };
                assert_eq!(decoded.operation, Operation::Vector(expected));
            }
        }
    }
    for (prefix, width) in [
        (&[0x66][..], Width::W32),
        (&[0x66, 0x48][..], Width::W64),
        (&[0x48, 0x66][..], Width::W32),
    ] {
        let mut bytes = prefix.to_vec();
        bytes.extend([0x0f, 0x6e, 0xc1]);
        assert_eq!(
            vector(&bytes),
            V::ToXmm {
                dst: 0,
                src: Location::Register(RegisterView::low(1)),
                width
            }
        );
    }
}

#[test]
fn imported_mode_defaults_change_vector_addresses_without_changing_the_packed_width() {
    for mode in ["real", "protected", "compatibility", "virtual8086"] {
        for code32 in [false, true] {
            if mode == "virtual8086" && code32 {
                continue;
            }
            let ctx = context(mode, code32);
            for override_address in [false, true] {
                let mut bytes = vec![0x66];
                if override_address {
                    bytes.push(0x67);
                }
                bytes.extend([0x0f, 0x6f, 0x38]);
                let address32 = code32 != override_address;
                let decoded = decode_with_context(0x1000, &ctx, |pc| {
                    bytes
                        .get((pc - 0x1000) as usize)
                        .copied()
                        .ok_or_else(|| DecodeError::Fetch(missing(pc)))
                })
                .unwrap();
                assert_eq!(decoded.next_pc, 0x1000 + bytes.len() as u64);
                assert_eq!(
                    decoded.operation,
                    Operation::Vector(V::Move {
                        register: 7,
                        operand: O::Memory(Address {
                            base: AddressBase::Register(if address32 { 0 } else { 3 }),
                            index: (!address32).then_some(AddressIndex {
                                register: 6,
                                scale: 1
                            }),
                            size: if address32 { Width::W32 } else { Width::W16 },
                            ..Address::default()
                        }),
                        bytes: 16,
                        preserve_upper: false,
                        aligned: true,
                        store: false
                    }),
                    "{mode} code32={code32} address_override={override_address}"
                );
            }
        }
    }
}

#[test]
fn vector_shuffles_masks_words_and_shift_models_preserve_selector_bits() {
    for (prefix, opcode, kind) in [
        (0x66, 0x70, VectorShuffle::Dwords),
        (0xf2, 0x70, VectorShuffle::LowWords),
        (0xf3, 0x70, VectorShuffle::HighWords),
        (0x66, 0xc6, VectorShuffle::RawDoubles),
    ] {
        assert_eq!(
            vector(&[prefix, 0x0f, opcode, 0xc1, 0xff]),
            V::Shuffle {
                kind,
                dst: 0,
                src: O::Register(1),
                immediate: 0xff
            }
        );
    }
    assert_eq!(
        vector(&[0x0f, 0xc6, 0xc1, 0x1b]),
        V::Shuffle {
            kind: VectorShuffle::RawSingles,
            dst: 0,
            src: O::Register(1),
            immediate: 0x1b
        }
    );
    assert_eq!(
        vector(&[0x66, 0x0f, 0xc4, 0xc1, 0xff]),
        V::InsertWord {
            dst: 0,
            src: Location::Register(RegisterView::low(1)),
            immediate: 0xff
        }
    );
    assert_eq!(
        vector(&[0x66, 0x0f, 0xc5, 0xc1, 0xff]),
        V::ExtractWord {
            dst: 0,
            src: 1,
            immediate: 0xff
        }
    );
    for (bytes, kind) in [
        (&[0x66, 0x0f, 0xd7, 0xc1][..], VectorMask::Bytes),
        (&[0x0f, 0x50, 0xc1][..], VectorMask::Singles),
        (&[0x66, 0x0f, 0x50, 0xc1][..], VectorMask::Doubles),
    ] {
        assert_eq!(
            vector(bytes),
            V::Mask {
                kind,
                dst: 0,
                src: 1
            }
        );
    }
    for (opcode, width) in [(0x71, Width::W16), (0x72, Width::W32), (0x73, Width::W64)] {
        for (selector, kind) in [
            (2, VectorShift::Right(width)),
            (6, VectorShift::Left(width)),
        ] {
            assert_eq!(
                vector(&[0x66, 0x45, 0x0f, opcode, 0xc0 | (selector << 3), 0xff]),
                V::Shift {
                    kind,
                    dst: 8,
                    count: VectorCount::Immediate(0xff)
                }
            );
        }
        if opcode != 0x73 {
            assert_eq!(
                vector(&[0x66, 0x0f, opcode, 0xe1, 0x10]),
                V::Shift {
                    kind: VectorShift::ArithmeticRight(width),
                    dst: 1,
                    count: VectorCount::Immediate(0x10)
                }
            );
        }
    }
    for (selector, kind) in [(3, VectorShift::ByteRight), (7, VectorShift::ByteLeft)] {
        assert_eq!(
            vector(&[0x66, 0x0f, 0x73, 0xc0 | (selector << 3), 0x10]),
            V::Shift {
                kind,
                dst: 0,
                count: VectorCount::Immediate(0x10)
            }
        );
    }
}

#[test]
fn vector_addresses_keep_the_complete_existing_segment_sib_and_relative_grammar() {
    assert_eq!(
        vector(&[0x67, 0x64, 0x66, 0x45, 0x0f, 0xfc, 0x44, 0x24, 0xf8]),
        V::Binary {
            kind: B::Add(Width::W8),
            dst: 8,
            src: O::Memory(Address {
                base: AddressBase::Register(12),
                displacement: -8,
                size: Width::W32,
                segment: Segment::Fs,
                ..Address::default()
            })
        }
    );
    assert_eq!(
        vector(&[0x66, 0x0f, 0x70, 0x05, 0xff, 0xff, 0xff, 0xff, 0x1b]),
        V::Shuffle {
            kind: VectorShuffle::Dwords,
            dst: 0,
            src: O::Memory(Address {
                base: AddressBase::NextPc,
                displacement: -1,
                ..Address::default()
            }),
            immediate: 0x1b
        }
    );
}

#[test]
fn vector_legality_stops_at_deciding_classes_and_fetches_complete_valid_tails() {
    for code in [
        &[0x66, 0x0f, 0xc5, 0x04][..],
        &[0x66, 0x0f, 0xd7, 0x04][..],
        &[0x0f, 0x50, 0x04][..],
        &[0x66, 0x0f, 0x71, 0x34][..],
    ] {
        assert_eq!(at(0x1000, code), Err(DecodeError::Invalid));
    }
    for code in [
        &[0x66, 0x0f, 0x71, 0x0c][..],
        &[0x66, 0x0f, 0x73, 0x24][..],
        &[0x66, 0x0f, 0x38][..],
        &[0xf3, 0x66, 0x0f, 0xfc][..],
    ] {
        assert_eq!(at(0x1000, code), Err(DecodeError::Unsupported));
    }
    assert_eq!(
        at(0x1000, &[0x0f, 0x6f]),
        Err(DecodeError::Fetch(missing(0x1002)))
    );
    for full in [
        &[0x66, 0x0f, 0xfc, 0x84, 0x24, 0x78, 0x56, 0x34, 0x12][..],
        &[
            0xf0, 0x66, 0x0f, 0x70, 0x84, 0x24, 0x78, 0x56, 0x34, 0x12, 0xff,
        ][..],
        &[0x66, 0x0f, 0xc5, 0xc0, 0xff][..],
        &[0x66, 0x0f, 0x73, 0xf8, 0x10][..],
    ] {
        for length in 0..full.len() {
            assert_eq!(
                at(0x1000, &full[..length]),
                Err(DecodeError::Fetch(missing(0x1000 + length as u64))),
                "{full:02x?} length{length}"
            );
        }
        if full[0] == 0xf0 {
            assert_eq!(at(0x1000, full), Err(DecodeError::Invalid));
        }
    }
    let mut exact = vec![0x66; 12];
    exact.extend([0x0f, 0xfc, 0xc0]);
    assert!(at(0x1000, &exact).is_ok());
    exact.insert(0, 0x66);
    assert_eq!(at(0x1000, &exact), Err(DecodeError::Invalid));
    assert_eq!(at(0x1000, &[0xf0, 0xf3]), Err(DecodeError::Unsupported));
}
