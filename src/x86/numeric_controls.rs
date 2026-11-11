use super::instruction::Operation;
use super::{mmx, numeric_images, x87};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Family {
    X87,
    Wait,
    Mmx,
    Simd,
    Bridge,
    FxImage,
}

impl Family {
    pub fn name(self) -> &'static str {
        ["x87", "wait", "mmx", "simd", "bridge", "fx-image"][self as usize]
    }

    pub fn decode(value: u32) -> Option<Self> {
        [
            Self::X87,
            Self::Wait,
            Self::Mmx,
            Self::Simd,
            Self::Bridge,
            Self::FxImage,
        ]
        .get(value as usize)
        .copied()
    }
}

pub fn family(operation: Operation) -> Option<Family> {
    Some(match operation {
        Operation::X87(i) if i.op.kind == x87::Kind::Wait => Family::Wait,
        Operation::X87(_) => Family::X87,
        Operation::NumericImage { op, .. } => {
            if matches!(
                op.kind,
                numeric_images::Kind::SaveFx | numeric_images::Kind::RestoreFx
            ) {
                Family::FxImage
            } else {
                Family::X87
            }
        }
        Operation::Mmx { op, .. } => {
            if matches!(
                op.kind,
                mmx::Kind::FromXmm
                    | mmx::Kind::ToXmm
                    | mmx::Kind::PiToPs
                    | mmx::Kind::PiToPd
                    | mmx::Kind::PsToPi
                    | mmx::Kind::PdToPi
                    | mmx::Kind::TruncPsToPi
                    | mmx::Kind::TruncPdToPi
            ) {
                Family::Bridge
            } else {
                Family::Mmx
            }
        }
        Operation::MaskedStore { mmx, .. } => {
            if mmx {
                Family::Mmx
            } else {
                Family::Simd
            }
        }
        Operation::Vector(_) | Operation::Float(_) | Operation::Mxcsr { .. } => Family::Simd,
        _ => return None,
    })
}

/// Kind1 is #NM; 2/3 are admission #UD; 4 is numeric #UD after MXCSR publication.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fault {
    pub kind: u32,
    pub family: Family,
    pub controls: u8,
    pub instruction_pc: u64,
    pub stage: u32,
    pub raised: u32,
    pub before: u32,
    pub after: u32,
}

impl Fault {
    pub fn vector(self) -> u8 {
        if self.kind == 1 { 7 } else { 6 }
    }

    pub fn validate(self) -> Result<(), &'static str> {
        let mp = self.controls & 1 != 0;
        let em = self.controls & 2 != 0;
        let ts = self.controls & 4 != 0;
        let osfxsr = self.controls & 8 != 0;
        let valid = self.controls < 32
            && match self.kind {
                1 => match self.family {
                    Family::X87 | Family::FxImage => em || ts,
                    Family::Wait => mp && ts,
                    Family::Mmx => !em && ts,
                    Family::Simd | Family::Bridge => !em && osfxsr && ts,
                },
                2 => em && matches!(self.family, Family::Mmx | Family::Simd | Family::Bridge),
                3 => !em && !osfxsr && matches!(self.family, Family::Simd | Family::Bridge),
                4 => {
                    self.controls & 30 == 8
                        && matches!(self.family, Family::Simd | Family::Bridge)
                        && matches!(self.stage, 1 | 2)
                        && self.raised != 0
                        && self.raised <= 63
                        && self.before <= 0xffff
                        && self.after == self.before | self.raised
                        && self.raised & !(self.before >> 7) & 63 != 0
                }
                _ => false,
            };
        if !valid || self.kind != 4 && (self.stage | self.raised | self.before | self.after) != 0 {
            Err("invalid numeric control source")
        } else {
            Ok(())
        }
    }

    pub fn json(self) -> serde_json::Value {
        let mut value = serde_json::json!({
            "vector":self.vector(), "instructionPc":format!("0x{:x}",self.instruction_pc), "family":self.family.name(),
            "controls": { "mp":self.controls&1!=0, "em":self.controls&2!=0, "ts":self.controls&4!=0, "osfxsr":self.controls&8!=0, "osxmmexcpt":self.controls&16!=0 }
        });
        if self.kind != 1 {
            value["phase"] = serde_json::json!(if self.kind == 4 {
                "numeric"
            } else {
                "admission"
            });
            value["cause"] = serde_json::json!(match self.kind {
                2 => "em",
                3 => "osfxsr",
                _ => "osxmmexcpt",
            });
        }
        if self.kind == 4 {
            value["stage"] = serde_json::json!(if self.stage == 1 {
                "pre-computation"
            } else {
                "post-computation"
            });
            value["raised"] = serde_json::json!(self.raised);
            value["unmasked"] = serde_json::json!(self.raised & !(self.before >> 7) & 63);
            value["mxcsrBefore"] = serde_json::json!(self.before);
            value["mxcsrAfter"] = serde_json::json!(self.after);
        }
        value
    }
}

pub fn admission(operation: Operation, controls: u8, pc: u64) -> Option<Fault> {
    let family = family(operation)?;
    let em = controls & 2 != 0;
    let ts = controls & 4 != 0;
    let osfxsr = controls & 8 != 0;
    let kind = match family {
        Family::X87 | Family::FxImage if em || ts => 1,
        Family::Wait if controls & 1 != 0 && ts => 1,
        Family::Mmx | Family::Simd | Family::Bridge if em => 2,
        Family::Simd | Family::Bridge if !osfxsr => 3,
        Family::Mmx | Family::Simd | Family::Bridge if ts => 1,
        _ => return None,
    };
    Some(Fault {
        kind,
        family,
        controls,
        instruction_pc: pc,
        stage: 0,
        raised: 0,
        before: 0,
        after: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::x86::decode::{self, DecodeError};

    #[test]
    fn decoded_forms_follow_all_32_independent_enable_truth_tables() {
        for (bytes, expected_family, expected) in [
            (&[0xd9, 0xe8][..], Family::X87, [24, 0, 8]),
            (&[0x9b][..], Family::Wait, [8, 0, 24]),
            (&[0x0f, 0xef, 0xc0][..], Family::Mmx, [8, 16, 8]),
            (&[0x66, 0x0f, 0xef, 0xc0][..], Family::Simd, [4, 24, 4]),
            (&[0xf3, 0x0f, 0xd6, 0xc1][..], Family::Bridge, [4, 24, 4]),
            (&[0x0f, 0xae, 0x00][..], Family::FxImage, [24, 0, 8]),
        ] {
            let op = decode::decode_with_context(0, &Default::default(), |pc| {
                bytes
                    .get(pc as usize)
                    .copied()
                    .ok_or(DecodeError::Unsupported)
            })
            .unwrap()
            .operation;
            assert_eq!(family(op), Some(expected_family));
            let mut counts = [0; 3];
            for controls in 0..32 {
                let fault = admission(op, controls, 0x1000);
                counts[match fault {
                    None => 2,
                    Some(f) if f.kind == 1 => 0,
                    _ => 1,
                }] += 1;
                if let Some(fault) = fault {
                    assert_eq!(fault.validate(), Ok(()));
                }
            }
            assert_eq!(counts, expected, "{bytes:x?}");
        }
        for bytes in [&[0x90][..], &[0x0f, 0xae, 0xf8], &[0x0f, 0xc3, 0x00]] {
            let op = decode::decode_with_context(0, &Default::default(), |pc| {
                bytes
                    .get(pc as usize)
                    .copied()
                    .ok_or(DecodeError::Unsupported)
            })
            .unwrap()
            .operation;
            for controls in 0..32 {
                assert_eq!(admission(op, controls, 0), None);
            }
        }
    }
}
