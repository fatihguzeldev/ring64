pub(super) fn multiply_high(left: u64, right: u64, signed: bool) -> u64 {
    let product = if signed {
        ((left as i64 as i128) * (right as i64 as i128)) as u128
    } else {
        u128::from(left) * u128::from(right)
    };
    (product >> 64) as u64
}

pub(super) fn divide(high: u64, low: u64, divisor: u64, signed: bool) -> Option<u64> {
    let dividend = (u128::from(high) << 64) | u128::from(low);
    if signed {
        let quotient = (dividend as i128).checked_div(divisor as i64 as i128)?;
        i64::try_from(quotient).ok().map(|value| value as u64)
    } else {
        let quotient = dividend.checked_div(u128::from(divisor))?;
        u64::try_from(quotient).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_products_distinguish_signed_high_halves_and_long_carries() {
        for (left, right, signed, high) in [
            (0, u64::MAX, false, 0),
            (u64::MAX, u64::MAX, false, u64::MAX - 1),
            (u64::MAX, u64::MAX, true, 0),
            (u64::MAX, 2, false, 1),
            (u64::MAX, 2, true, u64::MAX),
            (1 << 63, 1 << 63, false, 1 << 62),
            (1 << 63, 1 << 63, true, 1 << 62),
            (1 << 63, u64::MAX, true, 0),
            (1 << 32, 1 << 32, false, 1),
            (0xffff_ffff, 0xffff_ffff, false, 0),
        ] {
            assert_eq!(multiply_high(left, right, signed), high);
        }
    }

    #[test]
    fn unsigned_division_uses_the_full_dividend_and_quotient_range() {
        for (high, low, divisor, expected) in [
            (0, 7, 3, Some(2)),
            (1, 0, 2, Some(1 << 63)),
            (1, u64::MAX, 2, Some(u64::MAX)),
            (u64::MAX - 1, u64::MAX, u64::MAX, Some(u64::MAX)),
            (2, 0, 2, None),
            (u64::MAX, u64::MAX, u64::MAX, None),
            (0, 0, 0, None),
            (1, 0, 0, None),
        ] {
            assert_eq!(divide(high, low, divisor, false), expected);
        }
    }

    #[test]
    fn signed_division_checks_full_width_sign_and_host_minimum_overflow() {
        for (high, low, divisor, expected) in [
            (1, 0, 3, Some(0x5555_5555_5555_5555)),
            (u64::MAX, 0, 3, Some(0xaaaa_aaaa_aaaa_aaab)),
            (0, 1 << 63, 1, None),
            (0, 1 << 63, u64::MAX, Some(1 << 63)),
            (u64::MAX, 1 << 63, 1, Some(1 << 63)),
            (u64::MAX, 1 << 63, u64::MAX, None),
            (u64::MAX, u64::MAX, 1 << 63, Some(0)),
            (1 << 63, 0, u64::MAX, None),
            (1 << 63, 0, 1 << 63, None),
            (0, 0, 0, None),
        ] {
            assert_eq!(divide(high, low, divisor, true), expected);
        }
    }
}
