use crate::memory::{Access, Cause, Fault};

use super::DecodeError;

pub(super) struct Cursor<F> {
    pc: u64,
    consumed: u32,
    read: F,
}

impl<F> Cursor<F>
where
    F: FnMut(u64) -> Result<u8, Fault>,
{
    pub(super) fn new(pc: u64, read: F) -> Self {
        Self {
            pc,
            consumed: 0,
            read,
        }
    }

    pub(super) fn byte(&mut self) -> Result<u8, DecodeError> {
        if self.consumed == 15 {
            return Err(DecodeError::Invalid);
        }
        // Instruction bytes cannot wrap even though the completed next PC can.
        let address = u128::from(self.pc) + u128::from(self.consumed);
        if address > u128::from(u64::MAX) {
            return Err(DecodeError::Fetch(Fault {
                address: self.pc,
                width: self.consumed + 1,
                access: Access::Execute,
                cause: Cause::AddressRange,
                failing: 1u128 << 64,
            }));
        }
        let byte = (self.read)(address as u64).map_err(DecodeError::Fetch)?;
        self.consumed += 1;
        Ok(byte)
    }

    pub(super) fn unsigned(&mut self, bytes: u8) -> Result<u64, DecodeError> {
        let mut value = 0;
        for index in 0..bytes {
            value |= u64::from(self.byte()?) << (index * 8);
        }
        Ok(value)
    }

    pub(super) fn next_pc(&self) -> u64 {
        self.pc.wrapping_add(u64::from(self.consumed))
    }
}
