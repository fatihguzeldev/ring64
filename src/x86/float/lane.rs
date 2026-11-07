use super::{Kind, Op, arithmetic};
use std::cmp::Ordering;

#[derive(Clone, Copy, Default)]
pub(super) struct Lane {
    pub value: u64,
    pub pre: u32,
    pub post: u32,
    pub resolved: bool,
    pub left: u64,
    pub right: u64,
}

fn predicate(code: u8, order: Option<Ordering>) -> bool {
    match code & 7 {
        0 => order == Some(Ordering::Equal),
        1 => order == Some(Ordering::Less),
        2 => matches!(order, Some(Ordering::Less | Ordering::Equal)),
        3 => order.is_none(),
        4 => order != Some(Ordering::Equal),
        5 => order != Some(Ordering::Less),
        6 => !matches!(order, Some(Ordering::Less | Ordering::Equal)),
        _ => order.is_some(),
    }
}

pub(super) fn prepare(op: Op, left: u64, right: u64, mxcsr: u32) -> Lane {
    use Kind::*;
    let format = op.format;
    if op.kind == IntToFloat {
        return Lane {
            left,
            right,
            ..Lane::default()
        };
    }
    let a = format.daz(left, mxcsr & 64 != 0);
    let b = format.daz(right, mxcsr & 64 != 0);
    let binary = matches!(
        op.kind,
        Add | Sub | Mul | Div | Min | Max | Cmp | Comi | Ucomi
    );
    let nan = format.nan(b) || binary && format.nan(a);
    let snan = format.snan(b) || binary && format.snan(a);
    let mut lane = Lane {
        left: a,
        right: b,
        ..Lane::default()
    };
    if matches!(op.kind, Rcp | Rsqrt) {
        let b = format.daz(right, true);
        lane.resolved = true;
        lane.value = if format.nan(b) {
            b | format.quiet()
        } else if format.zero(b) {
            format.infinity() | (b & format.sign())
        } else if op.kind == Rsqrt && b & format.sign() != 0 {
            format.indefinite()
        } else if format.infinite(b) {
            b & format.sign()
        } else {
            lane.resolved = false;
            0
        };
        lane.right = b;
        return lane;
    }
    if matches!(op.kind, FloatToInt | TruncToInt) {
        let (value, flags) = arithmetic::to_integer(
            format,
            b,
            if op.scalar && op.integer64 { 64 } else { 32 },
            op.kind == TruncToInt,
            mxcsr,
        );
        lane.value = value;
        lane.pre = flags & 1;
        lane.post = flags & 32;
        lane.resolved = true;
        return lane;
    }
    if nan {
        lane.resolved = true;
        lane.pre = if snan
            || matches!(op.kind, Min | Max | Comi)
            || op.kind == Cmp && matches!(op.predicate & 7, 1 | 2 | 5 | 6)
        {
            1
        } else {
            0
        };
        lane.value = match op.kind {
            Min | Max => b,
            Cmp => {
                if predicate(op.predicate, None) {
                    format.mask()
                } else {
                    0
                }
            }
            Comi | Ucomi => 0x45,
            FloatConvert => format.convert_nan(b),
            Sqrt => b | format.quiet(),
            _ => {
                if format.nan(a) {
                    a | format.quiet()
                } else {
                    b | format.quiet()
                }
            }
        };
        return lane;
    }
    let invalid = match op.kind {
        Add => format.infinite(a) && format.infinite(b) && (a ^ b) & format.sign() != 0,
        Sub => format.infinite(a) && format.infinite(b) && (a ^ b) & format.sign() == 0,
        Mul => format.infinite(a) && format.zero(b) || format.zero(a) && format.infinite(b),
        Div => format.infinite(a) && format.infinite(b) || format.zero(a) && format.zero(b),
        Sqrt => b & format.sign() != 0 && !format.zero(b),
        _ => false,
    };
    if invalid {
        lane.value = format.indefinite();
        lane.pre = 1;
        lane.resolved = true;
        return lane;
    }
    if op.kind == Div && !format.zero(a) && !format.infinite(a) && format.zero(b) {
        lane.value = format.infinity() | ((a ^ b) & format.sign());
        lane.pre = 4;
        lane.resolved = true;
        return lane;
    }
    if format.denormal(b) || binary && format.denormal(a) {
        lane.pre = 2;
    }
    if matches!(op.kind, Min | Max | Cmp | Comi | Ucomi) {
        let order = arithmetic::compare(format, a, b);
        lane.value = match op.kind {
            Min => {
                if order == Ordering::Less {
                    a
                } else {
                    b
                }
            }
            Max => {
                if order == Ordering::Greater {
                    a
                } else {
                    b
                }
            }
            Cmp => {
                if predicate(op.predicate, Some(order)) {
                    format.mask()
                } else {
                    0
                }
            }
            _ => match order {
                Ordering::Equal => 0x40,
                Ordering::Less => 1,
                Ordering::Greater => 0,
            },
        };
        lane.resolved = true;
    }
    lane
}

pub(super) fn calculate(op: Op, mut lane: Lane, mxcsr: u32) -> Lane {
    use Kind::*;
    if lane.resolved {
        return lane;
    }
    let (value, flags) = match op.kind {
        Add | Sub | Mul | Div => {
            arithmetic::binary(op.kind, op.format, lane.left, lane.right, mxcsr)
        }
        Sqrt => arithmetic::sqrt(op.format, lane.right, mxcsr),
        FloatConvert => arithmetic::convert(op.format, lane.right, mxcsr),
        IntToFloat => arithmetic::from_integer(
            op.format,
            if op.scalar && op.integer64 {
                lane.right as i64 as i128
            } else {
                lane.right as i32 as i128
            },
            mxcsr,
        ),
        Rcp | Rsqrt => (arithmetic::approximate(op.kind, op.format, lane.right), 0),
        _ => unreachable!(),
    };
    lane.value = value;
    lane.post = flags;
    lane
}
