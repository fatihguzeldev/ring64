use super::*;
mod boundaries;
use crate::embedding::layout::{BUDGET, DATA, DISPATCH};
use crate::x86::context::Segment;
use crate::x86::instruction::{
    Address, AddressBase, Location, VectorBinary, VectorCount, VectorInstruction, VectorMask,
    VectorOperand, VectorShift, VectorShuffle,
};

fn packet(
    operation: VectorInstruction,
    input: &[(usize, u128)],
    expected: &[(usize, u128)],
    reason: i32,
) -> Value {
    let p = case(
        vec![Instruction {
            pc: 0x1000,
            next_pc: 0x1004,
            operation: Operation::Vector(operation),
        }],
        &[(0, 0x6001)],
        0xcd7,
        0x1000,
        1,
        (
            &[],
            0xcd7,
            if reason == BUDGET || reason == DISPATCH {
                0x1004
            } else {
                0x1000
            },
            reason as u32,
            u64::from(reason != BUDGET && reason != DISPATCH),
        ),
    );
    with_xmm(p, input, expected)
}

fn with_xmm(mut p: Value, input: &[(usize, u128)], expected: &[(usize, u128)]) -> Value {
    let mut xmm =
        std::array::from_fn::<_, 16, _>(|i| 0x112233445566778899aabbcc00000000u128 + i as u128);
    for &(i, value) in input {
        xmm[i] = value;
    }
    let mut result = xmm;
    for &(i, value) in expected {
        result[i] = value;
    }
    p["xmm"] = json!(xmm.map(|value| format!("{value:x}")));
    p["expected"]["xmm"] = json!(result.map(|value| format!("{value:x}")));
    p["repeatBudget"] = json!(23);
    p["expected"]["repeatRemaining"] = json!("23");
    p
}

#[test]
fn gpr_transfers_masks_and_word_insert_extract_obey_fixed_scalar_widths() {
    let raw = 0x800000007fffffff8000ffff12345678u128;
    let old = 0x112233445566778899aabbccddeeff00u128;
    let scalar = 0xfedcba9876543210u64;
    let mut cases = vec![];
    for width in [Width::W32, Width::W64] {
        let mut p = packet(
            VectorInstruction::ToXmm {
                dst: 15,
                src: Location::Register(RegisterView::low(0)),
                width,
            },
            &[],
            &[(
                15,
                if width == Width::W32 {
                    u128::from(scalar as u32)
                } else {
                    u128::from(scalar)
                },
            )],
            BUDGET,
        );
        p["registers"][0] = json!(format!("{scalar:x}"));
        p["expected"]["registers"][0] = p["registers"][0].clone();
        cases.push(p);
        let mut p = packet(
            VectorInstruction::FromXmm {
                dst: Location::Register(RegisterView::low(0)),
                src: 15,
                width,
            },
            &[(15, raw)],
            &[],
            BUDGET,
        );
        p["expected"]["registers"][0] = json!(format!(
            "{:x}",
            if width == Width::W32 {
                raw as u32 as u64
            } else {
                raw as u64
            }
        ));
        cases.push(p);
    }
    for kind in [VectorMask::Bytes, VectorMask::Singles, VectorMask::Doubles] {
        let bits = match kind {
            VectorMask::Bytes => 8,
            VectorMask::Singles => 32,
            VectorMask::Doubles => 64,
        };
        let result = lanes(raw, bits)
            .into_iter()
            .enumerate()
            .fold(0u64, |mask, (i, v)| mask | ((v >> (bits - 1)) << i));
        let mut p = packet(
            VectorInstruction::Mask {
                kind,
                dst: 0,
                src: 15,
            },
            &[(15, raw)],
            &[],
            BUDGET,
        );
        p["expected"]["registers"][0] = json!(format!("{result:x}"));
        cases.push(p);
    }
    for immediate in 0..=255 {
        let lane = u32::from(immediate & 7);
        let expected =
            (old & !(0xffffu128 << (lane * 16))) | (u128::from(scalar as u16) << (lane * 16));
        let mut p = packet(
            VectorInstruction::InsertWord {
                dst: 15,
                src: Location::Register(RegisterView::low(0)),
                immediate,
            },
            &[(15, old)],
            &[(15, expected)],
            BUDGET,
        );
        p["registers"][0] = json!(format!("{scalar:x}"));
        p["expected"]["registers"][0] = p["registers"][0].clone();
        cases.push(p);
        let mut p = packet(
            VectorInstruction::ExtractWord {
                dst: 0,
                src: 15,
                immediate,
            },
            &[(15, raw)],
            &[],
            BUDGET,
        );
        p["expected"]["registers"][0] = json!(format!("{:x}", (raw >> (lane * 16)) & 0xffff));
        cases.push(p);
    }
    // W32 transfers preserve the inactive high GPR dword in both protected CS.D settings.
    for code32 in [false, true] {
        let segments: serde_json::Map<_, _> = Segment::ALL
            .into_iter()
            .map(|segment| {
                (
                    segment.name().into(),
                    json!({
                        "base":"0x0","limit":u32::MAX,"default32":code32,"usable":true,
                        "type":if segment == Segment::Cs { "readable-code" } else { "read-write" }
                    }),
                )
            })
            .collect();
        let context = crate::x86::context::ExecutionContext::from_json(
            &json!({"mode":"protected","segments":segments}),
        )
        .unwrap();
        for operation in [
            VectorInstruction::FromXmm {
                dst: Location::Register(RegisterView::low(0)),
                src: 7,
                width: Width::W32,
            },
            VectorInstruction::ExtractWord {
                dst: 0,
                src: 7,
                immediate: 3,
            },
            VectorInstruction::Mask {
                kind: VectorMask::Bytes,
                dst: 0,
                src: 7,
            },
        ] {
            let result = match operation {
                VectorInstruction::FromXmm { .. } => raw as u32 as u64,
                VectorInstruction::ExtractWord { .. } => ((raw >> 48) & 0xffff) as u64,
                _ => lanes(raw, 8)
                    .into_iter()
                    .enumerate()
                    .fold(0, |mask, (i, v)| mask | ((v >> 7) << i)),
            } | (scalar & 0xffffffff00000000);
            let mut u = unit(vec![Instruction {
                pc: 0x1000,
                next_pc: 0x1004,
                operation: Operation::Vector(operation),
            }]);
            u.context = context.clone();
            cases.push(with_xmm(
                execution_case(
                    &emit(&u),
                    &[0x1000],
                    &[(0, scalar)],
                    0xcd7,
                    0x1000,
                    1,
                    (&[(0, result)], 0xcd7, 0x1004, BUDGET as u32, 0),
                ),
                &[(7, raw)],
                &[],
            ));
        }
    }
    run_cases(cases);
}

#[test]
fn vector_memory_forms_stage_before_mutation_and_request_exact_accesses() {
    let address = Address {
        base: AddressBase::Register(0),
        segment: Segment::Ss,
        ..Address::default()
    };
    let a = 0x800000007fffffff8000ffff12345678u128;
    let b = 0x00112233445566778899aabbccddeeffu128;
    let forms = [
        (
            VectorInstruction::Binary {
                kind: VectorBinary::AndNot,
                dst: 15,
                src: VectorOperand::Memory(address),
            },
            16,
            16,
            !a & b,
        ),
        (
            VectorInstruction::Shuffle {
                kind: VectorShuffle::RawSingles,
                dst: 15,
                src: VectorOperand::Memory(address),
                immediate: 0x1b,
            },
            16,
            16,
            shuffle_oracle(VectorShuffle::RawSingles, a, b, 0x1b),
        ),
        (
            VectorInstruction::Shift {
                kind: VectorShift::Right(Width::W64),
                dst: 15,
                count: VectorCount::Vector(VectorOperand::Memory(address)),
            },
            16,
            16,
            0,
        ),
        (
            VectorInstruction::InsertWord {
                dst: 15,
                src: Location::Memory(address),
                immediate: 7,
            },
            2,
            1,
            (a & !(0xffffu128 << 112)) | ((b & 0xffff) << 112),
        ),
        (
            VectorInstruction::ToXmm {
                dst: 15,
                src: Location::Memory(address),
                width: Width::W32,
            },
            4,
            1,
            b & 0xffffffff,
        ),
        (
            VectorInstruction::ToXmm {
                dst: 15,
                src: Location::Memory(address),
                width: Width::W64,
            },
            8,
            1,
            b & 0xffffffffffffffff,
        ),
    ];
    let mut cases = vec![];
    for (operation, bytes, alignment, result) in forms {
        for failed in [false, true] {
            let expected = [(15, result)];
            let mut p = packet(
                operation,
                &[(15, a)],
                if failed { &[] } else { &expected },
                if failed { DATA } else { BUDGET },
            );
            // The Core helper zeros the unused scratch portion after narrow reads.
            let loaded = if bytes == 16 {
                b
            } else {
                b & ((1u128 << (bytes * 8)) - 1)
            };
            let mut calls = vec![
                json!({"kind":"vector_load","args":["6001",bytes,Segment::Ss as u32,alignment],"result":if failed { Value::Null } else { json!(format!("{loaded:x}")) }}),
            ];
            if failed {
                calls.push(json!({"kind":"access_reason","args":[],"result":DATA}));
            }
            p["accesses"] = json!(calls);
            cases.push(p);
        }
    }
    for width in [Width::W32, Width::W64] {
        let mut p = packet(
            VectorInstruction::FromXmm {
                dst: Location::Memory(address),
                src: 15,
                width,
            },
            &[(15, a)],
            &[],
            BUDGET,
        );
        p["accesses"] = json!([{"kind":"vector_store","args":["6001",width.bytes(),Segment::Ss as u32,1,format!("{a:x}")],"result":1}]);
        cases.push(p);
    }
    run_cases(cases);
}

fn lanes(value: u128, bits: u32) -> Vec<u64> {
    let mask = (1u128 << bits) - 1;
    (0..128 / bits)
        .map(|i| ((value >> (i * bits)) & mask) as u64)
        .collect()
}

fn packed(values: impl IntoIterator<Item = u64>, bits: u32) -> u128 {
    let mask = (1u128 << bits) - 1;
    values.into_iter().enumerate().fold(0, |out, (i, value)| {
        out | ((u128::from(value) & mask) << (i as u32 * bits))
    })
}

fn signed(value: u64, bits: u32) -> i128 {
    (i128::from(value) << (128 - bits)) >> (128 - bits)
}

fn binary_oracle(kind: VectorBinary, a: u128, b: u128) -> u128 {
    use VectorBinary::*;
    match kind {
        And => a & b,
        AndNot => !a & b,
        Or => a | b,
        Xor => a ^ b,
        PackSigned(_) | PackUnsignedWord => {
            let bits = if let PackSigned(width) = kind {
                width.bits()
            } else {
                16
            };
            let out = bits / 2;
            let (min, max) = if kind == PackUnsignedWord {
                (0, (1i128 << out) - 1)
            } else {
                (-(1i128 << (out - 1)), (1i128 << (out - 1)) - 1)
            };
            packed(
                lanes(a, bits)
                    .into_iter()
                    .chain(lanes(b, bits))
                    .map(|v| signed(v, bits).clamp(min, max) as u64),
                out,
            )
        }
        UnpackLow(width) | UnpackHigh(width) => {
            let bits = width.bits();
            let a = lanes(a, bits);
            let b = lanes(b, bits);
            let start = if matches!(kind, UnpackHigh(_)) {
                a.len() / 2
            } else {
                0
            };
            packed(
                (start..start + a.len() / 2).flat_map(|i| [a[i], b[i]]),
                bits,
            )
        }
        MulUnsignedDword => {
            let a = lanes(a, 32);
            let b = lanes(b, 32);
            packed([a[0] * b[0], a[2] * b[2]], 64)
        }
        MaddSignedWord => {
            let a = lanes(a, 16);
            let b = lanes(b, 16);
            packed(
                (0..4).map(|i| {
                    (signed(a[2 * i], 16) * signed(b[2 * i], 16)
                        + signed(a[2 * i + 1], 16) * signed(b[2 * i + 1], 16))
                        as u64
                }),
                32,
            )
        }
        SumAbsoluteByteDifferences => {
            let a = a.to_le_bytes();
            let b = b.to_le_bytes();
            packed(
                (0..2).map(|half| {
                    (0..8)
                        .map(|i| u64::from(a[half * 8 + i].abs_diff(b[half * 8 + i])))
                        .sum()
                }),
                64,
            )
        }
        _ => {
            let bits = match kind {
                Add(w)
                | Sub(w)
                | SignedSaturatingAdd(w)
                | UnsignedSaturatingAdd(w)
                | SignedSaturatingSub(w)
                | UnsignedSaturatingSub(w)
                | CompareEqual(w)
                | CompareGreater(w)
                | Average(w) => w.bits(),
                MinUnsignedByte | MaxUnsignedByte => 8,
                MinSignedWord | MaxSignedWord | MulLowWord | MulHighWord { .. } => 16,
                _ => unreachable!(),
            };
            let min = -(1i128 << (bits - 1));
            let max = (1i128 << (bits - 1)) - 1;
            let mask = (1u128 << bits) - 1;
            packed(
                lanes(a, bits)
                    .into_iter()
                    .zip(lanes(b, bits))
                    .map(|(a, b)| match kind {
                        Add(_) => a.wrapping_add(b),
                        Sub(_) => a.wrapping_sub(b),
                        SignedSaturatingAdd(_) => {
                            (signed(a, bits) + signed(b, bits)).clamp(min, max) as u64
                        }
                        SignedSaturatingSub(_) => {
                            (signed(a, bits) - signed(b, bits)).clamp(min, max) as u64
                        }
                        UnsignedSaturatingAdd(_) => {
                            (u128::from(a) + u128::from(b)).min(mask) as u64
                        }
                        UnsignedSaturatingSub(_) => a.saturating_sub(b),
                        CompareEqual(_) => {
                            if a == b {
                                mask as u64
                            } else {
                                0
                            }
                        }
                        CompareGreater(_) => {
                            if signed(a, bits) > signed(b, bits) {
                                mask as u64
                            } else {
                                0
                            }
                        }
                        MinUnsignedByte => a.min(b),
                        MaxUnsignedByte => a.max(b),
                        MinSignedWord => signed(a, bits).min(signed(b, bits)) as u64,
                        MaxSignedWord => signed(a, bits).max(signed(b, bits)) as u64,
                        Average(_) => (a + b).div_ceil(2),
                        MulLowWord => a * b,
                        MulHighWord { signed: true } => {
                            ((signed(a, bits) * signed(b, bits)) >> 16) as u64
                        }
                        MulHighWord { signed: false } => (a * b) >> 16,
                        _ => unreachable!(),
                    }),
                bits,
            )
        }
    }
}

#[test]
fn all_packed_integer_operations_match_independent_scalar_lane_oracles() {
    use VectorBinary::*;
    let mut kinds = vec![
        And,
        AndNot,
        Or,
        Xor,
        MinUnsignedByte,
        MaxUnsignedByte,
        MinSignedWord,
        MaxSignedWord,
        MulLowWord,
        MulHighWord { signed: false },
        MulHighWord { signed: true },
        MulUnsignedDword,
        MaddSignedWord,
        SumAbsoluteByteDifferences,
        PackSigned(Width::W16),
        PackSigned(Width::W32),
        PackUnsignedWord,
    ];
    for width in [Width::W8, Width::W16, Width::W32, Width::W64] {
        kinds.extend([Add(width), Sub(width), UnpackLow(width), UnpackHigh(width)]);
        if width != Width::W64 {
            kinds.extend([CompareEqual(width), CompareGreater(width)]);
        }
        if width.bits() <= 16 {
            kinds.extend([
                SignedSaturatingAdd(width),
                UnsignedSaturatingAdd(width),
                SignedSaturatingSub(width),
                UnsignedSaturatingSub(width),
                Average(width),
            ]);
        }
    }
    let mut inputs = vec![
        (0, u128::MAX),
        (u128::MAX, 1),
        (
            0x80008000800080008000800080008000,
            0x80008000800080008000800080008000,
        ),
        (
            0x7fff8000ffff0000007f0080ff0100ff,
            0x0100ffff0001ffff00ff008100800001,
        ),
    ];
    let mut seed = 0x123456789abcdef0u64;
    let mut random = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    for _ in 0..12 {
        inputs.push((
            (u128::from(random()) << 64) | u128::from(random()),
            (u128::from(random()) << 64) | u128::from(random()),
        ));
    }
    let mut cases = vec![];
    for kind in kinds {
        for &(a, b) in &inputs {
            cases.push(packet(
                VectorInstruction::Binary {
                    kind,
                    dst: 15,
                    src: VectorOperand::Register(8),
                },
                &[(15, a), (8, b)],
                &[(15, binary_oracle(kind, a, b))],
                BUDGET,
            ));
        }
        let a = inputs[3].0;
        cases.push(packet(
            VectorInstruction::Binary {
                kind,
                dst: 7,
                src: VectorOperand::Register(7),
            },
            &[(7, a)],
            &[(7, binary_oracle(kind, a, a))],
            BUDGET,
        ));
    }
    run_cases(cases);
}

fn shuffle_oracle(kind: VectorShuffle, a: u128, b: u128, control: u8) -> u128 {
    let a = a.to_le_bytes();
    let b = b.to_le_bytes();
    let mut out = b;
    match kind {
        VectorShuffle::Dwords => {
            for i in 0..4 {
                let lane = usize::from((control >> (2 * i)) & 3);
                out[4 * i..4 * i + 4].copy_from_slice(&b[4 * lane..4 * lane + 4]);
            }
        }
        VectorShuffle::LowWords | VectorShuffle::HighWords => {
            let base = if kind == VectorShuffle::HighWords {
                8
            } else {
                0
            };
            for i in 0..4 {
                let lane = usize::from((control >> (2 * i)) & 3);
                out[base + 2 * i..base + 2 * i + 2]
                    .copy_from_slice(&b[base + 2 * lane..base + 2 * lane + 2]);
            }
        }
        VectorShuffle::RawSingles => {
            for i in 0..4 {
                let lane = usize::from((control >> (2 * i)) & 3);
                let source = if i < 2 { a } else { b };
                out[4 * i..4 * i + 4].copy_from_slice(&source[4 * lane..4 * lane + 4]);
            }
        }
        VectorShuffle::RawDoubles => {
            let lo = usize::from(control & 1) * 8;
            let hi = usize::from((control >> 1) & 1) * 8;
            out[..8].copy_from_slice(&a[lo..lo + 8]);
            out[8..].copy_from_slice(&b[hi..hi + 8]);
        }
    }
    u128::from_le_bytes(out)
}

#[test]
fn every_shuffle_control_preserves_raw_bits_and_source_lane_order() {
    let a = 0x0f0e0d0c0b0a09080706050403020100;
    let b = 0x8f8e8d8c8b8a89888786858483828180;
    let mut cases = vec![];
    for kind in [
        VectorShuffle::Dwords,
        VectorShuffle::LowWords,
        VectorShuffle::HighWords,
        VectorShuffle::RawSingles,
        VectorShuffle::RawDoubles,
    ] {
        for immediate in 0..=255 {
            cases.push(packet(
                VectorInstruction::Shuffle {
                    kind,
                    dst: 15,
                    src: VectorOperand::Register(8),
                    immediate,
                },
                &[(15, a), (8, b)],
                &[(15, shuffle_oracle(kind, a, b, immediate))],
                BUDGET,
            ));
        }
    }
    run_cases(cases);
}

fn shift_oracle(kind: VectorShift, a: u128, count: u64) -> u128 {
    match kind {
        VectorShift::ByteLeft => {
            if count >= 16 {
                0
            } else {
                a << (count * 8)
            }
        }
        VectorShift::ByteRight => {
            if count >= 16 {
                0
            } else {
                a >> (count * 8)
            }
        }
        VectorShift::Left(width)
        | VectorShift::Right(width)
        | VectorShift::ArithmeticRight(width) => {
            let bits = width.bits();
            packed(
                lanes(a, bits).into_iter().map(|a| match kind {
                    VectorShift::Left(_) => {
                        if count >= u64::from(bits) {
                            0
                        } else {
                            a << count
                        }
                    }
                    VectorShift::Right(_) => {
                        if count >= u64::from(bits) {
                            0
                        } else {
                            a >> count
                        }
                    }
                    VectorShift::ArithmeticRight(_) => {
                        (signed(a, bits) >> count.min(u64::from(bits - 1))) as u64
                    }
                    _ => unreachable!(),
                }),
                bits,
            )
        }
    }
}

#[test]
fn packed_shifts_guard_full_unsigned_low_qword_counts_and_all_immediates() {
    let value = 0x8001ffff7fff000180000001ffffffff;
    let mut cases = vec![];
    for kind in [
        VectorShift::Left(Width::W16),
        VectorShift::Left(Width::W32),
        VectorShift::Left(Width::W64),
        VectorShift::Right(Width::W16),
        VectorShift::Right(Width::W32),
        VectorShift::Right(Width::W64),
        VectorShift::ArithmeticRight(Width::W16),
        VectorShift::ArithmeticRight(Width::W32),
        VectorShift::ByteLeft,
        VectorShift::ByteRight,
    ] {
        for immediate in 0..=255 {
            cases.push(packet(
                VectorInstruction::Shift {
                    kind,
                    dst: 15,
                    count: VectorCount::Immediate(immediate),
                },
                &[(15, value)],
                &[(15, shift_oracle(kind, value, u64::from(immediate)))],
                BUDGET,
            ));
        }
        if !matches!(kind, VectorShift::ByteLeft | VectorShift::ByteRight) {
            for count in [
                0,
                1,
                15,
                16,
                17,
                31,
                32,
                33,
                63,
                64,
                65,
                255,
                256,
                1 << 32,
                1 << 63,
                u64::MAX,
            ] {
                let source = (0xfedcba9876543210u128 << 64) | u128::from(count);
                cases.push(packet(
                    VectorInstruction::Shift {
                        kind,
                        dst: 15,
                        count: VectorCount::Vector(VectorOperand::Register(8)),
                    },
                    &[(15, value), (8, source)],
                    &[(15, shift_oracle(kind, value, count))],
                    BUDGET,
                ));
            }
            cases.push(packet(
                VectorInstruction::Shift {
                    kind,
                    dst: 15,
                    count: VectorCount::Vector(VectorOperand::Register(15)),
                },
                &[(15, value)],
                &[(15, shift_oracle(kind, value, value as u64))],
                BUDGET,
            ));
        }
    }
    run_cases(cases);
}

#[test]
fn raw_moves_preserve_partial_register_bits_and_zero_narrow_load_upper_bits() {
    let old = 0x112233445566778899aabbccddeeff00u128;
    let source = 0xffeeddccbbaa99887766554433221100u128;
    let mut cases = vec![];
    for (bytes, preserve, result) in [
        (16, false, source),
        (8, false, source & u64::MAX as u128),
        (4, false, source & u32::MAX as u128),
        (
            8,
            true,
            (old & !(u64::MAX as u128)) | (source & u64::MAX as u128),
        ),
        (
            4,
            true,
            (old & !(u32::MAX as u128)) | (source & u32::MAX as u128),
        ),
    ] {
        cases.push(packet(
            VectorInstruction::Move {
                register: 0,
                operand: VectorOperand::Register(1),
                bytes,
                preserve_upper: preserve,
                aligned: false,
                store: false,
            },
            &[(0, old), (1, source)],
            &[(0, result)],
            BUDGET,
        ));
    }
    run_cases(cases);
}

#[test]
fn vector_memory_faults_suppress_complete_destinations_and_stores_use_captured_source() {
    let address = Address {
        base: AddressBase::Register(0),
        ..Address::default()
    };
    let source = 0xffeeddccbbaa99887766554433221100u128;
    let mut cases = vec![];
    for failed in [false, true] {
        let mut p = packet(
            VectorInstruction::Move {
                register: 2,
                operand: VectorOperand::Memory(address),
                bytes: 4,
                preserve_upper: false,
                aligned: false,
                store: false,
            },
            &[],
            if failed { &[] } else { &[(2, 0x33221100)] },
            if failed { DATA } else { BUDGET },
        );
        p["accesses"] = if failed {
            json!([{"kind":"vector_load","args":["6001",4,Segment::Ds as u32,1],"result":null},{"kind":"access_reason","args":[],"result":DATA}])
        } else {
            json!([{"kind":"vector_load","args":["6001",4,Segment::Ds as u32,1],"result":"33221100"}])
        };
        cases.push(p);
        for status in [0, 1, 2] {
            let mut p = packet(
                VectorInstruction::Move {
                    register: 3,
                    operand: VectorOperand::Memory(address),
                    bytes: 16,
                    preserve_upper: false,
                    aligned: false,
                    store: true,
                },
                &[(3, source)],
                &[],
                if status == 0 { DATA } else { BUDGET },
            );
            let mut calls = vec![
                json!({"kind":"vector_store","args":["6001",16,Segment::Ds as u32,1,format!("{source:x}")],"result":status}),
            ];
            if status == 0 {
                calls.push(json!({"kind":"access_reason","args":[],"result":DATA}));
            }
            p["accesses"] = json!(calls);
            cases.push(p);
        }
    }
    run_cases(cases);
}
