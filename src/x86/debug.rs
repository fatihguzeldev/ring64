use crate::memory::{Access, canonical48};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(C)]
pub struct State {
    pub addresses: [u64; 4],
    pub dr6: u64,
    pub dr7: u64,
}
impl Default for State {
    fn default() -> Self {
        Self {
            addresses: [0; 4],
            dr6: 0xffff0ff0,
            dr7: 0x400,
        }
    }
}
impl State {
    pub fn normalize(&mut self) {
        self.dr6 = (self.dr6 & 0xe00f) | 0xffff0ff0;
        self.dr7 = (self.dr7 & 0xffff23ff) | 0x400;
    }
    fn slot(&self, slot: usize) -> Option<(u64, u64, u64)> {
        if self.dr7 & (3 << (slot * 2)) == 0 {
            return None;
        }
        let configuration = (self.dr7 >> (16 + slot * 4)) & 15;
        let kind = configuration & 3;
        if kind == 2 || kind == 0 && configuration != 0 {
            return None;
        }
        let width = [1, 2, 8, 4][(configuration >> 2) as usize];
        let start = self.addresses[slot];
        let end = start.checked_add(width - 1)?;
        (start % width == 0 && canonical48(start) && canonical48(end)).then_some((start, end, kind))
    }
    pub fn active(&self) -> bool {
        (0..4).any(|slot| self.slot(slot).is_some())
    }
    pub fn matches(&self, address: u64, width: u32, access: Access) -> u8 {
        let Some(end) = width
            .checked_sub(1)
            .and_then(|w| address.checked_add(u64::from(w)))
        else {
            return 0;
        };
        if !canonical48(address) || !canonical48(end) {
            return 0;
        }
        let mut hits = 0;
        for slot in 0..4 {
            if let Some((start, last, kind)) = self.slot(slot)
                && match access {
                    Access::Execute => kind == 0 && address == start,
                    Access::Read => kind == 3 && address <= last && end >= start,
                    Access::Write => kind != 0 && address <= last && end >= start,
                }
            {
                hits |= 1 << slot;
            }
        }
        hits
    }
    pub fn select(&mut self, slots: u8, single_step: bool, general_detect: bool) {
        self.dr6 = (self.dr6 & !15)
            | u64::from(slots & 15)
            | if single_step { 1 << 14 } else { 0 }
            | if general_detect { 1 << 13 } else { 0 };
    }
    pub fn general_detect(&self) -> bool {
        self.dr7 & (1 << 13) != 0
    }
    pub fn enter(&mut self) {
        self.dr7 &= !(1 << 13);
    }
    pub fn read(&self, register: u8) -> u64 {
        match register {
            0..=3 => self.addresses[register as usize],
            6 => self.dr6,
            7 => self.dr7,
            _ => unreachable!("admitted debug register"),
        }
    }
    pub fn write(&mut self, register: u8, value: u64) {
        match register {
            0..=3 => self.addresses[register as usize] = value,
            6 => self.dr6 = value,
            7 => self.dr7 = value,
            _ => unreachable!("admitted debug register"),
        }
        self.normalize();
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Execute(u8),
    GeneralDetect,
    Data {
        slots: u8,
        single_step: bool,
        completed: bool,
        origin: Option<u64>,
    },
}
impl Source {
    pub fn fault(self) -> bool {
        matches!(self, Self::Execute(_) | Self::GeneralDetect)
    }
    pub fn json(self) -> serde_json::Value {
        match self {
            Self::Execute(slots) => {
                serde_json::json!({"class":"fault", "cause":"execution-breakpoint", "breakpoints":slots})
            }
            Self::GeneralDetect => serde_json::json!({"class":"fault", "cause":"general-detect"}),
            Self::Data {
                slots,
                single_step,
                completed,
                origin,
            } => {
                let mut value = serde_json::json!({"class":"trap", "cause":"data-breakpoint", "breakpoints":slots,"singleStep":single_step,"instructionCompleted":completed});
                if let Some(pc) = origin {
                    value["deferredOriginPc"] = serde_json::json!(format!("0x{pc:x}"));
                }
                value
            }
        }
    }
}

#[cfg(test)]
mod tests;
