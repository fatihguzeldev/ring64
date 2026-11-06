use super::*;

#[test]
fn narrow_accesses_keep_high_addresses_widths_and_neighbor_bytes() {
    let base = 0x1_0000_4000;
    let mut image =
        Image::new(0x1000, vec![0x88, 0x03], base, vec![0x80, 0xff, 0xa5, 0x5a]).unwrap();
    assert_eq!(image.read(base, 1), Ok(0x80));
    assert_eq!(image.read(base, 2), Ok(0xff80));
    image.write(base + 1, 1, 0x1234).unwrap();
    assert_eq!(image.read_bytes(base, 4), Ok(vec![0x80, 0x34, 0xa5, 0x5a]));
    image.write(base + 1, 2, 0x1234_5678).unwrap();
    assert_eq!(image.read_bytes(base, 4), Ok(vec![0x80, 0x78, 0x56, 0x5a]));
    assert_eq!(image.read_for_write(base + 1, 2), Ok(0x5678));
    assert_eq!(image.read(0x4000, 1).unwrap_err().cause, Cause::Unmapped);
}

#[test]
fn a_final_byte_is_accessible_but_a_word_cannot_wrap() {
    let mut image = Image::new(0x1000, vec![0x88, 0x03], u64::MAX, vec![0xa5]).unwrap();
    assert_eq!(image.read(u64::MAX, 1), Ok(0xa5));
    image.write(u64::MAX, 1, 0xbe).unwrap();
    assert_eq!(image.read_bytes(u64::MAX, 1), Ok(vec![0xbe]));
    assert_eq!(
        image.write(u64::MAX, 2, 0xffff),
        Err(Fault {
            address: u64::MAX,
            width: 2,
            access: Access::Write,
            cause: Cause::AddressRange,
            failing: 1u128 << 64,
        })
    );
    assert_eq!(image.read_bytes(u64::MAX, 1), Ok(vec![0xbe]));
}

#[test]
fn a_word_write_checks_every_permission_before_reading_or_storing() {
    let mut image = Image::new(0x2004, vec![0x11], 0x2000, vec![0xa5, 0xb6, 0xc7, 0xd8]).unwrap();
    assert_eq!(image.read(0x2003, 2), Ok(0x11d8));
    let fault = Fault {
        address: 0x2003,
        width: 2,
        access: Access::Write,
        cause: Cause::Permission,
        failing: 0x2004,
    };
    assert_eq!(image.read_for_write(0x2003, 2), Err(fault));
    assert_eq!(image.write(0x2003, 2, 0), Err(fault));
    assert_eq!(
        image.read_bytes(0x2000, 5),
        Ok(vec![0xa5, 0xb6, 0xc7, 0xd8, 0x11])
    );
}
