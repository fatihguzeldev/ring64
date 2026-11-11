const LOW_CANONICAL_END: u64 = 0x0000_7fff_ffff_ffff;
const HIGH_CANONICAL_START: u64 = 0xffff_8000_0000_0000;
pub(super) const ADDRESS_DOMAIN_END: u128 = 1u128 << 64;
pub const PHYSICAL_ADDRESS_END: u64 = 1 << 52;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cause {
    AddressRange,
    Noncanonical,
    Unmapped,
    Permission,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    Read,
    Write,
    Execute,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fault {
    pub address: u64,
    pub width: u32,
    pub access: Access,
    pub cause: Cause,
    pub failing: u128,
}

pub fn canonical48(address: u64) -> bool {
    address <= LOW_CANONICAL_END || address >= HIGH_CANONICAL_START
}

pub(crate) fn check_span(address: u64, width: u32, access: Access) -> Result<(), Fault> {
    match span_failure(address, u64::from(width)) {
        Some((cause, failing)) => Err(Fault {
            address,
            width,
            access,
            cause,
            failing,
        }),
        None => Ok(()),
    }
}

pub(super) fn physical_span_failure(address: u64, length: u64) -> Option<(Cause, u128)> {
    if length == 0 {
        return None;
    }
    let end = u128::from(address) + u128::from(length);
    (end > u128::from(PHYSICAL_ADDRESS_END)).then_some((
        Cause::AddressRange,
        u128::from(address.max(PHYSICAL_ADDRESS_END)),
    ))
}

pub(super) fn check_physical_span(address: u64, width: u32, access: Access) -> Result<(), Fault> {
    match physical_span_failure(address, u64::from(width)) {
        Some((cause, failing)) => Err(Fault {
            address,
            width,
            access,
            cause,
            failing,
        }),
        None => Ok(()),
    }
}

pub(super) fn span_failure(address: u64, length: u64) -> Option<(Cause, u128)> {
    if length == 0 {
        return None;
    }
    let Some(last) = address.checked_add(length - 1) else {
        return Some((Cause::AddressRange, ADDRESS_DOMAIN_END));
    };
    if !canonical48(address) {
        Some((Cause::Noncanonical, u128::from(address)))
    } else if address <= LOW_CANONICAL_END && last > LOW_CANONICAL_END {
        Some((Cause::Noncanonical, u128::from(LOW_CANONICAL_END) + 1))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn widened_interval_oracle(address: u64, length: u64) -> Option<(Cause, u128)> {
        if length == 0 {
            return None;
        }
        let start = u128::from(address);
        let end = start + u128::from(length);
        let domain_end = 1u128 << 64;
        if end > domain_end {
            return Some((Cause::AddressRange, domain_end));
        }
        let overlap_start = start.max(0x0000_8000_0000_0000u128);
        let overlap_end = end.min(0xffff_8000_0000_0000u128);
        (overlap_start < overlap_end).then_some((Cause::Noncanonical, overlap_start))
    }

    fn boundary_addresses() -> Vec<u64> {
        let mut addresses = Vec::new();
        for anchor in [0, 0x0000_7fff_ffff_ffff, 0xffff_8000_0000_0000, u64::MAX] {
            for distance in [0, 1, 2, 8, 511] {
                if let Some(address) = anchor.checked_sub(distance) {
                    addresses.push(address);
                }
                if let Some(address) = anchor.checked_add(distance) {
                    addresses.push(address);
                }
            }
        }
        addresses.sort_unstable();
        addresses.dedup();
        addresses
    }

    #[test]
    fn checked_spans_match_widened_interval_intersection_at_every_address_boundary() {
        for address in boundary_addresses() {
            for width in [0, 1, 2, 4, 8, 10, 16, 512, u32::MAX] {
                for access in [Access::Read, Access::Write, Access::Execute] {
                    let expected = match widened_interval_oracle(address, u64::from(width)) {
                        Some((cause, failing)) => Err(Fault {
                            address,
                            width,
                            access,
                            cause,
                            failing,
                        }),
                        None => Ok(()),
                    };
                    assert_eq!(
                        check_span(address, width, access),
                        expected,
                        "address={address:#018x}, width={width}, access={access:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn long_spans_match_widened_oracle_without_confusing_last_byte_and_exclusive_end() {
        for address in boundary_addresses() {
            for length in [
                0,
                1,
                2,
                8,
                u64::from(u32::MAX),
                u64::from(u32::MAX) + 1,
                1 << 63,
                u64::MAX,
                0xffff_8000_0000_0000 - 0x0000_7fff_ffff_ffff + 1,
            ] {
                assert_eq!(
                    span_failure(address, length),
                    widened_interval_oracle(address, length),
                    "address={address:#018x}, length={length:#018x}"
                );
            }
        }
        assert_eq!(span_failure(u64::MAX, 1), None);
        assert_eq!(
            span_failure(u64::MAX, 2),
            Some((Cause::AddressRange, 1u128 << 64))
        );
        assert_eq!(
            span_failure(1, u64::MAX),
            Some((Cause::Noncanonical, 0x0000_8000_0000_0000))
        );
        assert_eq!(
            span_failure(2, u64::MAX),
            Some((Cause::AddressRange, 1u128 << 64))
        );
    }

    #[test]
    fn canonicality_distinguishes_both_halves_and_the_hole() {
        for address in [0, LOW_CANONICAL_END, HIGH_CANONICAL_START, u64::MAX] {
            assert!(canonical48(address), "{address:016x}");
        }
        for address in [LOW_CANONICAL_END + 1, HIGH_CANONICAL_START - 1] {
            assert!(!canonical48(address), "{address:016x}");
        }
    }

    #[test]
    fn the_last_u64_byte_can_be_accessed_without_wrapping_the_span() {
        assert_eq!(check_span(u64::MAX - 7, 8, Access::Read), Ok(()));
        assert_eq!(check_span(u64::MAX, 1, Access::Execute), Ok(()));
    }

    #[test]
    fn fault_metadata_distinguishes_domain_overflow_from_noncanonical_spans() {
        let address = HIGH_CANONICAL_START - 1;
        let width = u32::MAX;
        // This span is noncanonical but does not overflow; it must not be called a range failure.
        assert_eq!(
            check_span(address, width, Access::Read).unwrap_err(),
            Fault {
                address,
                width,
                access: Access::Read,
                cause: Cause::Noncanonical,
                failing: u128::from(address)
            }
        );
        assert_eq!(
            check_span(u64::MAX - 1, 4, Access::Write).unwrap_err(),
            Fault {
                address: u64::MAX - 1,
                width: 4,
                access: Access::Write,
                cause: Cause::AddressRange,
                failing: ADDRESS_DOMAIN_END
            }
        );
    }

    #[test]
    fn canonical_start_does_not_authorize_bytes_inside_the_hole() {
        assert_eq!(
            check_span(LOW_CANONICAL_END - 1, 4, Access::Read).unwrap_err(),
            Fault {
                address: LOW_CANONICAL_END - 1,
                width: 4,
                access: Access::Read,
                cause: Cause::Noncanonical,
                failing: u128::from(LOW_CANONICAL_END) + 1
            }
        );
    }

    #[test]
    fn canonical_endpoints_do_not_authorize_a_span_crossing_the_entire_hole() {
        let length = HIGH_CANONICAL_START - LOW_CANONICAL_END + 1;
        assert_eq!(
            span_failure(LOW_CANONICAL_END, length),
            Some((Cause::Noncanonical, 0x0000_8000_0000_0000))
        );
    }

    #[test]
    fn an_empty_host_copy_accesses_no_address() {
        assert_eq!(check_span(LOW_CANONICAL_END + 1, 0, Access::Read), Ok(()));
    }
}
