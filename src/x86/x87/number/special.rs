use super::*;

fn finish(n: Num, cw: u16, pre: u16) -> Result {
    let mut result = round_num(n, 64, Format::F80, cw);
    result.pre = pre;
    result
}

pub(in crate::x86::x87) fn remainder(a: u128, b: u128, nearest: bool, cw: u16) -> (Result, u16) {
    if let Some(result) = nan(a, b) {
        return (result, 0);
    }
    let ca = class(a);
    let cb = class(b);
    if ca == Class::Infinity || cb == Class::Zero {
        return (Result::invalid(INDEFINITE), 0);
    }
    let pre = if denormal(a) || denormal(b) { 2 } else { 0 };
    if pre & !cw != 0 {
        return (
            Result {
                pre,
                suppress: true,
                ..Result::raw(a)
            },
            0,
        );
    }
    if ca == Class::Zero || cb == Class::Infinity {
        return (finish(num(a), cw, pre), 0);
    }
    let (sa, ea) = normalized(num(a));
    let (sb, eb) = normalized(num(b));
    let difference = ea - eb;
    let partial = difference >= 64;
    let shift = if partial {
        32 + difference % 32
    } else {
        difference.max(0)
    };
    let numerator = sa << shift;
    let (mut quotient, mut magnitude, scale) = if difference >= 0 {
        (
            numerator / sb,
            numerator % sb,
            if partial { ea - 63 - shift } else { eb - 63 },
        )
    } else if nearest && difference == -1 && sa > sb {
        (1, 2 * sb - sa, ea - 63)
    } else {
        return (finish(num(a), cw, pre), 0);
    };
    let mut negative = a & SIGN != 0;
    if difference < 0 {
        negative = !negative;
    } else if !partial
        && nearest
        && (2 * magnitude > sb || 2 * magnitude == sb && quotient & 1 != 0)
    {
        quotient += 1;
        magnitude = sb - magnitude;
        negative = !negative;
    }
    if magnitude == 0 {
        negative = a & SIGN != 0;
    }
    let mut result = finish(
        Num {
            negative,
            sig: magnitude,
            scale,
        },
        cw,
        pre,
    );
    result.post &= !32;
    result.up = false;
    let flags = if partial {
        0x400
    } else {
        ((quotient as u16 & 4) << 6) | ((quotient as u16 & 2) << 13) | ((quotient as u16 & 1) << 9)
    };
    (result, flags)
}

pub(in crate::x86::x87) fn scale(a: u128, b: u128, cw: u16) -> Result {
    if let Some(result) = nan(a, b) {
        return result;
    }
    let ca = class(a);
    let cb = class(b);
    if cb == Class::Infinity
        && ((ca == Class::Zero && b & SIGN == 0) || (ca == Class::Infinity && b & SIGN != 0))
    {
        return Result::invalid(INDEFINITE);
    }
    let pre = if denormal(a) || denormal(b) { 2 } else { 0 };
    if pre & !cw != 0 {
        return Result {
            pre,
            suppress: true,
            ..Result::raw(a)
        };
    }
    if cb == Class::Infinity {
        return Result {
            pre,
            ..Result::raw((a & SIGN) | if b & SIGN == 0 { INFINITY } else { 0 })
        };
    }
    if matches!(ca, Class::Zero | Class::Infinity) {
        return Result {
            pre,
            ..Result::raw(a)
        };
    }
    let operand = num(b);
    // Only the exponent's effect matters after it exceeds every raw80 boundary and wrap adjustment.
    let magnitude = if operand.scale >= 0 {
        if 128 - operand.sig.leading_zeros() + operand.scale as u32 > 17 {
            100_000
        } else {
            (operand.sig << operand.scale).min(100_000) as i32
        }
    } else if operand.scale <= -128 {
        0
    } else {
        (operand.sig >> -operand.scale).min(100_000) as i32
    };
    let mut value = num(a);
    value.scale += if operand.negative {
        -magnitude
    } else {
        magnitude
    };
    finish(value, cw, pre)
}

pub(in crate::x86::x87) fn extract(raw: u128) -> (Result, u128) {
    if let Some(result) = nan(raw, raw) {
        return (result, result.value);
    }
    match class(raw) {
        Class::Zero => (
            Result {
                pre: 4,
                ..Result::raw(raw)
            },
            SIGN | INFINITY,
        ),
        Class::Infinity => (Result::raw(raw), INFINITY),
        _ => {
            let (significand, exponent) = normalized(num(raw));
            (
                Result {
                    pre: if denormal(raw) { 2 } else { 0 },
                    ..Result::raw((raw & SIGN) | (0x3fffu128 << 64) | significand)
                },
                widen(exponent as u32 as u128, Format::I32),
            )
        }
    }
}

pub(super) fn load_bcd(value: u128) -> Result {
    let mut magnitude = 0;
    for digit in (0..18).rev() {
        magnitude = magnitude * 10 + ((value >> (digit * 4)) & 15);
    }
    finish(
        Num {
            negative: value & SIGN != 0,
            sig: magnitude,
            scale: 0,
        },
        0x37f,
        0,
    )
}

pub(super) fn store_bcd(raw: u128, cw: u16) -> Result {
    if !matches!(class(raw), Class::Zero | Class::Finite) {
        return Result::invalid(INDEFINITE);
    }
    let n = num(raw);
    let (mut integer, inexact, up) = if n.scale >= 0 {
        if 128 - n.sig.leading_zeros() + n.scale as u32 > 64 {
            return Result::invalid(INDEFINITE);
        }
        (n.sig << n.scale, false, false)
    } else {
        quantize(n.sig, -n.scale, n.negative, rc(cw))
    };
    if integer >= 1_000_000_000_000_000_000 {
        return Result::invalid(INDEFINITE);
    }
    let mut value = if n.negative { SIGN } else { 0 };
    for digit in 0..18 {
        value |= (integer % 10) << (digit * 4);
        integer /= 10;
    }
    Result {
        value,
        pre: 0,
        post: if inexact { 32 } else { 0 },
        up,
        suppress: false,
    }
}
