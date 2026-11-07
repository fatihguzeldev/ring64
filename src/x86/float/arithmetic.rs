use super::{Format, Kind};
use rustc_apfloat::ieee::{Double, IeeeFloat, Semantics, Single};
use rustc_apfloat::{Float, FloatConvert, Round, Status, StatusAnd};

struct Wide32;
impl Semantics for Wide32 {
    const BITS: usize = 39;
    const EXP_BITS: usize = 15;
}
struct Wide64;
impl Semantics for Wide64 {
    const BITS: usize = 68;
    const EXP_BITS: usize = 15;
}

pub(super) fn round(mxcsr: u32) -> Round {
    match (mxcsr >> 13) & 3 {
        0 => Round::NearestTiesToEven,
        1 => Round::TowardNegative,
        2 => Round::TowardPositive,
        _ => Round::TowardZero,
    }
}

fn calculate<F: Float>(kind: Kind, a: F, b: F, rc: Round) -> StatusAnd<F> {
    match kind {
        Kind::Add => a.add_r(b, rc),
        Kind::Sub => a.sub_r(b, rc),
        Kind::Mul => a.mul_r(b, rc),
        Kind::Div => a.div_r(b, rc),
        _ => unreachable!(),
    }
}

fn flags<S: Semantics, W: Semantics>(
    bounded: StatusAnd<IeeeFloat<S>>,
    wide: StatusAnd<IeeeFloat<W>>,
    mxcsr: u32,
) -> (u64, u32) {
    let mut value = bounded.value.to_bits() as u64;
    let overflow = bounded.status.contains(Status::OVERFLOW);
    let tiny = !wide.value.is_zero()
        && wide.value.is_finite()
        && wide.value.ilogb() < IeeeFloat::<S>::MIN_EXP;
    let unbounded_inexact = wide.status.contains(Status::INEXACT);
    let mut raised = 0;
    if overflow {
        raised |= 8;
        if mxcsr & (1 << 10) != 0 || unbounded_inexact {
            raised |= 32;
        }
    } else if tiny {
        if mxcsr & (1 << 11) == 0 {
            raised |= 16;
            if unbounded_inexact {
                raised |= 32;
            }
        } else if mxcsr & (1 << 15) != 0 {
            value &= 1 << (IeeeFloat::<S>::BITS - 1);
            raised |= 48;
        } else if bounded.status.contains(Status::INEXACT) {
            raised |= 48;
        }
    } else if bounded.status.contains(Status::INEXACT) {
        raised |= 32;
    }
    (value, raised)
}

fn arithmetic<S: Semantics, W: Semantics>(
    kind: Kind,
    left: u64,
    right: u64,
    mxcsr: u32,
) -> (u64, u32) {
    let rc = round(mxcsr);
    let a = IeeeFloat::<S>::from_bits(left as u128);
    let b = IeeeFloat::<S>::from_bits(right as u128);
    let wa: StatusAnd<IeeeFloat<W>> = a.convert_r(rc, &mut false);
    let wb: StatusAnd<IeeeFloat<W>> = b.convert_r(rc, &mut false);
    flags(
        calculate(kind, a, b, rc),
        calculate(kind, wa.value, wb.value, rc),
        mxcsr,
    )
}

pub(super) fn binary(kind: Kind, format: Format, left: u64, right: u64, mxcsr: u32) -> (u64, u32) {
    match format {
        Format::F32 => arithmetic::<rustc_apfloat::ieee::SingleS, Wide32>(kind, left, right, mxcsr),
        Format::F64 => arithmetic::<rustc_apfloat::ieee::DoubleS, Wide64>(kind, left, right, mxcsr),
    }
}

pub(super) fn convert(format: Format, value: u64, mxcsr: u32) -> (u64, u32) {
    let rc = round(mxcsr);
    match format {
        Format::F32 => {
            let a = Single::from_bits(value as u128);
            let result: StatusAnd<Double> = a.convert_r(rc, &mut false);
            (result.value.to_bits() as u64, 0)
        }
        Format::F64 => {
            let a = Double::from_bits(value as u128);
            let bounded: StatusAnd<Single> = a.convert_r(rc, &mut false);
            let wide: StatusAnd<IeeeFloat<Wide32>> = a.convert_r(rc, &mut false);
            flags(bounded, wide, mxcsr)
        }
    }
}

pub(super) fn from_integer(format: Format, value: i128, mxcsr: u32) -> (u64, u32) {
    let rc = round(mxcsr);
    match format {
        Format::F32 => {
            let r = Single::from_i128_r(value, rc);
            (
                r.value.to_bits() as u64,
                if r.status.contains(Status::INEXACT) {
                    32
                } else {
                    0
                },
            )
        }
        Format::F64 => {
            let r = Double::from_i128_r(value, rc);
            (
                r.value.to_bits() as u64,
                if r.status.contains(Status::INEXACT) {
                    32
                } else {
                    0
                },
            )
        }
    }
}

pub(super) fn to_integer(
    format: Format,
    value: u64,
    width: usize,
    truncate: bool,
    mxcsr: u32,
) -> (u64, u32) {
    let rc = if truncate {
        Round::TowardZero
    } else {
        round(mxcsr)
    };
    let r = match format {
        Format::F32 => Single::from_bits(value as u128).to_i128_r(width, rc, &mut false),
        Format::F64 => Double::from_bits(value as u128).to_i128_r(width, rc, &mut false),
    };
    if r.status.contains(Status::INVALID_OP) {
        (1u64 << (width - 1), 1)
    } else {
        (
            r.value as u64
                & if width == 32 {
                    u32::MAX as u64
                } else {
                    u64::MAX
                },
            if r.status.contains(Status::INEXACT) {
                32
            } else {
                0
            },
        )
    }
}

pub(super) fn compare(format: Format, a: u64, b: u64) -> std::cmp::Ordering {
    match format {
        Format::F32 => Single::from_bits(a as u128).partial_cmp(&Single::from_bits(b as u128)),
        Format::F64 => Double::from_bits(a as u128).partial_cmp(&Double::from_bits(b as u128)),
    }
    .unwrap()
}

fn root(value: u128) -> (u128, u128) {
    let mut remainder = value;
    let mut result = 0u128;
    let mut bit = 1u128 << 126;
    while bit > remainder {
        bit >>= 2;
    }
    while bit != 0 {
        if remainder >= result + bit {
            remainder -= result + bit;
            result = (result >> 1) + bit;
        } else {
            result >>= 1;
        }
        bit >>= 2;
    }
    (result, remainder)
}

pub(super) fn sqrt(format: Format, value: u64, mxcsr: u32) -> (u64, u32) {
    if format.zero(value) || format.infinite(value) {
        return (value, 0);
    }
    let p = format.fraction();
    let bias = (1i32 << (format.exponent_bits() - 1)) - 1;
    let encoded_exp = ((value >> p) & ((1 << format.exponent_bits()) - 1)) as i32;
    let mut significand = value & format.fraction_mask();
    let mut exponent = if encoded_exp == 0 {
        1 - bias
    } else {
        significand |= 1 << p;
        encoded_exp - bias
    };
    while significand & (1 << p) == 0 {
        significand <<= 1;
        exponent -= 1;
    }
    if exponent & 1 != 0 {
        significand <<= 1;
        exponent -= 1;
    }
    let radicand = (significand as u128) << p;
    let (mut result, remainder) = root(radicand);
    let increment = match (mxcsr >> 13) & 3 {
        0 => remainder > result,
        2 => remainder != 0,
        _ => false,
    };
    if increment {
        result += 1;
    }
    let mut output_exponent = exponent / 2;
    if result == 1u128 << (p + 1) {
        result >>= 1;
        output_exponent += 1;
    }
    let bits = (((output_exponent + bias) as u64) << p) | (result as u64 & format.fraction_mask());
    (bits, if remainder != 0 { 32 } else { 0 })
}
