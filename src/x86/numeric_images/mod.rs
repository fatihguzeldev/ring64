use super::x87::State as X87State;

mod fx;
mod legacy;

#[cfg(test)]
mod tests;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    LoadEnvironment,
    StoreEnvironment,
    Restore,
    Save,
    RestoreFx,
    SaveFx,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Format {
    Protected16,
    Protected32,
    Real16,
    Real32,
    FxLegacy,
    Fx64,
    Fx64Wide,
}

impl Format {
    fn is_fx(self) -> bool {
        matches!(self, Self::FxLegacy | Self::Fx64 | Self::Fx64Wide)
    }

    fn environment_bytes(self) -> u32 {
        match self {
            Self::Protected16 | Self::Real16 => 14,
            Self::Protected32 | Self::Real32 => 28,
            _ => 0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ImageOp {
    pub kind: Kind,
    pub format: Format,
}

impl ImageOp {
    pub fn encode(self) -> u32 {
        self.kind as u32 | (self.format as u32) << 3
    }

    pub fn try_decode(value: u32) -> Option<Self> {
        let kind = *[
            Kind::LoadEnvironment,
            Kind::StoreEnvironment,
            Kind::Restore,
            Kind::Save,
            Kind::RestoreFx,
            Kind::SaveFx,
        ]
        .get((value & 7) as usize)?;
        let format = *[
            Format::Protected16,
            Format::Protected32,
            Format::Real16,
            Format::Real32,
            Format::FxLegacy,
            Format::Fx64,
            Format::Fx64Wide,
        ]
        .get((value >> 3) as usize)?;
        (format.is_fx() == matches!(kind, Kind::RestoreFx | Kind::SaveFx))
            .then_some(Self { kind, format })
    }

    pub fn width(self) -> u32 {
        if self.format.is_fx() {
            512
        } else {
            self.format.environment_bytes()
                + if matches!(self.kind, Kind::Restore | Kind::Save) {
                    80
                } else {
                    0
                }
        }
    }

    pub fn is_store(self) -> bool {
        matches!(
            self.kind,
            Kind::StoreEnvironment | Kind::Save | Kind::SaveFx
        )
    }

    pub fn is_waiting(self) -> bool {
        matches!(self.kind, Kind::LoadEnvironment | Kind::Restore)
    }

    pub fn xmm_count(self) -> usize {
        match self.format {
            Format::FxLegacy => 8,
            Format::Fx64 | Format::Fx64Wide => 16,
            _ => 0,
        }
    }

    pub fn alignment(self) -> u32 {
        if self.format.is_fx() { 16 } else { 1 }
    }

    pub fn spans(self) -> &'static [(u32, u32)] {
        let full = matches!(self.kind, Kind::Save | Kind::Restore);
        match self.format {
            Format::Protected16 | Format::Real16 => {
                if full {
                    &[(0, 94)]
                } else {
                    &[(0, 14)]
                }
            }
            Format::Protected32 => {
                if full {
                    &[(0, 2), (4, 2), (8, 2), (12, 14), (28, 80)]
                } else {
                    &[(0, 2), (4, 2), (8, 2), (12, 14)]
                }
            }
            Format::Real32 => {
                if full {
                    &[(0, 2), (4, 2), (8, 2), (12, 2), (16, 6), (24, 84)]
                } else {
                    &[(0, 2), (4, 2), (8, 2), (12, 2), (16, 6), (24, 4)]
                }
            }
            Format::FxLegacy => &[
                (0, 5),
                (6, 8),
                (16, 6),
                (24, 8),
                (32, 10),
                (48, 10),
                (64, 10),
                (80, 10),
                (96, 10),
                (112, 10),
                (128, 10),
                (144, 10),
                (160, 128),
            ],
            Format::Fx64 => &[
                (0, 5),
                (6, 8),
                (16, 6),
                (24, 8),
                (32, 10),
                (48, 10),
                (64, 10),
                (80, 10),
                (96, 10),
                (112, 10),
                (128, 10),
                (144, 10),
                (160, 256),
            ],
            Format::Fx64Wide => &[
                (0, 5),
                (6, 26),
                (32, 10),
                (48, 10),
                (64, 10),
                (80, 10),
                (96, 10),
                (112, 10),
                (128, 10),
                (144, 10),
                (160, 256),
            ],
        }
    }
}

pub struct Saved {
    pub bytes: [u8; 512],
    pub x87: X87State,
}

pub struct Restored {
    pub x87: X87State,
    pub xmm: [[u8; 16]; 16],
    pub mxcsr: u32,
}

pub fn save(operation: ImageOp, x87: &X87State, xmm: &[[u8; 16]; 16], mxcsr: u32) -> Saved {
    assert!(operation.is_store());
    let mut after = *x87;
    match operation.kind {
        Kind::StoreEnvironment => {
            after.control_word |= 0x3f;
            after.refresh();
        }
        Kind::Save => {
            after = X87State {
                registers: x87.registers,
                ..X87State::default()
            };
        }
        _ => {}
    }
    Saved {
        bytes: if operation.format.is_fx() {
            fx::save(operation, x87, xmm, mxcsr)
        } else {
            legacy::save(operation, x87)
        },
        x87: after,
    }
}

pub fn restore(
    operation: ImageOp,
    bytes: &[u8; 512],
    before_x87: &X87State,
    before_xmm: &[[u8; 16]; 16],
    before_mxcsr: u32,
) -> Result<Restored, u32> {
    assert!(!operation.is_store());
    let mxcsr = if operation.format.is_fx() {
        let loaded = dword(bytes, 24);
        if loaded & !0xffff != 0 {
            return Err(loaded);
        }
        loaded
    } else {
        before_mxcsr
    };
    let mut result = Restored {
        x87: *before_x87,
        xmm: *before_xmm,
        mxcsr,
    };
    if operation.format.is_fx() {
        fx::restore(operation, bytes, &mut result);
    } else {
        legacy::restore(operation, bytes, &mut result.x87);
    }
    Ok(result)
}

fn word(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes(bytes[at..at + 2].try_into().unwrap())
}

fn dword(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}

fn put_word(bytes: &mut [u8], at: usize, value: u16) {
    bytes[at..at + 2].copy_from_slice(&value.to_le_bytes());
}

fn put_dword(bytes: &mut [u8], at: usize, value: u32) {
    bytes[at..at + 4].copy_from_slice(&value.to_le_bytes());
}
