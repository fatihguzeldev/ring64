use super::{
    DecodeError,
    cursor::Cursor,
    prefix::{Prefixes, Rex},
};
use crate::x86::context::Segment;
use crate::x86::instruction::{Address, AddressBase, AddressIndex, Location, Width};

pub(super) struct ModRm {
    pub(super) mode: u8,
    pub(super) selector: u8,
    pub(super) register: u8,
    pub(super) rm: u8,
    rm_low: u8,
}

impl ModRm {
    pub(super) fn location<F>(
        &self,
        cursor: &mut Cursor<F>,
        prefixes: Prefixes,
        width: Width,
    ) -> Result<Location, DecodeError>
    where
        F: FnMut(u64) -> Result<u8, DecodeError>,
    {
        if self.mode == 3 {
            Ok(Location::Register(prefixes.rex.view(self.rm, width)))
        } else {
            Ok(Location::Memory(self.address(cursor, prefixes)?))
        }
    }

    pub(super) fn read<F>(cursor: &mut Cursor<F>, rex: Rex) -> Result<Self, DecodeError>
    where
        F: FnMut(u64) -> Result<u8, DecodeError>,
    {
        let byte = cursor.byte()?;
        let selector = (byte >> 3) & 7;
        let rm_low = byte & 7;
        Ok(Self {
            mode: byte >> 6,
            selector,
            register: selector | rex.reg_extension(),
            rm: rm_low | rex.base_extension(),
            rm_low,
        })
    }

    pub(super) fn address<F>(
        &self,
        cursor: &mut Cursor<F>,
        prefixes: Prefixes,
    ) -> Result<Address, DecodeError>
    where
        F: FnMut(u64) -> Result<u8, DecodeError>,
    {
        if self.mode == 3 {
            return Err(DecodeError::Unsupported);
        }
        if prefixes.address_width() == Width::W16 {
            return self.address16(cursor, prefixes);
        }
        let rex = prefixes.rex;
        let (base, index) = if self.rm_low == 4 {
            let sib = cursor.byte()?;
            let base_low = sib & 7;
            let base = if self.mode == 0 && base_low == 5 {
                AddressBase::None
            } else {
                AddressBase::Register(base_low | rex.base_extension())
            };
            let register = ((sib >> 3) & 7) | rex.index_extension();
            let index = (register != 4).then_some(AddressIndex {
                register,
                scale: 1 << (sib >> 6),
            });
            (base, index)
        } else if self.mode == 0 && self.rm_low == 5 {
            (
                if prefixes.long64 {
                    AddressBase::NextPc
                } else {
                    AddressBase::None
                },
                None,
            )
        } else {
            (AddressBase::Register(self.rm), None)
        };
        let displacement = match (self.mode, base) {
            (0, AddressBase::NextPc | AddressBase::None) | (2, _) => {
                i64::from(cursor.unsigned(4)? as u32 as i32)
            }
            (0, _) => 0,
            (1, _) => i64::from(cursor.byte()? as i8),
            _ => unreachable!(),
        };
        let default = if matches!(base, AddressBase::Register(4 | 5)) {
            Segment::Ss
        } else {
            Segment::Ds
        };
        Ok(Address {
            base,
            index,
            displacement,
            size: prefixes.address_width(),
            segment: prefixes.segment_override.unwrap_or(default),
        })
    }

    fn address16<F>(
        &self,
        cursor: &mut Cursor<F>,
        prefixes: Prefixes,
    ) -> Result<Address, DecodeError>
    where
        F: FnMut(u64) -> Result<u8, DecodeError>,
    {
        let (base, index) = match self.rm_low {
            0 => (AddressBase::Register(3), Some(6)),
            1 => (AddressBase::Register(3), Some(7)),
            2 => (AddressBase::Register(5), Some(6)),
            3 => (AddressBase::Register(5), Some(7)),
            4 => (AddressBase::Register(6), None),
            5 => (AddressBase::Register(7), None),
            6 if self.mode == 0 => (AddressBase::None, None),
            6 => (AddressBase::Register(5), None),
            7 => (AddressBase::Register(3), None),
            _ => unreachable!(),
        };
        let displacement = match (self.mode, base) {
            (0, AddressBase::None) => i64::from(cursor.unsigned(2)? as u16),
            (0, _) => 0,
            (1, _) => i64::from(cursor.byte()? as i8),
            (2, _) => i64::from(cursor.unsigned(2)? as u16 as i16),
            _ => unreachable!(),
        };
        let default = if base == AddressBase::Register(5) {
            Segment::Ss
        } else {
            Segment::Ds
        };
        Ok(Address {
            base,
            index: index.map(|register| AddressIndex { register, scale: 1 }),
            displacement,
            size: Width::W16,
            segment: prefixes.segment_override.unwrap_or(default),
        })
    }
}
