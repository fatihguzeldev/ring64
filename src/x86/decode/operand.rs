use crate::memory::Fault;
use crate::x86::instruction::Address;

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

    pub(super) fn address<F>(&self, cursor: &mut Cursor<F>) -> Result<Address, DecodeError>
    where
        F: FnMut(u64) -> Result<u8, Fault>,
    {
        // These low-bit forms keep their special meaning even with REX.B.
        if self.mode == 3 || self.rm_low == 4 || (self.mode == 0 && self.rm_low == 5) {
            return Err(DecodeError::Unsupported);
        }
        let displacement = match self.mode {
            0 => 0,
            1 => i64::from(cursor.byte()? as i8),
            2 => i64::from(cursor.unsigned(4)? as u32 as i32),
            _ => unreachable!(),
        };
        Ok(Address {
            base: self.rm,
            displacement,
        })
    }
}
