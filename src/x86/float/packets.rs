use super::*;

fn op(kind: Kind, format: Format, scalar: bool) -> Op {
    Op {
        kind,
        format,
        scalar,
        integer64: false,
        predicate: 0,
    }
}
fn words(values: [u32; 4]) -> u128 {
    values
        .into_iter()
        .enumerate()
        .fold(0, |v, (i, x)| v | ((x as u128) << (32 * i)))
}

#[test]
fn packed_pre_abort_suppresses_post_conditions_and_retains_all_source_bits() {
    let left = words([0, 0x3f800000, 0x7f7fffff, 0x3f800000]);
    let right = words([0, 0, 0x3f000000, 0x40400000]);
    let first = eval(op(Kind::Div, Format::F32, false), left, right, 0x1f00);
    assert_eq!(
        first,
        Outcome {
            value: left,
            mxcsr: 0x1f05,
            raised: 5,
            stage: Some(Stage::PreComputation)
        }
    );
    let retry = eval(op(Kind::Div, Format::F32, false), left, right, 0x1f85);
    assert_eq!(
        retry.value,
        words([0xffc00000, 0x7f800000, 0x7f800000, 0x3eaaaaab])
    );
    assert_eq!(retry.mxcsr, 0x1fad);
    assert_eq!(retry.raised, 0x2d);
    assert_eq!(retry.stage, None);
    let exact_overflow = eval(
        op(Kind::Mul, Format::F32, true),
        0x7f7fffff,
        0x40000000,
        0x1b80,
    );
    assert_eq!(
        exact_overflow,
        Outcome {
            value: 0x7f7fffff,
            mxcsr: 0x1b88,
            raised: 8,
            stage: Some(Stage::PostComputation)
        }
    );
}

#[test]
fn nan_payloads_masks_and_daz_adjusted_minimum_are_raw_architectural_values() {
    for format in [Format::F32, Format::F64] {
        let (a, b, one): (u64, u64, u64) = if format == Format::F32 {
            (0x7fc00011, 0xff800022, 0x3f800000)
        } else {
            (0x7ff8000000000011, 0xfff0000000000022, 0x3ff0000000000000)
        };
        let inherited = 0x11223344556677880000000000000000u128;
        for kind in [Kind::Add, Kind::Sub, Kind::Mul, Kind::Div] {
            let output = eval(
                op(kind, format, true),
                inherited | a as u128,
                b as u128,
                0x1f80,
            );
            assert_eq!(output.value, inherited | a as u128);
            assert_eq!(output.mxcsr, 0x1f81);
            let output = eval(
                op(kind, format, true),
                inherited | a as u128,
                b as u128,
                0x1f00,
            );
            assert_eq!(output.stage, Some(Stage::PreComputation));
            assert_eq!(output.value, inherited | a as u128);
        }
        for kind in [Kind::Min, Kind::Max] {
            let result = eval(op(kind, format, true), one as u128, b as u128, 0x1f80);
            assert_eq!(result.value, b as u128);
            assert_eq!(result.mxcsr, 0x1f81);
        }
        let min = op(Kind::Min, format, true);
        assert_eq!(eval(min, one as u128, 1, 0x1f80).mxcsr, 0x1f82);
        assert_eq!(eval(min, one as u128, 1, 0x1fc0).value, 0);
        assert_eq!(eval(min, one as u128, 1, 0x1fc0).mxcsr, 0x1fc0);
    }
    let wide = eval(
        op(Kind::FloatConvert, Format::F32, true),
        0,
        0x7f800001,
        0x1f80,
    );
    assert_eq!((wide.value, wide.mxcsr), (0x7ff8000020000000, 0x1f81));
    let narrow = eval(
        op(Kind::FloatConvert, Format::F64, true),
        0,
        0x7ff0000000000001,
        0x1f80,
    );
    assert_eq!((narrow.value, narrow.mxcsr), (0x7fc00000, 0x1f81));
}

#[test]
fn all_legacy_predicate_controls_and_comi_quietness_have_exact_flags() {
    for format in [Format::F32, Format::F64] {
        let (qnan, snan, one): (u64, u64, u64) = if format == Format::F32 {
            (0x7fc00011, 0x7f800022, 0x3f800000)
        } else {
            (0x7ff8000000000011, 0x7ff0000000000022, 0x3ff0000000000000)
        };
        for predicate in 0..=255 {
            for a in [qnan, snan] {
                let output = eval(
                    Op {
                        predicate,
                        ..op(Kind::Cmp, format, true)
                    },
                    a as u128,
                    one as u128,
                    0x1f80,
                );
                let yes = matches!(predicate & 7, 3..=6);
                assert_eq!(output.value, if yes { format.mask() as u128 } else { 0 });
                assert_eq!(
                    output.mxcsr,
                    0x1f80 | u32::from(a == snan || matches!(predicate & 7, 1 | 2 | 5 | 6))
                );
            }
        }
        for (kind, a, raises) in [
            (Kind::Comi, qnan, true),
            (Kind::Ucomi, qnan, false),
            (Kind::Ucomi, snan, true),
        ] {
            let output = eval(op(kind, format, true), a as u128, one as u128, 0x1f80);
            assert_eq!(output.value, 0x45);
            assert_eq!(output.mxcsr, 0x1f80 | u32::from(raises));
            assert_eq!(
                eval(op(kind, format, true), a as u128, one as u128, 0x1f00).stage,
                if raises {
                    Some(Stage::PreComputation)
                } else {
                    None
                }
            );
        }
    }
}

#[test]
fn integer_and_precision_conversions_keep_round_before_range_and_narrow_views() {
    for (input, value, flags) in [
        (0xcf000000, 0x80000000, 0),
        (0x4f000000, 0x80000000, 1),
        (0x3fc00000, 1, 32),
        (1, 0, 32),
    ] {
        let r = eval(op(Kind::TruncToInt, Format::F32, true), 0, input, 0x1f80);
        assert_eq!((r.value, r.mxcsr), (value, 0x1f80 | flags));
    }
    let boundary = 0x41dfffffffe00000;
    let r = eval(op(Kind::FloatToInt, Format::F64, true), 0, boundary, 0x1f80);
    assert_eq!((r.value, r.mxcsr), (0x80000000, 0x1f81));
    let r = eval(op(Kind::FloatToInt, Format::F64, true), 0, boundary, 0x7f80);
    assert_eq!((r.value, r.mxcsr), (0x7fffffff, 0x7fa0));
    let r = eval(
        Op {
            integer64: true,
            ..op(Kind::IntToFloat, Format::F64, true)
        },
        0,
        0x7fffffffffffffff,
        0x1f80,
    );
    assert_eq!((r.value, r.mxcsr), (0x43e0000000000000, 0x1fa0));
    let r = eval(
        op(Kind::FloatConvert, Format::F64, false),
        u128::MAX,
        0x3ff0000000000000u128 | (0x4000000000000000u128 << 64),
        0x1f80,
    );
    assert_eq!(r.value, 0x400000003f800000);
    let r = eval(
        op(Kind::IntToFloat, Format::F64, false),
        0,
        words([0xffffffff, 0x7fffffff, 0xaaaaaaaa, 0xbbbbbbbb]),
        0x1f80,
    );
    assert_eq!(
        r.value,
        0xbff0000000000000u128 | (0x41dfffffffc00000u128 << 64)
    );
}

#[test]
fn square_roots_all_rounds_and_approximate_specials_do_not_leak_status() {
    for (format, input, results) in [
        (
            Format::F32,
            0x40000000,
            [0x3fb504f3, 0x3fb504f3, 0x3fb504f4, 0x3fb504f3],
        ),
        (
            Format::F64,
            0x4000000000000000,
            [
                0x3ff6a09e667f3bcd,
                0x3ff6a09e667f3bcc,
                0x3ff6a09e667f3bcd,
                0x3ff6a09e667f3bcc,
            ],
        ),
    ] {
        for rc in 0..4 {
            let mxcsr = 0x1f80 | (rc << 13);
            let r = eval(op(Kind::Sqrt, format, true), 0, input, mxcsr);
            assert_eq!((r.value, r.mxcsr), (results[rc as usize], mxcsr | 32));
        }
    }
    for kind in [Kind::Rcp, Kind::Rsqrt] {
        for mxcsr in [0, 0x1f80, 0xffff] {
            for (input, expected) in [
                (0, 0x7f800000),
                (0x80000000, 0xff800000),
                (1, 0x7f800000),
                (0x80000001, 0xff800000),
                (0x7f800000, 0),
                (0x7f800001, 0x7fc00001),
            ] {
                let r = eval(op(kind, Format::F32, true), 0, input, mxcsr);
                assert_eq!(
                    (r.value, r.mxcsr, r.raised, r.stage),
                    (expected, mxcsr, 0, None)
                );
            }
        }
    }
}

#[test]
fn directed_overflow_to_maximum_finite_still_reports_overflow() {
    let r = eval(op(Kind::Div, Format::F32, true), 0x40000000, 1, 0x3f80);
    assert_eq!(r.value, 0x7f7fffff);
    assert_eq!(r.mxcsr, 0x3faa);
}

#[test]
fn narrowing_uses_unbounded_precision_for_tininess_even_when_result_is_normal() {
    // Intel vol. 1 §11.5.2.5: tininess follows rounding to 24 significant bits
    // with an unbounded exponent, before rounding to the bounded binary32 format.
    // The first input is exactly 2^-126 - 2^-150: tiny at 24-bit precision,
    // although bounded nearest-even rounding returns the minimum normal value.
    // The second is 2^-126 - 2^-151: its unbounded nearest-even result is normal.
    let results = [0x00800000, 0x007fffff, 0x00800000, 0x007fffff];
    for (input, masked, unmasked, flushed) in [
        (
            0x380fffffe0000000u64,
            [48, 48, 48, 48],
            [16, 16, 16, 16],
            [0, 0, 0, 0],
        ),
        (
            0x380ffffff0000000,
            [32, 48, 32, 48],
            [32, 48, 32, 48],
            [0x00800000, 0, 0x00800000, 0],
        ),
    ] {
        for negative in [false, true] {
            for rc in 0..4 {
                // Negation exchanges downward and upward rounding.
                let index = if negative { [0, 2, 1, 3][rc] } else { rc };
                for control in [0x1f80, 0x1780, 0x9f80, 0x9780, 0x0f80, 0x0780] {
                    for sticky in [0, 0x3f] {
                        let mxcsr = control | ((rc as u32) << 13) | sticky;
                        let raised = if control & 0x800 != 0 {
                            masked[index]
                        } else {
                            unmasked[index]
                        };
                        let trapped = raised & !(mxcsr >> 7) & 0x3f != 0;
                        let sign = if negative { 0x80000000 } else { 0 };
                        let bits = if control & 0x8800 == 0x8800 {
                            flushed[index]
                        } else {
                            results[index]
                        } | sign;
                        let left = 0x112233445566778899aabbccdeadbeefu128;
                        assert_eq!(
                            eval(
                                op(Kind::FloatConvert, Format::F64, true),
                                left,
                                (input | if negative { 1 << 63 } else { 0 }) as u128,
                                mxcsr,
                            ),
                            Outcome {
                                value: if trapped {
                                    left
                                } else {
                                    (left & !0xffffffff) | bits
                                },
                                mxcsr: mxcsr | raised,
                                raised,
                                stage: trapped.then_some(Stage::PostComputation),
                            },
                            "input={input:x} negative={negative} mxcsr={mxcsr:x}"
                        );
                    }
                }
            }
        }
    }
}
