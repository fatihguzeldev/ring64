use super::{DecodeError, cursor::Cursor};
use crate::x86::context::{ExecutionContext, Mode, Segment};
use crate::x86::instruction::{RegisterView, Width};

#[derive(Clone, Copy, Default)]
pub(super) struct Rex {
    bits: u8,
    pub(super) present: bool,
}

#[derive(Clone, Copy)]
pub(super) struct Prefixes {
    pub(super) rex: Rex,
    pub(super) operand_override: bool,
    pub(super) address_override: bool,
    pub(super) segment_override: Option<Segment>,
    pub(super) long64: bool,
    pub(super) mode: Mode,
    default32: bool,
}

impl Prefixes {
    pub(super) fn width(self) -> Width {
        if self.long64 {
            if self.rex.width() == Width::W64 {
                Width::W64
            } else if self.operand_override {
                Width::W16
            } else {
                Width::W32
            }
        } else if self.default32 != self.operand_override {
            Width::W32
        } else {
            Width::W16
        }
    }

    pub(super) fn address_width(self) -> Width {
        if self.long64 {
            if self.address_override {
                Width::W32
            } else {
                Width::W64
            }
        } else if self.default32 != self.address_override {
            Width::W32
        } else {
            Width::W16
        }
    }

    pub(super) fn near_width(self) -> Width {
        if self.long64 {
            Width::W64
        } else {
            self.width()
        }
    }

    pub(super) fn stack_width(self) -> Width {
        if self.long64 {
            if self.operand_override && self.rex.width() != Width::W64 {
                Width::W16
            } else {
                Width::W64
            }
        } else {
            self.width()
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

pub(super) fn read<F>(
    cursor: &mut Cursor<F>,
    context: &ExecutionContext,
) -> Result<(Prefixes, u8), DecodeError>
where
    F: FnMut(u64) -> Result<u8, DecodeError>,
{
    let mut prefixes = Prefixes {
        rex: Rex::default(),
        operand_override: false,
        address_override: false,
        segment_override: None,
        long64: context.is_long64(),
        mode: context.mode(),
        default32: context.code32(),
    };
    loop {
        let byte = cursor.byte()?;
        match byte {
            0x66 => {
                prefixes.operand_override = true;
                prefixes.rex = Rex::default();
            }
            0x67 => {
                prefixes.address_override = true;
                prefixes.rex = Rex::default();
            }
            0x26 | 0x2e | 0x36 | 0x3e | 0x64 | 0x65 => {
                let segment = match byte {
                    0x26 => Segment::Es,
                    0x2e => Segment::Cs,
                    0x36 => Segment::Ss,
                    0x3e => Segment::Ds,
                    0x64 => Segment::Fs,
                    _ => Segment::Gs,
                };
                if !prefixes.long64 || matches!(segment, Segment::Fs | Segment::Gs) {
                    prefixes.segment_override = Some(segment);
                }
                prefixes.rex = Rex::default();
            }
            0x40..=0x4f if prefixes.long64 => {
                prefixes.rex = Rex {
                    bits: byte & 15,
                    present: true,
                };
            }
            0xf0 | 0xf2 | 0xf3 => return Err(DecodeError::Unsupported),
            _ => return Ok((prefixes, byte)),
        }
    }
}
