use crate::memory::Fault;
use crate::x86::instruction::Width;

use super::{DecodeError, cursor::Cursor};

#[derive(Clone, Copy, Default)]
pub(super) struct Rex {
    bits: u8,
    pub(super) present: bool,
}

impl Rex {
    pub(super) fn width(self) -> Width {
        if self.bits & 8 == 0 {
            Width::W32
        } else {
            Width::W64
        }
    }

    pub(super) fn reg_extension(self) -> u8 {
        (self.bits & 4) << 1
    }

    pub(super) fn base_extension(self) -> u8 {
        (self.bits & 1) << 3
    }
}

pub(super) fn read<F>(cursor: &mut Cursor<F>) -> Result<(Rex, u8), DecodeError>
where
    F: FnMut(u64) -> Result<u8, Fault>,
{
    let first = cursor.byte()?;
    if (0x40..=0x4f).contains(&first) {
        Ok((
            Rex {
                bits: first & 15,
                present: true,
            },
            cursor.byte()?,
        ))
    } else {
        Ok((Rex::default(), first))
    }
}
