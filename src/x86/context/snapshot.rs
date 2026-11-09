use super::*;
use serde_json::{Value, json};

const INVALID: &str = "invalid execution context";
const EXTRA: [&str; 8] = [
    "selector",
    "dpl",
    "present",
    "conforming",
    "accessed",
    "long",
    "granularity",
    "available",
];

fn number(value: &Value, maximum: u64) -> Result<u64, &'static str> {
    value.as_u64().filter(|n| *n <= maximum).ok_or(INVALID)
}

fn boolean(value: &Value) -> Result<bool, &'static str> {
    value.as_bool().ok_or(INVALID)
}

fn address(value: &Value) -> Result<u64, &'static str> {
    value
        .as_str()
        .and_then(|s| s.strip_prefix("0x"))
        .and_then(|s| u64::from_str_radix(s, 16).ok())
        .ok_or(INVALID)
}

fn system_base(value: &Value, mode: Mode) -> Result<u64, &'static str> {
    let base = address(value)?;
    if !matches!(mode, Mode::Compatibility | Mode::Long64) && base > u64::from(u32::MAX) {
        return Err(INVALID);
    }
    Ok(base)
}

fn cache(value: &Value, mode: Mode, segment: Segment) -> Result<LoadedSegment, &'static str> {
    let kind = match value["type"].as_str() {
        Some("code") => SegmentType::Code,
        Some("readable-code") => SegmentType::ReadableCode,
        Some("read-only") => SegmentType::ReadOnly,
        Some("read-write") => SegmentType::ReadWrite,
        Some("expand-down-read-only") => SegmentType::ExpandDownReadOnly,
        Some("expand-down-read-write") => SegmentType::ExpandDownReadWrite,
        _ => return Err(INVALID),
    };
    let base = address(&value["base"])?;
    if mode != Mode::Long64 && base > u64::from(u32::MAX)
        || mode == Mode::Long64
            && matches!(segment, Segment::Fs | Segment::Gs)
            && !canonical48(base)
    {
        return Err(INVALID);
    }
    Ok(LoadedSegment {
        base,
        kind,
        limit: number(&value["limit"], u64::from(u32::MAX))? as u32,
        default32: boolean(&value["default32"])?,
        usable: boolean(&value["usable"])?,
    })
}

fn attributes(value: &Value) -> Result<SegmentAttributes, &'static str> {
    Ok(SegmentAttributes {
        dpl: number(&value["dpl"], 3)? as u8,
        present: boolean(&value["present"])?,
        conforming: boolean(&value["conforming"])?,
        accessed: boolean(&value["accessed"])?,
        long: boolean(&value["long"])?,
        granularity: boolean(&value["granularity"])?,
        available: boolean(&value["available"])?,
    })
}

fn table(value: &Value, mode: Mode) -> Result<TableRegister, &'static str> {
    Ok(TableRegister {
        base: system_base(&value["base"], mode)?,
        limit: number(&value["limit"], u64::from(u16::MAX))? as u16,
    })
}

impl ExecutionContext {
    pub fn from_json(value: &Value) -> Result<Self, &'static str> {
        let mode = match value["mode"].as_str() {
            Some("long64") => Mode::Long64,
            Some("real") => Mode::Real,
            Some("virtual8086") => Mode::Virtual8086,
            Some("protected") => Mode::Protected,
            Some("compatibility") => Mode::Compatibility,
            _ => return Err(INVALID),
        };
        let full = ["cpl", "gdtr", "idtr", "ldtr"]
            .iter()
            .any(|key| value.get(*key).is_some())
            || mode == Mode::Long64 && value.get("segments").is_some()
            || Segment::ALL.iter().any(|segment| {
                EXTRA
                    .iter()
                    .any(|key| value["segments"][segment.name()].get(*key).is_some())
            });
        let mut context = Self {
            mode,
            ..Self::default()
        };
        context.cpl = if mode == Mode::Virtual8086 { 3 } else { 0 };
        if full {
            if value.get("fsBase").is_some() || value.get("gsBase").is_some() {
                return Err(INVALID);
            }
            context.cpl = number(&value["cpl"], 3)? as u8;
            if mode == Mode::Real && context.cpl != 0
                || mode == Mode::Virtual8086 && context.cpl != 3
            {
                return Err(INVALID);
            }
            context.gdtr = table(&value["gdtr"], mode)?;
            context.idtr = table(&value["idtr"], mode)?;
            let ldtr = &value["ldtr"];
            context.ldtr = LdtRegister {
                selector: number(&ldtr["selector"], u64::from(u16::MAX))? as u16,
                valid: boolean(&ldtr["valid"])?,
                base: system_base(&ldtr["base"], mode)?,
                limit: number(&ldtr["limit"], u64::from(u32::MAX))? as u32,
                attributes: number(&ldtr["attributes"], 0xfff)? as u16,
            };
        } else if mode == Mode::Long64 {
            for (segment, key) in [(Segment::Fs, "fsBase"), (Segment::Gs, "gsBase")] {
                let base = address(&value[key])?;
                if !canonical48(base) {
                    return Err(INVALID);
                }
                context.segments[segment as usize].base = base;
            }
            return Ok(context);
        }
        for segment in Segment::ALL {
            let input = &value["segments"][segment.name()];
            let loaded = cache(input, mode, segment)?;
            let index = segment as usize;
            context.segments[index] = loaded;
            if full {
                context.selectors[index] = number(&input["selector"], u64::from(u16::MAX))? as u16;
                context.attributes[index] = attributes(input)?;
            } else {
                context.selectors[index] = match mode {
                    Mode::Real => 0,
                    Mode::Virtual8086 => (loaded.base >> 4) as u16,
                    _ => context.selectors[index],
                };
                context.attributes[index] = SegmentAttributes {
                    dpl: context.cpl,
                    present: loaded.usable,
                    accessed: loaded.usable,
                    granularity: loaded.limit > 0xfffff,
                    ..SegmentAttributes::default()
                };
            }
        }
        let cs = context.segment(Segment::Cs);
        let ss = context.segment(Segment::Ss);
        if mode == Mode::Virtual8086 {
            for segment in Segment::ALL {
                let s = context.segment(segment);
                if !s.usable
                    || s.kind != SegmentType::ReadWrite
                    || s.base > 0xffff0
                    || s.base & 15 != 0
                    || s.limit != 0xffff
                    || s.default32
                    || context.selector(segment) != (s.base >> 4) as u16
                {
                    return Err(INVALID);
                }
            }
        } else if mode != Mode::Long64
            && (!cs.usable
                || !(cs.kind.is_code() || mode == Mode::Real && cs.kind == SegmentType::ReadWrite)
                || !ss.usable
                || !ss.kind.writable())
        {
            return Err(INVALID);
        }
        Ok(context)
    }

    pub fn to_json(&self) -> Value {
        let mut segments = serde_json::Map::new();
        for segment in Segment::ALL {
            let s = self.segment(segment);
            let a = self.attributes(segment);
            segments.insert(
                segment.name().into(),
                json!({
                    "base":format!("0x{:x}",s.base),"limit":s.limit,"default32":s.default32,
                    "usable":s.usable,"type":s.kind.name(),"selector":self.selector(segment),
                    "dpl":a.dpl,"present":a.present,"conforming":a.conforming,"accessed":a.accessed,
                    "long":a.long,"granularity":a.granularity,"available":a.available,
                }),
            );
        }
        let root =
            |table: TableRegister| json!({"base":format!("0x{:x}",table.base),"limit":table.limit});
        json!({"mode":match self.mode {
            Mode::Real=>"real",Mode::Virtual8086=>"virtual8086",Mode::Protected=>"protected",
            Mode::Compatibility=>"compatibility",Mode::Long64=>"long64",
        },"cpl":self.cpl,"segments":segments,"gdtr":root(self.gdtr),"idtr":root(self.idtr),
        "ldtr":{"selector":self.ldtr.selector,"valid":self.ldtr.valid,
            "base":format!("0x{:x}",self.ldtr.base),"limit":self.ldtr.limit,"attributes":self.ldtr.attributes}})
    }
}
