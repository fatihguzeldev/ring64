use crate::memory::Fault;
use crate::x86::instruction::{Address, AddressBase, AddressIndex};

use super::{DecodeError, cursor::Cursor, prefix::Rex};

pub(super) struct ModRm {
    pub(super) mode: u8,
    pub(super) selector: u8,
    pub(super) register: u8,
    pub(super) rm: u8,
    rm_low: u8,
}

impl ModRm {
    pub(super) fn read<F>(cursor: &mut Cursor<F>, rex: Rex) -> Result<Self, DecodeError>
    where
        F: FnMut(u64) -> Result<u8, Fault>,
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
        rex: Rex,
    ) -> Result<Address, DecodeError>
    where
        F: FnMut(u64) -> Result<u8, Fault>,
    {
        if self.mode == 3 {
            return Err(DecodeError::Unsupported);
        }
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
            (AddressBase::NextPc, None)
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
        Ok(Address {
            base,
            index,
            displacement,
        })
    }
}
