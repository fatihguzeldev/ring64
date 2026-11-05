use super::address::check_span;
use super::image::Kind;
use super::{Access, Cause, Fault, Image};

impl Image {
    pub fn fetch(&self, address: u64) -> Result<u8, Fault> {
        self.preflight(address, 1, Access::Execute)?;
        Ok(self.code.bytes[(address - self.code.base) as usize])
    }

    pub fn read(&self, address: u64, width: u32) -> Result<u64, Fault> {
        assert!(matches!(width, 4 | 8), "scalar access width must be 4 or 8");
        self.preflight(address, width, Access::Read)?;
        Ok(self.scalar_after_preflight(address, width))
    }

    pub fn read_for_write(&self, address: u64, width: u32) -> Result<u64, Fault> {
        assert!(matches!(width, 4 | 8), "scalar access width must be 4 or 8");
        // In this fixed image, every writable span is also readable.
        self.preflight(address, width, Access::Write)?;
        Ok(self.scalar_after_preflight(address, width))
    }

    pub fn write(&mut self, address: u64, width: u32, value: u64) -> Result<(), Fault> {
        assert!(matches!(width, 4 | 8), "scalar access width must be 4 or 8");
        self.write_bytes(address, &value.to_le_bytes()[..width as usize])
    }

    pub fn read_bytes(&self, address: u64, length: u32) -> Result<Vec<u8>, Fault> {
        self.preflight(address, length, Access::Read)?;
        let mut output = Vec::with_capacity(length as usize);
        let mut cursor = u128::from(address);
        let end = cursor + u128::from(length);
        while cursor < end {
            let (_, span) = self
                .locate(cursor as u64)
                .expect("preflight proved a readable span");
            let offset = (cursor as u64 - span.base) as usize;
            let count = (end.min(span.end()) - cursor) as usize;
            output.extend_from_slice(&span.bytes[offset..offset + count]);
            cursor += count as u128;
        }
        Ok(output)
    }

    pub fn write_bytes(&mut self, address: u64, bytes: &[u8]) -> Result<(), Fault> {
        let width = u32::try_from(bytes.len()).expect("memory copy length exceeds u32");
        self.preflight(address, width, Access::Write)?;
        if !bytes.is_empty() {
            let offset = (address - self.ram.base) as usize;
            self.ram.bytes[offset..offset + bytes.len()].copy_from_slice(bytes);
        }
        Ok(())
    }

    fn preflight(&self, address: u64, width: u32, access: Access) -> Result<(), Fault> {
        check_span(address, width, access)?;
        let mut cursor = u128::from(address);
        let end = cursor + u128::from(width);
        while cursor < end {
            let failure = |cause| Fault {
                address,
                width,
                access,
                cause,
                failing: cursor,
            };
            let (kind, span) = self
                .locate(cursor as u64)
                .ok_or_else(|| failure(Cause::Unmapped))?;
            let permitted = match access {
                Access::Read => true,
                Access::Write => kind == Kind::Ram,
                Access::Execute => kind == Kind::Code,
            };
            if !permitted {
                return Err(failure(Cause::Permission));
            }
            cursor = end.min(span.end());
        }
        Ok(())
    }

    fn scalar_after_preflight(&self, address: u64, width: u32) -> u64 {
        let mut value = 0;
        for byte in 0..width {
            value |= u64::from(self.byte_after_preflight(address + u64::from(byte))) << (byte * 8);
        }
        value
    }

    fn byte_after_preflight(&self, address: u64) -> u8 {
        let (_, span) = self
            .locate(address)
            .expect("preflight proved a readable span");
        span.bytes[(address - span.base) as usize]
    }
}

#[cfg(test)]
mod tests {
    use super::super::{Access, Cause};
    use super::*;

    mod read_for_write;

    #[test]
    fn loads_can_cross_readable_code_and_ram_but_ram_is_not_executable() {
        let image = Image::new(0x1000, vec![0x8b, 0x03], 0x1002, vec![0x34, 0x12]).unwrap();
        assert_eq!(image.fetch(0x1000), Ok(0x8b));
        assert_eq!(image.read(0x1000, 4), Ok(0x1234_038b));
        assert_eq!(image.read_bytes(0x1001, 3), Ok(vec![0x03, 0x34, 0x12]));
        assert_eq!(
            image.fetch(0x1002),
            Err(Fault {
                address: 0x1002,
                width: 1,
                access: Access::Execute,
                cause: Cause::Permission,
                failing: 0x1002
            })
        );
    }

    #[test]
    fn a_late_code_permission_failure_prevents_every_store_byte() {
        let mut image = Image::new(0x2004, vec![5, 6, 7, 8], 0x2000, vec![1, 2, 3, 4]).unwrap();
        assert_eq!(
            image.write(0x2002, 4, 0xffff_ffff),
            Err(Fault {
                address: 0x2002,
                width: 4,
                access: Access::Write,
                cause: Cause::Permission,
                failing: 0x2004
            })
        );
        assert_eq!(
            image.read_bytes(0x2000, 8),
            Ok(vec![1, 2, 3, 4, 5, 6, 7, 8])
        );
    }

    #[test]
    fn the_first_disallowed_byte_wins_before_a_later_unmapped_byte() {
        let mut image = Image::new(0x2004, vec![5, 6, 7, 8], 0x2000, vec![1, 2, 3, 4]).unwrap();
        assert_eq!(
            image.write_bytes(0x2002, &[0xff; 8]),
            Err(Fault {
                address: 0x2002,
                width: 8,
                access: Access::Write,
                cause: Cause::Permission,
                failing: 0x2004
            })
        );
        assert_eq!(
            image.read(0x2002, 8),
            Err(Fault {
                address: 0x2002,
                width: 8,
                access: Access::Read,
                cause: Cause::Unmapped,
                failing: 0x2008
            })
        );
        assert_eq!(image.read(0x2000, 8), Ok(0x0807_0605_0403_0201));
    }

    #[test]
    fn a_failed_store_preserves_bytes_from_an_earlier_completed_store() {
        let mut image = Image::new(0x1000, vec![0xb8], 0x4000, vec![0x11; 5]).unwrap();
        image.write(0x4000, 4, 0x7856_3412).unwrap();
        assert_eq!(
            image.write(0x4002, 4, 0xffff_ffff),
            Err(Fault {
                address: 0x4002,
                width: 4,
                access: Access::Write,
                cause: Cause::Unmapped,
                failing: 0x4005
            })
        );
        assert_eq!(
            image.read_bytes(0x4000, 5),
            Ok(vec![0x12, 0x34, 0x56, 0x78, 0x11])
        );
    }

    #[test]
    fn complete_domain_and_canonical_checks_precede_mapping_checks() {
        let image = Image::new(0x1000, vec![0xb8], 0x4000, vec![0; 8]).unwrap();
        assert_eq!(
            image.read(u64::MAX - 1, 4),
            Err(Fault {
                address: u64::MAX - 1,
                width: 4,
                access: Access::Read,
                cause: Cause::AddressRange,
                failing: 1u128 << 64
            })
        );
        assert_eq!(
            image.read(0x0000_7fff_ffff_fffe, 4),
            Err(Fault {
                address: 0x0000_7fff_ffff_fffe,
                width: 4,
                access: Access::Read,
                cause: Cause::Noncanonical,
                failing: 0x0000_8000_0000_0000
            })
        );
        assert_eq!(
            image.fetch(0x0000_8000_0000_0000),
            Err(Fault {
                address: 0x0000_8000_0000_0000,
                width: 1,
                access: Access::Execute,
                cause: Cause::Noncanonical,
                failing: 0x0000_8000_0000_0000
            })
        );
    }

    #[test]
    fn high_guest_addresses_do_not_alias_their_low_32_bits() {
        let image = Image::new(
            0x1000,
            vec![0xb8],
            0x1_0000_4000,
            vec![0x78, 0x56, 0x34, 0x12],
        )
        .unwrap();
        assert_eq!(image.read(0x1_0000_4000, 4), Ok(0x1234_5678));
        assert_eq!(
            image.read(0x4000, 4),
            Err(Fault {
                address: 0x4000,
                width: 4,
                access: Access::Read,
                cause: Cause::Unmapped,
                failing: 0x4000
            })
        );
    }

    #[test]
    fn scalar_width_and_little_endian_order_preserve_neighboring_bytes() {
        let mut image = Image::new(0x1000, vec![0xb8], 0x4000, (0xa0..=0xaf).collect()).unwrap();
        image.write(0x4004, 4, 0x1122_3344_5566_7788).unwrap();
        assert_eq!(image.read(0x4004, 4), Ok(0x5566_7788));
        image.write(0x4008, 8, 0xfedc_ba98_7654_3210).unwrap();
        assert_eq!(image.read(0x4008, 8), Ok(0xfedc_ba98_7654_3210));
        assert_eq!(
            image.read_bytes(0x4000, 16),
            Ok(vec![
                0xa0, 0xa1, 0xa2, 0xa3, 0x88, 0x77, 0x66, 0x55, 0x10, 0x32, 0x54, 0x76, 0x98, 0xba,
                0xdc, 0xfe,
            ])
        );
    }

    #[test]
    fn fetch_and_load_allow_the_last_address_in_the_domain() {
        let image = Image::new(
            u64::MAX - 4,
            vec![0xb8, 0x78, 0x56, 0x34, 0x12],
            0x4000,
            vec![0],
        )
        .unwrap();
        assert_eq!(image.fetch(u64::MAX), Ok(0x12));
        assert_eq!(image.read(u64::MAX - 3, 4), Ok(0x1234_5678));
        assert_eq!(
            image.read_bytes(u64::MAX - 3, 4),
            Ok(vec![0x78, 0x56, 0x34, 0x12])
        );
    }

    #[test]
    fn ram_writes_can_end_at_max_without_aliasing_zero_or_changing_guards() {
        let mut image = Image::new(0x1000, vec![0xb8], u64::MAX - 7, vec![0x11; 8]).unwrap();
        image.write(u64::MAX - 3, 4, 0x7856_3412).unwrap();
        assert_eq!(
            image.read_bytes(u64::MAX - 7, 8),
            Ok(vec![0x11, 0x11, 0x11, 0x11, 0x12, 0x34, 0x56, 0x78])
        );
        let before = image.read_bytes(u64::MAX - 7, 8).unwrap();
        assert_eq!(
            image.write(u64::MAX - 1, 4, 0).unwrap_err().failing,
            1u128 << 64
        );
        assert_eq!(image.read_bytes(u64::MAX - 7, 8), Ok(before));
    }

    #[test]
    fn unmapped_fetch_reports_the_requested_instruction_byte() {
        let image = Image::new(0x1000, vec![0xb8], 0x4000, vec![0]).unwrap();
        assert_eq!(
            image.fetch(0x1001),
            Err(Fault {
                address: 0x1001,
                width: 1,
                access: Access::Execute,
                cause: Cause::Unmapped,
                failing: 0x1001
            })
        );
    }

    #[test]
    fn empty_copies_are_no_ops_and_readbacks_are_owned() {
        let mut image = Image::new(0x1000, vec![0xb8], 0x4000, vec![1, 2, 3, 4]).unwrap();
        assert_eq!(image.read_bytes(0x8000_0000_0000, 0), Ok(vec![]));
        assert_eq!(image.write_bytes(0x8000_0000_0000, &[]), Ok(()));
        let mut copy = image.read_bytes(0x4000, 4).unwrap();
        copy[0] = 0xff;
        assert_eq!(image.read_bytes(0x4000, 4), Ok(vec![1, 2, 3, 4]));
    }
}
