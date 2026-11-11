use crate::x86::exception::EventState;
use crate::x86::numeric_controls::{Family, Fault};
use std::mem::{offset_of, size_of};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[repr(C)]
pub struct RawNumericSource {
    pub kind: u32,
    pub family: u32,
    pub controls: u32,
    pub stage: u32,
    pub raised: u32,
    pub before: u32,
    pub after: u32,
    pub reserved: u32,
    pub instruction_pc: u64,
}

impl RawNumericSource {
    pub fn decode(self) -> Result<Option<Fault>, &'static str> {
        if self.kind == 0 {
            return if self == Self::default() {
                Ok(None)
            } else {
                Err("nonzero absent numeric source")
            };
        }
        if self.reserved != 0 || self.controls > 31 {
            return Err("invalid numeric source transport");
        }
        let fault = Fault {
            kind: self.kind,
            family: Family::decode(self.family).ok_or("invalid numeric family")?,
            controls: self.controls as u8,
            stage: self.stage,
            raised: self.raised,
            before: self.before,
            after: self.after,
            instruction_pc: self.instruction_pc,
        };
        fault.validate()?;
        Ok(Some(fault))
    }

    pub fn encode(fault: Option<Fault>) -> Self {
        fault.map_or_else(Self::default, |f| Self {
            kind: f.kind,
            family: f.family as u32,
            controls: f.controls.into(),
            stage: f.stage,
            raised: f.raised,
            before: f.before,
            after: f.after,
            reserved: 0,
            instruction_pc: f.instruction_pc,
        })
    }

    pub fn attach(self, event: &mut EventState) -> Result<(), &'static str> {
        if let Some(fault) = self.decode()? {
            let EventState::Pending(pending) = event else {
                return Err("numeric source requires pending fault");
            };
            if fault.vector() != pending.vector
                || fault.instruction_pc != pending.instruction_pc
                || pending.instruction_pc != pending.return_pc
                || pending.debug.is_some()
                || pending.page_fault_address.is_some()
            {
                return Err("numeric source differs from pending event");
            }
            pending.numeric = Some(fault);
        }
        Ok(())
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, &'static str> {
        if bytes.len() != size_of::<Self>() {
            return Err("numeric source input length differs");
        }
        let word = |i| u32::from_le_bytes(bytes[i..i + 4].try_into().unwrap());
        let raw = Self {
            kind: word(0),
            family: word(4),
            controls: word(8),
            stage: word(12),
            raised: word(16),
            before: word(20),
            after: word(24),
            reserved: word(28),
            instruction_pc: u64::from_le_bytes(bytes[32..40].try_into().unwrap()),
        };
        raw.decode()?;
        Ok(raw)
    }

    pub fn descriptor() -> serde_json::Value {
        serde_json::json!({"bytes":size_of::<Self>(),"kind":offset_of!(Self,kind),"family":offset_of!(Self,family),"controls":offset_of!(Self,controls),"stage":offset_of!(Self,stage),"raised":offset_of!(Self,raised),"before":offset_of!(Self,before),"after":offset_of!(Self,after),"reserved":offset_of!(Self,reserved),"instructionPc":offset_of!(Self,instruction_pc)})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::x86::{context::ExecutionContext, exception::ExceptionEvent};
    #[test]
    fn typed_source_roundtrip_is_intrinsic_and_secondary_fault_drops_it() {
        let source = Fault {
            kind: 1,
            family: Family::X87,
            controls: 31,
            instruction_pc: 0x1000,
            stage: 0,
            raised: 0,
            before: 0,
            after: 0,
        };
        let raw = RawNumericSource::encode(Some(source));
        assert_eq!(raw.decode(), Ok(Some(source)));
        let mut event = EventState::Pending(ExceptionEvent::fault(
            7,
            0x1000,
            2,
            &ExecutionContext::default(),
            None,
        ));
        raw.attach(&mut event).unwrap();
        event
            .validate(
                0x1000,
                2,
                &ExecutionContext::default(),
                0,
                Default::default(),
            )
            .unwrap();
        let EventState::Pending(pending) = event else {
            unreachable!()
        };
        let EventState::Pending(next) = pending.escalate(13, 0) else {
            panic!("#NM is benign")
        };
        assert_eq!(next.vector, 13);
        assert_eq!(next.numeric, None);
        for malformed in [
            RawNumericSource { reserved: 1, ..raw },
            RawNumericSource {
                controls: 32,
                ..raw
            },
            RawNumericSource { kind: 0, ..raw },
            RawNumericSource { stage: 1, ..raw },
        ] {
            assert!(malformed.decode().is_err());
        }
    }
}
