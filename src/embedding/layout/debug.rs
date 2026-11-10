// Private debug-finish control result, never a public run exit.
pub const CONTINUE_ACTIVE: i32 = -1;

use crate::x86::debug::{Source, State};
use std::mem::{offset_of, size_of};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[repr(C)]
pub struct DebugSource {
    pub kind: u32,
    pub slots: u32,
    pub single_step: u32,
    pub completed: u32,
    pub origin: u64,
    pub has_origin: u32,
    pub reserved: u32,
}
impl DebugSource {
    pub fn decode(self) -> Result<Option<Source>, &'static str> {
        if self == Self::default() {
            return Ok(None);
        }
        if self.reserved != 0 || self.has_origin > 1 || self.has_origin == 0 && self.origin != 0 {
            return Err("invalid debug source transport");
        }
        let slots = self.slots;
        let source = match self.kind {
            1 if (1..=15).contains(&slots)
                && self.single_step == 0
                && self.completed == 0
                && self.has_origin == 0 =>
            {
                Source::Execute(slots as u8)
            }
            2 if slots == 0
                && self.single_step == 0
                && self.completed == 0
                && self.has_origin == 0 =>
            {
                Source::GeneralDetect
            }
            3 if (1..=15).contains(&slots) && self.single_step <= 1 && self.completed <= 1 => {
                Source::Data {
                    slots: slots as u8,
                    single_step: self.single_step != 0,
                    completed: self.completed != 0,
                    origin: (self.has_origin != 0).then_some(self.origin),
                }
            }
            _ => return Err("invalid debug source transport"),
        };
        Ok(Some(source))
    }
    pub fn encode(source: Option<Source>) -> Self {
        match source {
            None => Self::default(),
            Some(Source::Execute(slots)) => Self {
                kind: 1,
                slots: slots.into(),
                ..Self::default()
            },
            Some(Source::GeneralDetect) => Self {
                kind: 2,
                ..Self::default()
            },
            Some(Source::Data {
                slots,
                single_step,
                completed,
                origin,
            }) => Self {
                kind: 3,
                slots: slots.into(),
                single_step: single_step.into(),
                completed: completed.into(),
                origin: origin.unwrap_or(0),
                has_origin: origin.is_some().into(),
                reserved: 0,
            },
        }
    }
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, &'static str> {
        if bytes.len() != size_of::<Self>() {
            return Err("debug source input length differs");
        }
        let word = |offset| u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
        let source = Self {
            kind: word(offset_of!(Self, kind)),
            slots: word(offset_of!(Self, slots)),
            single_step: word(offset_of!(Self, single_step)),
            completed: word(offset_of!(Self, completed)),
            origin: u64::from_le_bytes(
                bytes[offset_of!(Self, origin)..offset_of!(Self, origin) + 8]
                    .try_into()
                    .unwrap(),
            ),
            has_origin: word(offset_of!(Self, has_origin)),
            reserved: word(offset_of!(Self, reserved)),
        };
        source.decode()?;
        Ok(source)
    }
    pub fn descriptor() -> serde_json::Value {
        serde_json::json!({"bytes":size_of::<Self>(),"kind":offset_of!(Self,kind),"slots":offset_of!(Self,slots),"singleStep":offset_of!(Self,single_step),"completed":offset_of!(Self,completed),"origin":offset_of!(Self,origin),"hasOrigin":offset_of!(Self,has_origin),"reserved":offset_of!(Self,reserved)})
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[repr(C)]
pub struct Continuation {
    pub slots: u32,
    pub reserved: u32,
    pub origin: u64,
}
impl Continuation {
    pub fn validate(self, shadow: u32, ready: bool) -> Result<(), &'static str> {
        if self == Self::default()
            || self.slots <= 15 && self.slots != 0 && self.reserved == 0 && shadow == 2 && ready
        {
            Ok(())
        } else {
            Err("invalid deferred debug continuation")
        }
    }
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, &'static str> {
        if bytes.len() != size_of::<Self>() {
            return Err("debug continuation input length differs");
        }
        Ok(Self {
            slots: u32::from_le_bytes(
                bytes[offset_of!(Self, slots)..offset_of!(Self, slots) + 4]
                    .try_into()
                    .unwrap(),
            ),
            reserved: u32::from_le_bytes(
                bytes[offset_of!(Self, reserved)..offset_of!(Self, reserved) + 4]
                    .try_into()
                    .unwrap(),
            ),
            origin: u64::from_le_bytes(
                bytes[offset_of!(Self, origin)..offset_of!(Self, origin) + 8]
                    .try_into()
                    .unwrap(),
            ),
        })
    }
    pub fn descriptor() -> serde_json::Value {
        serde_json::json!({"bytes":size_of::<Self>(),"slots":offset_of!(Self,slots),"origin":offset_of!(Self,origin),"reserved":offset_of!(Self,reserved)})
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[repr(C)]
pub struct DebugState {
    pub registers: State,
    pub source: DebugSource,
    pub continuation: Continuation,
}
impl DebugState {
    pub fn descriptor() -> serde_json::Value {
        serde_json::json!({"bytes":size_of::<Self>(),"addresses":offset_of!(Self,registers)+offset_of!(State,addresses),"dr6":offset_of!(Self,registers)+offset_of!(State,dr6),"dr7":offset_of!(Self,registers)+offset_of!(State,dr7),"sourceOffset":offset_of!(Self,source),"source":DebugSource::descriptor(),"continuationOffset":offset_of!(Self,continuation),"continuation":Continuation::descriptor()})
    }
}
