use crate::memory::Fault;
use crate::x86::instruction::{RegisterView, Width};

use super::{DecodeError, cursor::Cursor};

#[derive(Clone, Copy, Default)]
pub(super) struct Rex {
    bits: u8,
    pub(super) present: bool,
}

#[derive(Clone, Copy)]
pub(super) struct Prefixes {
    pub(super) rex: Rex,
    pub(super) operand16: bool,
}

impl Prefixes {
    pub(super) fn width(self) -> Width {
        if self.rex.width() == Width::W64 {
            Width::W64
        } else if self.operand16 {
            Width::W16
        } else {
            Width::W32
        }
    }
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

    pub(super) fn index_extension(self) -> u8 {
        (self.bits & 2) << 2
    }

    pub(super) fn view(self, register: u8, width: Width) -> RegisterView {
        if width == Width::W8 && !self.present && (4..8).contains(&register) {
            RegisterView::high_byte(register - 4)
        } else {
            RegisterView::low(register)
        }
    }
}

pub(super) fn read<F>(cursor: &mut Cursor<F>) -> Result<(Prefixes, u8), DecodeError>
where
    F: FnMut(u64) -> Result<u8, Fault>,
{
    let first = cursor.byte()?;
    let operand16 = first == 0x66;
    let candidate = if operand16 { cursor.byte()? } else { first };
    let (rex, opcode) = if (0x40..=0x4f).contains(&candidate) {
        (
            Rex {
                bits: candidate & 15,
                present: true,
            },
            cursor.byte()?,
        )
    } else {
        (Rex::default(), candidate)
    };
    if matches!(opcode, 0x26 | 0x2e | 0x36 | 0x3e | 0x40..=0x4f | 0x64..=0x67 | 0xf0 | 0xf2 | 0xf3)
    {
        return Err(DecodeError::Unsupported);
    }
    Ok((Prefixes { rex, operand16 }, opcode))
}
