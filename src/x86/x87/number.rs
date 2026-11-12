mod special;
use super::{Format, Kind};
pub(super) use special::{extract, remainder, scale};
use std::cmp::Ordering;
pub(super) const SIGN: u128 = 1 << 79;
pub(super) const QUIET: u128 = 1 << 62;
pub(super) const INDEFINITE: u128 = 0xffffc000000000000000;
pub(super) const INFINITY: u128 = 0x7fff8000000000000000;
#[derive(Clone, Copy, Debug)]
pub(super) struct Num {
    pub negative: bool,
    pub sig: u128,
    pub scale: i32,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Class {
    Zero,
    Finite,
    Infinity,
    QuietNan,
    SignalingNan,
    Unsupported,
}
pub(super) fn class(raw: u128) -> Class {
    let e = (raw >> 64) & 0x7fff;
    let s = raw as u64;
    if e == 0 {
        if s == 0 { Class::Zero } else { Class::Finite }
    } else if s >> 63 == 0 {
        Class::Unsupported
    } else if e != 0x7fff {
        Class::Finite
    } else if s == 1 << 63 {
        Class::Infinity
    } else if s & (1 << 62) != 0 {
        Class::QuietNan
    } else {
        Class::SignalingNan
    }
}
pub(super) fn denormal(raw: u128) -> bool {
    raw & 0x7fff0000000000000000 == 0 && raw as u64 != 0
}
pub(super) fn tag(raw: u128) -> u16 {
    let e = (raw >> 64) & 0x7fff;
    let s = raw as u64;
    if e == 0 && s == 0 {
        1
    } else if e == 0 || e == 0x7fff || s >> 63 == 0 {
        2
    } else {
        0
    }
}
pub(super) fn num(raw: u128) -> Num {
    let e = ((raw >> 64) & 0x7fff) as i32;
    Num {
        negative: raw & SIGN != 0,
        sig: (raw as u64) as u128,
        scale: if e == 0 { -16382 - 63 } else { e - 16383 - 63 },
    }
}
fn normalized(n: Num) -> (u128, i32) {
    if n.sig == 0 {
        return (0, 0);
    }
    let b = 127 - n.sig.leading_zeros() as i32;
    (n.sig << (63 - b), n.scale + b)
}
#[derive(Clone, Copy, Debug)]
pub(super) struct Result {
    pub value: u128,
    pub pre: u16,
    pub post: u16,
    pub up: bool,
    pub suppress: bool,
}
impl Result {
    pub fn raw(value: u128) -> Self {
        Self {
            value,
            pre: 0,
            post: 0,
            up: false,
            suppress: false,
        }
    }
    pub fn invalid(value: u128) -> Self {
        Self {
            value,
            pre: 1,
            ..Self::raw(value)
        }
    }
}
fn rc(cw: u16) -> u16 {
    (cw >> 10) & 3
}
pub(super) fn precision(cw: u16) -> u32 {
    match (cw >> 8) & 3 {
        0 => 24,
        2 => 53,
        _ => 64,
    }
}
fn quantize(sig: u128, shift: i32, negative: bool, round: u16) -> (u128, bool, bool) {
    if shift <= 0 {
        return (sig << (-shift), false, false);
    }
    let (q, r, half) = if shift < 128 {
        let q = sig >> shift;
        let r = sig & ((1u128 << shift) - 1);
        (q, r, Some(1u128 << (shift - 1)))
    } else {
        (
            0,
            sig,
            if shift == 128 {
                Some(1u128 << 127)
            } else {
                None
            },
        )
    };
    let inexact = r != 0;
    let up = inexact
        && match round {
            0 => half.is_some_and(|h| r > h || r == h && q & 1 != 0),
            1 => negative,
            2 => !negative,
            _ => false,
        };
    (q + u128::from(up), inexact, up)
}
fn pack(negative: bool, q: u128, e: i32, p: u32, target: Format, normal: bool) -> u128 {
    let sign = if negative {
        if target == Format::F32 {
            1 << 31
        } else if target == Format::F64 {
            1 << 63
        } else {
            SIGN
        }
    } else {
        0
    };
    if target == Format::F32 || target == Format::F64 {
        let bias = if target == Format::F32 { 127 } else { 1023 };
        sign | if normal {
            (((e + bias) as u128) << (p - 1)) | (q - (1u128 << (p - 1)))
        } else {
            q
        }
    } else {
        sign | if normal {
            (((e + 16383) as u128) << 64) | (q << (64 - p))
        } else {
            q << (64 - p)
        }
    }
}
fn round_num(n: Num, p: u32, target: Format, cw: u16) -> Result {
    if n.sig == 0 {
        return Result::raw(pack(n.negative, 0, 0, p, target, false));
    }
    let emin = if target == Format::F32 {
        -126
    } else if target == Format::F64 {
        -1022
    } else {
        -16382
    };
    let emax = if target == Format::F32 {
        127
    } else if target == Format::F64 {
        1023
    } else {
        16383
    };
    let b = 127 - n.sig.leading_zeros() as i32;
    let mut e = n.scale + b;
    let (mut q, inexact, up) = quantize(n.sig, b + 1 - p as i32, n.negative, rc(cw));
    if q == 1u128 << p {
        q >>= 1;
        e += 1
    }
    if e > emax {
        let masked = cw & 8 != 0;
        let post = 8 | if masked || inexact { 32 } else { 0 };
        if !masked {
            return Result {
                value: if target == Format::F80 {
                    if e - 24576 > emax {
                        INFINITY | if n.negative { SIGN } else { 0 }
                    } else {
                        pack(n.negative, q, e - 24576, p, target, true)
                    }
                } else {
                    0
                },
                pre: 0,
                post,
                up,
                suppress: target != Format::F80,
            };
        }
        let infinity = rc(cw) == 0 || rc(cw) == 1 && n.negative || rc(cw) == 2 && !n.negative;
        let value = if infinity {
            if target == Format::F32 {
                0x7f800000 | if n.negative { 1 << 31 } else { 0 }
            } else if target == Format::F64 {
                0x7ff0000000000000 | if n.negative { 1 << 63 } else { 0 }
            } else {
                INFINITY | if n.negative { SIGN } else { 0 }
            }
        } else {
            pack(n.negative, (1u128 << p) - 1, emax, p, target, true)
        };
        return Result {
            value,
            pre: 0,
            post,
            up: infinity,
            suppress: false,
        };
    }
    if e < emin {
        if cw & 16 == 0 {
            return Result {
                value: if target == Format::F80 {
                    if e + 24576 < emin {
                        if n.negative { SIGN } else { 0 }
                    } else {
                        pack(n.negative, q, e + 24576, p, target, true)
                    }
                } else {
                    0
                },
                pre: 0,
                post: 16 | if inexact { 32 } else { 0 },
                up,
                suppress: target != Format::F80,
            };
        }
        let (q, inexact, up) = quantize(n.sig, emin - (p as i32 - 1) - n.scale, n.negative, rc(cw));
        return Result {
            value: pack(n.negative, q, emin, p, target, q >= 1u128 << (p - 1)),
            pre: 0,
            post: if inexact { 48 } else { 0 },
            up,
            suppress: false,
        };
    }
    Result {
        value: pack(n.negative, q, e, p, target, true),
        pre: 0,
        post: if inexact { 32 } else { 0 },
        up,
        suppress: false,
    }
}
fn jam(x: u128, n: u32) -> u128 {
    if n == 0 {
        x
    } else if n >= 128 {
        u128::from(x != 0)
    } else {
        (x >> n) | u128::from(x & ((1u128 << n) - 1) != 0)
    }
}
fn add(a: Num, b: Num, round: u16) -> Num {
    if a.sig == 0 && b.sig == 0 {
        return Num {
            negative: if a.negative == b.negative {
                a.negative
            } else {
                round == 1
            },
            sig: 0,
            scale: 0,
        };
    }
    if a.sig == 0 {
        return b;
    }
    if b.sig == 0 {
        return a;
    }
    let (sa, ea) = normalized(a);
    let (sb, eb) = normalized(b);
    let (a, b, sa, sb, ea, eb) = if ea < eb || ea == eb && sa < sb {
        (b, a, sb, sa, eb, ea)
    } else {
        (a, b, sa, sb, ea, eb)
    };
    let left = sa << 3;
    let right = jam(sb << 3, (ea - eb) as u32);
    let sig = if a.negative == b.negative {
        left + right
    } else {
        left - right
    };
    Num {
        negative: if sig == 0 { round == 1 } else { a.negative },
        sig,
        scale: ea - 66,
    }
}
fn divide(a: Num, b: Num) -> Num {
    let (mut sa, ea) = normalized(a);
    let (sb, eb) = normalized(b);
    let mut e = ea - eb;
    if sa < sb {
        sa <<= 1;
        e -= 1
    }
    let mut rem = sa - sb;
    let mut q = 1u128;
    for _ in 0..66 {
        rem <<= 1;
        q <<= 1;
        if rem >= sb {
            rem -= sb;
            q |= 1
        }
    }
    if rem != 0 {
        q |= 1
    }
    Num {
        negative: a.negative ^ b.negative,
        sig: q,
        scale: e - 66,
    }
}
fn root(n: Num) -> Num {
    let (s, e) = normalized(n);
    let radicand = if e & 1 == 0 { s << 63 } else { s << 64 };
    let mut rem = 0u128;
    let mut q = 0u128;
    for i in 0..67 {
        let pair = if i < 64 {
            (radicand >> (126 - 2 * i)) & 3
        } else {
            0
        };
        rem = (rem << 2) | pair;
        q <<= 1;
        let test = (q << 1) | 1;
        if rem >= test {
            rem -= test;
            q |= 1
        }
    }
    if rem != 0 {
        q |= 1
    }
    Num {
        negative: false,
        sig: q,
        scale: e.div_euclid(2) - 66,
    }
}
fn nan(a: u128, b: u128) -> Option<Result> {
    use Class::*;
    let ca = class(a);
    let cb = class(b);
    if ca == Unsupported || cb == Unsupported {
        return Some(Result::invalid(INDEFINITE));
    }
    let na = matches!(ca, QuietNan | SignalingNan);
    let nb = matches!(cb, QuietNan | SignalingNan);
    if !na && !nb {
        return None;
    }
    let raw = if ca == QuietNan && cb == SignalingNan {
        a
    } else if ca == SignalingNan && cb == QuietNan || !na {
        b
    } else if !nb || a as u64 > b as u64 {
        a
    } else if (a as u64) < b as u64 {
        b
    } else {
        a.min(b)
    };
    Some(Result {
        value: raw | QUIET,
        pre: if ca == SignalingNan || cb == SignalingNan {
            1
        } else {
            0
        },
        ..Result::raw(raw)
    })
}
pub(super) fn binary(kind: Kind, mut a: u128, mut b: u128, cw: u16, extra: u16) -> Result {
    use Class::*;
    if let Some(mut r) = nan(a, b) {
        r.pre |= extra & 1;
        return r;
    }
    if kind == Kind::Sub {
        b ^= SIGN
    } else if kind == Kind::SubReverse {
        a ^= SIGN
    } else if kind == Kind::DivReverse {
        std::mem::swap(&mut a, &mut b)
    }
    let ca = class(a);
    let cb = class(b);
    let add_kind = matches!(kind, Kind::Add | Kind::Sub | Kind::SubReverse);
    let mul_kind = kind == Kind::Mul;
    let invalid = if add_kind {
        ca == Infinity && cb == Infinity && (a ^ b) & SIGN != 0
    } else if mul_kind {
        ca == Infinity && cb == Zero || ca == Zero && cb == Infinity
    } else {
        ca == Infinity && cb == Infinity || ca == Zero && cb == Zero
    };
    if invalid {
        return Result::invalid(INDEFINITE);
    }
    let negative = (a ^ b) & SIGN;
    if !add_kind && !mul_kind && cb == Zero && ca != Infinity {
        return Result {
            value: INFINITY | negative,
            pre: 4,
            ..Result::raw(0)
        };
    }
    let pre = extra | if denormal(a) || denormal(b) { 2 } else { 0 };
    if pre & !cw & 63 != 0 {
        return Result {
            pre,
            suppress: true,
            ..Result::raw(a)
        };
    }
    if ca == Infinity || cb == Infinity {
        let value = if add_kind {
            if ca == Infinity { a } else { b }
        } else if mul_kind || ca == Infinity {
            INFINITY | negative
        } else {
            negative
        };
        return Result {
            pre,
            ..Result::raw(value)
        };
    }
    let na = num(a);
    let nb = num(b);
    let n = if add_kind {
        add(na, nb, rc(cw))
    } else if mul_kind {
        Num {
            negative: na.negative ^ nb.negative,
            sig: na.sig * nb.sig,
            scale: na.scale + nb.scale,
        }
    } else if na.sig == 0 {
        Num {
            negative: na.negative ^ nb.negative,
            sig: 0,
            scale: 0,
        }
    } else {
        divide(na, nb)
    };
    let mut r = round_num(n, precision(cw), Format::F80, cw);
    r.pre = pre;
    r
}
pub(super) fn unary(kind: Kind, raw: u128, cw: u16) -> Result {
    if let Some(r) = nan(raw, raw) {
        return r;
    }
    let c = class(raw);
    if kind == Kind::Sqrt && raw & SIGN != 0 && c != Class::Zero {
        return Result::invalid(INDEFINITE);
    }
    let pre = if denormal(raw) { 2 } else { 0 };
    if pre & !cw != 0 {
        return Result {
            pre,
            suppress: true,
            ..Result::raw(raw)
        };
    }
    if matches!(c, Class::Zero | Class::Infinity) {
        return Result {
            pre,
            ..Result::raw(raw)
        };
    }
    let n = num(raw);
    let mut r = if kind == Kind::Sqrt {
        round_num(root(n), precision(cw), Format::F80, cw)
    } else {
        let (q, inexact, up) = if n.scale >= 0 {
            return Result {
                pre,
                ..Result::raw(raw)
            };
        } else {
            quantize(n.sig, -n.scale, n.negative, rc(cw))
        };
        let mut r = round_num(
            Num {
                negative: n.negative,
                sig: q,
                scale: 0,
            },
            64,
            Format::F80,
            cw,
        );
        r.post = if inexact { 32 } else { 0 };
        r.up = up;
        r
    };
    r.pre = pre;
    r
}
pub(super) fn widen(value: u128, format: Format) -> u128 {
    match format {
        Format::F80 => value,
        Format::F32 | Format::F64 => {
            let (p, bias, bits) = if format == Format::F32 {
                (23, 127, 32)
            } else {
                (52, 1023, 64)
            };
            let negative = value & (1u128 << (bits - 1)) != 0;
            let fraction = value & ((1u128 << p) - 1);
            let e = ((value >> p) & ((1u128 << (bits - p - 1)) - 1)) as i32;
            let sign = if negative { SIGN } else { 0 };
            if e == 2 * bias + 1 {
                return sign | INFINITY | (fraction << (63 - p));
            }
            if e == 0 && fraction == 0 {
                return sign;
            }
            let sig = if e == 0 {
                fraction
            } else {
                fraction | (1u128 << p)
            };
            round_num(
                Num {
                    negative,
                    sig,
                    scale: (if e == 0 { 1 - bias } else { e - bias }) - p,
                },
                64,
                Format::F80,
                0x37f,
            )
            .value
        }
        Format::I16 | Format::I32 | Format::I64 => {
            let width = if format == Format::I16 {
                16
            } else if format == Format::I32 {
                32
            } else {
                64
            };
            let v = ((value as i128) << (128 - width)) >> (128 - width);
            round_num(
                Num {
                    negative: v < 0,
                    sig: v.unsigned_abs(),
                    scale: 0,
                },
                64,
                Format::F80,
                0x37f,
            )
            .value
        }
        _ => value,
    }
}
pub(super) fn memory_denormal(value: u128, format: Format) -> bool {
    match format {
        Format::F32 => value & 0x7f800000 == 0 && value & 0x7fffff != 0,
        Format::F64 => value & 0x7ff0000000000000 == 0 && value & 0xfffffffffffff != 0,
        _ => false,
    }
}
pub(super) fn load(value: u128, format: Format) -> Result {
    if format == Format::Bcd {
        return special::load_bcd(value);
    }
    let raw = widen(value, format);
    if matches!(format, Format::F32 | Format::F64) {
        let mut r = Result::raw(raw);
        if class(raw) == Class::SignalingNan {
            r.value |= QUIET;
            r.pre |= 1
        }
        if memory_denormal(value, format) {
            r.pre |= 2
        }
        r
    } else {
        Result::raw(raw)
    }
}
pub(super) fn store(raw: u128, format: Format, cw: u16) -> Result {
    if format == Format::Bcd {
        return special::store_bcd(raw, cw);
    }
    if format == Format::F80 || format == Format::Register {
        return Result::raw(raw);
    }
    if matches!(format, Format::I16 | Format::I32 | Format::I64) {
        let width = if format == Format::I16 {
            16
        } else if format == Format::I32 {
            32
        } else {
            64
        };
        let indefinite = 1u128 << (width - 1);
        if !matches!(class(raw), Class::Zero | Class::Finite) {
            return Result::invalid(indefinite);
        }
        let n = num(raw);
        let (q, inexact, up) = if n.scale >= 0 {
            if n.scale >= 128 || 128 - n.sig.leading_zeros() + n.scale as u32 > 127 {
                return Result::invalid(indefinite);
            }
            (n.sig << n.scale, false, false)
        } else {
            quantize(n.sig, -n.scale, n.negative, rc(cw))
        };
        if q > indefinite || q == indefinite && !n.negative {
            return Result::invalid(indefinite);
        }
        return Result {
            value: if n.negative {
                0u128.wrapping_sub(q) & ((1u128 << width) - 1)
            } else {
                q
            },
            pre: 0,
            post: if inexact { 32 } else { 0 },
            up,
            suppress: false,
        };
    }
    let c = class(raw);
    let (bits, p) = if format == Format::F32 {
        (32, 23)
    } else {
        (64, 52)
    };
    let sign = if raw & SIGN != 0 {
        1u128 << (bits - 1)
    } else {
        0
    };
    let inf = if bits == 32 {
        0x7f800000
    } else {
        0x7ff0000000000000
    };
    match c {
        Class::Unsupported => Result::invalid((1u128 << (bits - 1)) | inf | (1u128 << (p - 1))),
        Class::QuietNan | Class::SignalingNan => Result {
            value: sign
                | inf
                | (((raw as u64) as u128 & !(1 << 63)) >> (63 - p))
                | (1u128 << (p - 1)),
            pre: if c == Class::SignalingNan { 1 } else { 0 },
            ..Result::raw(0)
        },
        Class::Infinity => Result::raw(sign | inf),
        _ => {
            let mut r = round_num(num(raw), p + 1, format, cw);
            if r.suppress {
                r.post &= !32;
                r.up = false
            }
            r
        }
    }
}
pub(super) fn compare(a: u128, b: u128) -> Option<Ordering> {
    use Class::*;
    if matches!(class(a), QuietNan | SignalingNan | Unsupported)
        || matches!(class(b), QuietNan | SignalingNan | Unsupported)
    {
        return None;
    }
    if class(a) == Zero && class(b) == Zero {
        return Some(Ordering::Equal);
    }
    let neg_a = a & SIGN != 0;
    let neg_b = b & SIGN != 0;
    if neg_a != neg_b {
        return Some(if neg_a {
            Ordering::Less
        } else {
            Ordering::Greater
        });
    }
    let abs = if class(a) == Infinity {
        if class(b) == Infinity {
            Ordering::Equal
        } else {
            Ordering::Greater
        }
    } else if class(b) == Infinity {
        Ordering::Less
    } else {
        let (sa, ea) = normalized(num(a));
        let (sb, eb) = normalized(num(b));
        if sa == 0 {
            if sb == 0 {
                Ordering::Equal
            } else {
                Ordering::Less
            }
        } else if sb == 0 {
            Ordering::Greater
        } else {
            ea.cmp(&eb).then(sa.cmp(&sb))
        }
    };
    Some(if neg_a { abs.reverse() } else { abs })
}
#[inline(always)]
pub(super) fn constant(index: u8, cw: u16) -> u128 {
    // The low two bits are the extra bits of the Intel 66-significant-bit ROM.
    const ROM: [(u16, u64, u8); 7] = [
        (0x3fff, 0x8000000000000000, 0),
        (0x4000, 0xd49a784bcd1b8afe, 1),
        (0x3fff, 0xb8aa3b295c17f0bb, 3),
        (0x4000, 0xc90fdaa22168c234, 3),
        (0x3ffd, 0x9a209a84fbcff798, 3),
        (0x3ffe, 0xb17217f7d1cf79ab, 3),
        (0, 0, 0),
    ];
    let (e, s, tail) = ROM[usize::from(index)];
    let up = match rc(cw) {
        0 => tail > 2 || tail == 2 && s & 1 != 0,
        2 => tail != 0,
        _ => false,
    };
    ((e as u128) << 64) | u128::from(s + u64::from(up))
}
