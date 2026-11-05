use super::{Access, Cause, Fault, Image};

#[test]
fn write_intent_reads_return_only_the_selected_scalar_without_changing_guards() {
    let bytes = vec![
        0xa0, 0xa1, 0xa2, 0xa3, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11, 0xac, 0xad, 0xae,
        0xaf,
    ];
    let image = Image::new(0x1000, vec![0x83, 0x0b, 0], 0x4000, bytes.clone()).unwrap();
    assert_eq!(image.read_for_write(0x4004, 4), Ok(0x5566_7788));
    assert_eq!(image.read_for_write(0x4004, 8), Ok(0x1122_3344_5566_7788));
    assert_eq!(image.read_bytes(0x4000, 16), Ok(bytes));
    assert_eq!(image.read_bytes(0x1000, 3), Ok(vec![0x83, 0x0b, 0]));
}

#[test]
fn readable_code_still_requires_write_permission_for_an_unchanged_value() {
    let code = vec![0x48, 0x83, 0x0b, 0, 1, 0, 0, 0, 0, 0, 0, 0];
    let image = Image::new(0x1000, code.clone(), 0x4000, vec![0xa5; 8]).unwrap();
    for width in [4, 8] {
        assert_eq!(image.read(0x1004, width), Ok(1));
        assert_eq!(
            image.read_for_write(0x1004, width),
            Err(Fault {
                address: 0x1004,
                width,
                access: Access::Write,
                cause: Cause::Permission,
                failing: 0x1004,
            })
        );
    }
    assert_eq!(image.read_bytes(0x1000, 12), Ok(code));
    assert_eq!(image.read_bytes(0x4000, 8), Ok(vec![0xa5; 8]));
}

#[test]
fn write_permission_precedes_a_later_read_unmapped_failure_at_the_same_operand() {
    let image = Image::new(
        0x2004,
        vec![0x48, 0x83, 0x0b, 0],
        0x2000,
        vec![0x11, 0x22, 0x33, 0x44],
    )
    .unwrap();
    assert_eq!(image.read(0x2002, 4), Ok(0x8348_4433));
    assert_eq!(
        image.read(0x2002, 8),
        Err(Fault {
            address: 0x2002,
            width: 8,
            access: Access::Read,
            cause: Cause::Unmapped,
            failing: 0x2008,
        })
    );
    for width in [4, 8] {
        assert_eq!(
            image.read_for_write(0x2002, width),
            Err(Fault {
                address: 0x2002,
                width,
                access: Access::Write,
                cause: Cause::Permission,
                failing: 0x2004,
            })
        );
    }
    assert_eq!(
        image.read_bytes(0x2000, 8),
        Ok(vec![0x11, 0x22, 0x33, 0x44, 0x48, 0x83, 0x0b, 0])
    );
}

#[test]
fn an_earlier_unmapped_byte_wins_over_later_code_permissions() {
    let image = Image::new(0x2004, vec![0x48, 0x83, 0x0b, 0], 0x4000, vec![0]).unwrap();
    for width in [4, 8] {
        assert_eq!(
            image.read_for_write(0x2002, width),
            Err(Fault {
                address: 0x2002,
                width,
                access: Access::Write,
                cause: Cause::Unmapped,
                failing: 0x2002,
            })
        );
    }
}

#[test]
fn write_intent_checks_the_full_ram_span_without_changing_a_valid_prefix() {
    let bytes = vec![0x11, 0x22, 0x33, 0x44, 0x55];
    let image = Image::new(0x1000, vec![0x90], 0x4000, bytes.clone()).unwrap();
    assert_eq!(image.read_for_write(0x4001, 4), Ok(0x5544_3322));
    for width in [4, 8] {
        assert_eq!(
            image.read_for_write(0x4002, width),
            Err(Fault {
                address: 0x4002,
                width,
                access: Access::Write,
                cause: Cause::Unmapped,
                failing: 0x4005,
            })
        );
    }
    assert_eq!(image.read_bytes(0x4000, 5), Ok(bytes));
}

#[test]
fn write_intent_range_and_canonical_checks_precede_mapping_permissions() {
    for (address, cause, failing) in [
        (u64::MAX - 1, Cause::AddressRange, 1u128 << 64),
        (0x7fff_ffff_fffe, Cause::Noncanonical, 0x8000_0000_0000),
    ] {
        let image = Image::new(address, vec![0x11, 0x22], 0x4000, vec![0]).unwrap();
        for width in [4, 8] {
            assert_eq!(
                image.read_for_write(address, width),
                Err(Fault {
                    address,
                    width,
                    access: Access::Write,
                    cause,
                    failing,
                })
            );
        }
    }
    let image = Image::new(0x1000, vec![0x90], 0x4000, vec![0]).unwrap();
    for width in [4, 8] {
        assert_eq!(
            image.read_for_write(0x8000_0000_0000, width),
            Err(Fault {
                address: 0x8000_0000_0000,
                width,
                access: Access::Write,
                cause: Cause::Noncanonical,
                failing: 0x8000_0000_0000,
            })
        );
    }
}

#[test]
fn write_intent_keeps_high_addresses_and_last_byte_widths_without_aliasing() {
    let bytes = vec![
        0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22,
        0x11,
    ];
    for base in [0x1_0000_4000, u64::MAX - 15] {
        let image = Image::new(0x1000, vec![0x90], base, bytes.clone()).unwrap();
        assert_eq!(image.read_for_write(base + 8, 8), Ok(0x1122_3344_5566_7788));
        assert_eq!(image.read_for_write(base + 12, 4), Ok(0x1122_3344));
        let low = (base + 8) & 0xffff_ffff;
        assert_eq!(
            image.read_for_write(low, 8),
            Err(Fault {
                address: low,
                width: 8,
                access: Access::Write,
                cause: Cause::Unmapped,
                failing: u128::from(low),
            })
        );
        assert_eq!(image.read_bytes(base, 16), Ok(bytes.clone()));
    }
}
