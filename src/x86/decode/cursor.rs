use super::DecodeError;
use crate::memory::{Access, Cause, Fault};

pub(super) struct Cursor<F> {
    pc: u64,
    consumed: u32,
    long64: bool,
    read: F,
}

impl<F> Cursor<F>
where
    F: FnMut(u64) -> Result<u8, DecodeError>,
{
    pub(super) fn new(pc: u64, long64: bool, read: F) -> Self {
        Self {
            pc,
            consumed: 0,
            long64,
            read,
        }
    }

    pub(super) fn byte(&mut self) -> Result<u8, DecodeError> {
        if self.consumed == 15 {
            return Err(DecodeError::InstructionLength);
        }
        // Required bytes never wrap; a completed next IP may wrap independently.
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
        let byte = (self.read)(address as u64)?;
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
        let next = self.pc.wrapping_add(u64::from(self.consumed));
        if self.long64 {
            next
        } else {
            u64::from(next as u32)
        }
    }
}
