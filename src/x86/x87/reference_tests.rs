use super::*;
use rustc_apfloat::ieee::X87DoubleExtended;
use rustc_apfloat::{Float, Round, Status};

const SIGN: u128 = 1 << 79;

fn rounding(rc: u16) -> Round {
    match rc {
        0 => Round::NearestTiesToEven,
        1 => Round::TowardNegative,
        2 => Round::TowardPositive,
        _ => Round::TowardZero,
    }
}
fn random(seed: &mut u64) -> u64 {
    *seed ^= *seed << 13;
    *seed ^= *seed >> 7;
    *seed ^= *seed << 17;
    *seed
}
fn raw(negative: bool, exponent: i32, significand: u64) -> u128 {
    (if negative { SIGN } else { 0 })
        | (((exponent + 16383) as u128) << 64)
        | u128::from(significand)
}
fn execute(kind: Kind, left: u128, right: u128, precision: u32, rc: u16) -> State {
    let pc = match precision {
        24 => 0,
        53 => 2,
        _ => 3,
    };
    let mut state = State {
        control_word: 0x7f | (pc << 8) | (rc << 10),
        status_word: 0x4700,
        tag_word: 0xfff0,
        ..State::default()
    };
    for bank in 0..8 {
        state.set_raw(bank, 0x7fff8000000000000011u128 + bank as u128);
    }
    state.set_raw(0, left);
    state.set_raw(1, right);
    let untouched = state.registers;
    let result = eval(
        &mut state,
        Op {
            kind,
            format: Format::Register,
            index: 1,
            ..Op::default()
        },
        0,
        0xcd7,
    );
    assert_eq!(result.flags, 0xcd7);
    assert!(!result.store && !result.ax);
    assert_eq!(&state.registers[1..], &untouched[1..]);
    assert_eq!(state.tag_word & !3, 0xfff0);
    assert_eq!(
        state.status_word & 0xb8c0,
        0,
        "no pending, stack effects or SF"
    );
    state
}

#[test]
fn pc64_seeded_finite_arithmetic_matches_independent_apfloat_extended_results() {
    let mut seed = 0x8f27e146e2149b63u64;
    let exponents = [
        -16382, -16381, -12000, -2000, -64, -1, 0, 1, 63, 2000, 12000, 16382, 16383,
    ];
    let significands = [
        0x8000000000000000,
        0x8000000000000001,
        0x8000000000000400,
        0xbfffffffffffffff,
        0xfffffffffffffffe,
        0xffffffffffffffff,
    ];
    for sample in 0..4096 {
        let a_exp = exponents[(random(&mut seed) as usize) % exponents.len()];
        let b_exp = if sample % 3 == 0 {
            a_exp
        } else {
            exponents[(random(&mut seed) as usize) % exponents.len()]
        };
        let a_sig = if sample % 2 == 0 {
            significands[(random(&mut seed) as usize) % significands.len()]
        } else {
            random(&mut seed) | (1 << 63)
        };
        let b_sig = if sample % 5 == 0 {
            a_sig
        } else {
            random(&mut seed) | (1 << 63)
        };
        let left = raw(random(&mut seed) & 1 != 0, a_exp, a_sig);
        let right = raw(random(&mut seed) & 1 != 0, b_exp, b_sig);
        let a = X87DoubleExtended::from_bits(left);
        let b = X87DoubleExtended::from_bits(right);
        for kind in [
            Kind::Add,
            Kind::Sub,
            Kind::SubReverse,
            Kind::Mul,
            Kind::Div,
            Kind::DivReverse,
        ] {
            for rc in 0..4 {
                let expected = match kind {
                    Kind::Add => a.add_r(b, rounding(rc)),
                    Kind::Sub => a.sub_r(b, rounding(rc)),
                    Kind::SubReverse => b.sub_r(a, rounding(rc)),
                    Kind::Mul => a.mul_r(b, rounding(rc)),
                    Kind::Div => a.div_r(b, rounding(rc)),
                    Kind::DivReverse => b.div_r(a, rounding(rc)),
                    _ => unreachable!(),
                };
                let state = execute(kind, left, right, 64, rc);
                assert_eq!(
                    state.raw(0),
                    expected.value.to_bits(),
                    "finite sample={sample} {kind:?} rc={rc} left={left:020x} right={right:020x} status={:x}",
                    state.status_word
                );
                // IEEE flags alone are not an oracle for x87 DE or wrapped
                // exponents. Compare PE only away from format boundaries.
                let e = (expected.value.to_bits() >> 64) & 0x7fff;
                if (2..0x7ffe).contains(&e) {
                    assert_eq!(
                        state.status_word & 0x3f,
                        if expected.status.contains(Status::INEXACT) {
                            0x20
                        } else {
                            0
                        },
                        "precision sample={sample} {kind:?} rc={rc} left={left:020x} right={right:020x}"
                    );
                }
            }
        }
    }
}

// This independent reference aligns complete integer significands, while the
// implementation uses bounded guard/sticky work. Division here forms the final
// precision quotient directly, without f32/f64 or intermediary rounding.
fn unpack(value: u128) -> (bool, u128, i32) {
    (
        value & SIGN != 0,
        value & u64::MAX as u128,
        ((value >> 64) & 0x7fff) as i32 - 16383,
    )
}
fn increment(negative: bool, quotient: u128, remainder: u128, denominator: u128, rc: u16) -> bool {
    remainder != 0
        && match rc {
            0 => remainder * 2 > denominator || remainder * 2 == denominator && quotient & 1 != 0,
            1 => negative,
            2 => !negative,
            _ => false,
        }
}
fn finish(
    negative: bool,
    mut q: u128,
    mut exponent: i32,
    p: u32,
    inexact: bool,
    up: bool,
) -> (u128, u16) {
    if up {
        q += 1;
    }
    if q == 1u128 << p {
        q >>= 1;
        exponent += 1;
    }
    let value =
        (if negative { SIGN } else { 0 }) | (((exponent + 16383) as u128) << 64) | (q << (64 - p));
    (
        value,
        (if inexact { 0x20 } else { 0 }) | (if up { 0x200 } else { 0 }),
    )
}
fn exact(kind: Kind, left: u128, right: u128, p: u32, rc: u16) -> (u128, u16) {
    let (mut an, mut a, mut ae) = unpack(left);
    let (mut bn, mut b, mut be) = unpack(right);
    if kind == Kind::Sub {
        bn = !bn;
    }
    if kind == Kind::SubReverse {
        an = !an;
    }
    if kind == Kind::DivReverse {
        std::mem::swap(&mut an, &mut bn);
        std::mem::swap(&mut a, &mut b);
        std::mem::swap(&mut ae, &mut be);
    }
    if matches!(kind, Kind::Div | Kind::DivReverse) {
        let adjust = u32::from(a < b);
        let numerator = a << (p - 1 + adjust);
        let q = numerator / b;
        let remainder = numerator % b;
        let negative = an ^ bn;
        return finish(
            negative,
            q,
            ae - be - adjust as i32,
            p,
            remainder != 0,
            increment(negative, q, remainder, b, rc),
        );
    }
    let (negative, n, scale) = if kind == Kind::Mul {
        (an ^ bn, a * b, ae + be - 126)
    } else {
        let common = ae.min(be);
        a <<= ae - common;
        b <<= be - common;
        let (negative, magnitude) = if an == bn {
            (an, a + b)
        } else if a > b {
            (an, a - b)
        } else if b > a {
            (bn, b - a)
        } else {
            (rc == 1, 0)
        };
        (negative, magnitude, common - 63)
    };
    if n == 0 {
        return (if negative { SIGN } else { 0 }, 0);
    }
    let length = 128 - n.leading_zeros();
    let exponent = scale + length as i32 - 1;
    if length <= p {
        return finish(negative, n << (p - length), exponent, p, false, false);
    }
    let denominator = 1u128 << (length - p);
    let q = n / denominator;
    let remainder = n % denominator;
    finish(
        negative,
        q,
        exponent,
        p,
        remainder != 0,
        increment(negative, q, remainder, denominator, rc),
    )
}

#[test]
fn reduced_precision_seeded_arithmetic_matches_exact_integer_rationals() {
    let mut seed = 0xc93eaa5263bfcaa7u64;
    for sample in 0..4096 {
        let exponent = (random(&mut seed) % 4001) as i32 - 2000;
        let delta = (random(&mut seed) % 121) as i32 - 60;
        let significand = random(&mut seed) | (1 << 63);
        let other = if sample % 5 == 0 {
            significand
        } else {
            random(&mut seed) | (1 << 63)
        };
        let left = raw(random(&mut seed) & 1 != 0, exponent, significand);
        let right = raw(random(&mut seed) & 1 != 0, exponent + delta, other);
        for p in [24, 53, 64] {
            for kind in [
                Kind::Add,
                Kind::Sub,
                Kind::SubReverse,
                Kind::Mul,
                Kind::Div,
                Kind::DivReverse,
            ] {
                for rc in 0..4 {
                    let expected = exact(kind, left, right, p, rc);
                    let state = execute(kind, left, right, p, rc);
                    assert_eq!(
                        (state.raw(0), state.status_word & 0x23f),
                        expected,
                        "direct precision sample={sample} p={p} {kind:?} rc={rc} left={left:020x} right={right:020x}"
                    );
                }
            }
        }
    }
}

#[test]
fn all_constants_match_independent_high_precision_values_at_every_rc_and_pc() {
    // Independently computed with Python Decimal at 180 decimal digits: ln(2),
    // ln(10), their quotients, and pi from 16*atan(1/5)-4*atan(1/239), summing
    // each alternating series below 1e-170. These are mathematical values, not
    // copies of the implementation's 66-bit ROM or a hardware capture.
    const VALUES: [&str; 7] = [
        "1",
        "3.32192809488736234787031942948939017586483139302458061205475639581593477660862521585013974335937015509965737171025025182682409698426352688828",
        "1.44269504088896340735992468100189213742664595415298593413544940693110921918118507988552662289350634449699751830965254425559310168716835964272",
        "3.14159265358979323846264338327950288419716939937510582097494459230781640628620899862803482534211706798214808651328230664709384460955058223173",
        "0.30102999566398119521373889472449302676818988146210854131042746112710818927442450948692725211818617204068447719143099537909476788113352350600",
        "0.69314718055994530941723212145817656807550013436025525412068000949339362196969471560586332699641868754200148102057068573368552023575813055703",
        "0",
    ];
    for (index, value) in VALUES.iter().enumerate() {
        for pc in [0, 2, 3] {
            for rc in 0..4 {
                let expected = X87DoubleExtended::from_str_r(value, rounding(rc))
                    .unwrap()
                    .value
                    .to_bits();
                let mut state = State {
                    control_word: 0x7f | (pc << 8) | (rc << 10),
                    status_word: 0x4700,
                    ..State::default()
                };
                for bank in 0..8 {
                    state.set_raw(bank, 0xffff8000000000000011 + bank as u128);
                }
                let before = state.registers;
                let result = eval(
                    &mut state,
                    Op {
                        kind: Kind::Constant,
                        index: index as u8,
                        ..Op::default()
                    },
                    0,
                    0xcd7,
                );
                assert_eq!(state.raw(7), expected, "constant {index}, pc={pc} rc={rc}");
                assert_eq!(state.status_word & 0xbaff, 0x3800);
                assert_eq!(state.tag_word, if index == 6 { 0x7fff } else { 0x3fff });
                assert_eq!(&state.registers[..7], &before[..7]);
                assert_eq!(result.flags, 0xcd7);
            }
        }
    }
}

#[test]
fn integer_store_boundaries_match_independent_conversions_with_masked_and_unmasked_publication() {
    let exponents = [
        -2000, -65, -64, -2, -1, 0, 14, 15, 16, 30, 31, 32, 62, 63, 64, 65, 127, 2000,
    ];
    let mut seed = 0x5f41c8ad237ecaa1;
    for sample in 0..4096 {
        let e = exponents[(random(&mut seed) as usize) % exponents.len()];
        let sig = match sample % 4 {
            0 => 1 << 63,
            1 => u64::MAX,
            2 => (1 << 63) | 1,
            _ => random(&mut seed) | (1 << 63),
        };
        let mut value = raw(random(&mut seed) & 1 != 0, e, sig);
        if sample % 29 == 0 {
            value &= SIGN;
        }
        let source = X87DoubleExtended::from_bits(value);
        for (format, width) in [(Format::I16, 16), (Format::I32, 32), (Format::I64, 64)] {
            for rc in 0..4 {
                let expected = source.to_i128_r(width, rounding(rc), &mut false);
                let invalid = expected.status.contains(Status::INVALID_OP);
                let raised = if invalid {
                    1
                } else if expected.status.contains(Status::INEXACT) {
                    0x20
                } else {
                    0
                };
                let integer = if invalid {
                    1u128 << (width - 1)
                } else {
                    expected.value as u128 & ((1u128 << width) - 1)
                };
                let up = !invalid
                    && X87DoubleExtended::from_u128(expected.value.unsigned_abs()).value
                        > X87DoubleExtended::from_bits(value & !SIGN);
                for masks in [0x37f, 0x37e, 0x35f] {
                    let pop = if width == 64 { 1 } else { (sample & 1) as u8 };
                    let mut state = State {
                        control_word: masks | (rc << 10),
                        status_word: 0x4700,
                        tag_word: 0xfffc | u16::from(value & !SIGN == 0),
                        ..State::default()
                    };
                    for bank in 0..8 {
                        state.set_raw(bank, 0xffff8000000000000011 + bank as u128);
                    }
                    state.set_raw(0, value);
                    let before = state.registers;
                    let effect = eval(
                        &mut state,
                        Op {
                            kind: Kind::Store,
                            format,
                            pop,
                            ..Op::default()
                        },
                        0,
                        0xcd7,
                    );
                    let suppressed = invalid && masks & 1 == 0;
                    assert_eq!(
                        effect.store, !suppressed,
                        "store publication sample={sample} width={width} rc={rc} cw={masks:x} value={value:020x}"
                    );
                    if !suppressed {
                        assert_eq!(
                            effect.value, integer,
                            "integer sample={sample} width={width} rc={rc} cw={masks:x} value={value:020x}"
                        );
                    }
                    let status = raised
                        | if up { 0x200 } else { 0 }
                        | if raised & !masks != 0 { 0x8080 } else { 0 }
                        | if !suppressed { u16::from(pop) << 11 } else { 0 };
                    assert_eq!(
                        state.status_word & 0xbaff,
                        status,
                        "status sample={sample} width={width} rc={rc} cw={masks:x} value={value:020x}"
                    );
                    assert_eq!(state.registers, before);
                    assert_eq!(effect.flags, 0xcd7);
                    assert_eq!(
                        state.tag(0),
                        if !suppressed && pop != 0 {
                            3
                        } else {
                            u16::from(value & !SIGN == 0)
                        }
                    );
                }
            }
        }
    }
}
