use super::instruction::Width;
use crate::memory::{Access, Cause, Fault, Image, canonical48};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum Segment {
    Cs,
    Ss,
    Ds,
    Es,
    Fs,
    Gs,
}

impl Segment {
    pub const ALL: [Self; 6] = [Self::Cs, Self::Ss, Self::Ds, Self::Es, Self::Fs, Self::Gs];
    pub fn name(self) -> &'static str {
        match self {
            Self::Cs => "cs",
            Self::Ss => "ss",
            Self::Ds => "ds",
            Self::Es => "es",
            Self::Fs => "fs",
            Self::Gs => "gs",
        }
    }
    pub fn from_id(id: u32) -> Self {
        Self::ALL[id as usize]
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Long64,
    Real,
    Virtual8086,
    Protected,
    Compatibility,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SegmentType {
    Code,
    ReadableCode,
    ReadOnly,
    ReadWrite,
    ExpandDownReadOnly,
    ExpandDownReadWrite,
}

impl SegmentType {
    fn is_code(self) -> bool {
        matches!(self, Self::Code | Self::ReadableCode)
    }
    fn writable(self) -> bool {
        matches!(self, Self::ReadWrite | Self::ExpandDownReadWrite)
    }
    fn expand_down(self) -> bool {
        matches!(self, Self::ExpandDownReadOnly | Self::ExpandDownReadWrite)
    }
    fn name(self) -> &'static str {
        match self {
            Self::Code => "code",
            Self::ReadableCode => "readable-code",
            Self::ReadOnly => "read-only",
            Self::ReadWrite => "read-write",
            Self::ExpandDownReadOnly => "expand-down-read-only",
            Self::ExpandDownReadWrite => "expand-down-read-write",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LoadedSegment {
    pub base: u64,
    pub limit: u32,
    pub default32: bool,
    pub usable: bool,
    pub kind: SegmentType,
}

impl Default for LoadedSegment {
    fn default() -> Self {
        Self {
            base: 0,
            limit: u32::MAX,
            default32: true,
            usable: true,
            kind: SegmentType::ReadWrite,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SegmentAttributes {
    pub dpl: u8,
    pub present: bool,
    pub conforming: bool,
    pub accessed: bool,
    pub long: bool,
    pub granularity: bool,
    pub available: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TableRegister {
    pub base: u64,
    pub limit: u16,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LdtRegister {
    pub selector: u16,
    pub valid: bool,
    pub base: u64,
    pub limit: u32,
    pub attributes: u16,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecutionContext {
    mode: Mode,
    segments: [LoadedSegment; 6],
    cpl: u8,
    selectors: [u16; 6],
    attributes: [SegmentAttributes; 6],
    gdtr: TableRegister,
    idtr: TableRegister,
    ldtr: LdtRegister,
}

impl Default for ExecutionContext {
    fn default() -> Self {
        let mut context = Self {
            mode: Mode::Long64,
            segments: [LoadedSegment::default(); 6],
            cpl: 0,
            selectors: [8, 16, 24, 24, 24, 24],
            attributes: [SegmentAttributes {
                present: true,
                accessed: true,
                granularity: true,
                ..SegmentAttributes::default()
            }; 6],
            gdtr: TableRegister::default(),
            idtr: TableRegister::default(),
            ldtr: LdtRegister::default(),
        };
        context.segments[Segment::Cs as usize].kind = SegmentType::ReadableCode;
        context.segments[Segment::Cs as usize].default32 = false;
        context.attributes[Segment::Cs as usize].long = true;
        context
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SegmentCause {
    Unusable,
    Type,
    Limit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SegmentFault {
    pub segment: Segment,
    pub offset: u64,
    pub width: u32,
    pub access: Access,
    pub cause: SegmentCause,
    pub failing: u128,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccessFailure {
    Segment(SegmentFault),
    Linear(Fault),
}

impl ExecutionContext {
    pub fn is_long64(&self) -> bool {
        self.mode == Mode::Long64
    }
    pub fn mode(&self) -> Mode {
        self.mode
    }
    pub fn cpl(&self) -> u8 {
        self.cpl
    }
    pub fn selector(&self, segment: Segment) -> u16 {
        self.selectors[segment as usize]
    }
    pub fn attributes(&self, segment: Segment) -> SegmentAttributes {
        self.attributes[segment as usize]
    }
    pub fn gdtr(&self) -> TableRegister {
        self.gdtr
    }
    pub fn idtr(&self) -> TableRegister {
        self.idtr
    }
    pub fn ldtr(&self) -> LdtRegister {
        self.ldtr
    }
    pub fn set_segment(
        &mut self,
        segment: Segment,
        selector: u16,
        cache: LoadedSegment,
        attributes: SegmentAttributes,
    ) -> bool {
        let index = segment as usize;
        let changed = self.selectors[index] != selector
            || self.segments[index] != cache
            || self.attributes[index] != attributes;
        self.selectors[index] = selector;
        self.segments[index] = cache;
        self.attributes[index] = attributes;
        changed
    }
    pub fn set_gdtr(&mut self, table: TableRegister) -> bool {
        let changed = self.gdtr != table;
        self.gdtr = table;
        changed
    }
    pub fn set_idtr(&mut self, table: TableRegister) -> bool {
        let changed = self.idtr != table;
        self.idtr = table;
        changed
    }
    pub fn set_ldtr(&mut self, table: LdtRegister) -> bool {
        let changed = self.ldtr != table;
        self.ldtr = table;
        changed
    }
    pub fn code32(&self) -> bool {
        self.segments[Segment::Cs as usize].default32
    }
    pub fn stack_width(&self) -> Width {
        if self.is_long64() {
            Width::W64
        } else if self.segments[Segment::Ss as usize].default32 {
            Width::W32
        } else {
            Width::W16
        }
    }
    pub fn segment(&self, segment: Segment) -> LoadedSegment {
        self.segments[segment as usize]
    }
    pub fn segment_base(&self, segment: Segment) -> u64 {
        if self.is_long64() && !matches!(segment, Segment::Fs | Segment::Gs) {
            0
        } else {
            self.segment(segment).base
        }
    }
    pub fn code_limit(&self) -> u64 {
        if self.is_long64() {
            u64::MAX
        } else {
            u64::from(self.segment(Segment::Cs).limit)
        }
    }

    pub fn translate(
        &self,
        offset: u64,
        width: u32,
        segment: Segment,
        access: Access,
        rmw: bool,
    ) -> Result<u64, AccessFailure> {
        if self.is_long64() {
            let address = self.segment_base(segment).wrapping_add(offset);
            crate::memory::check_span(address, width, access).map_err(AccessFailure::Linear)?;
            return Ok(address);
        }
        let loaded = self.segment(segment);
        if width != 0 {
            let failure = |cause, failing| {
                AccessFailure::Segment(SegmentFault {
                    segment,
                    offset,
                    width,
                    access,
                    cause,
                    failing,
                })
            };
            if !loaded.usable {
                return Err(failure(SegmentCause::Unusable, u128::from(offset)));
            }
            let readable = loaded.kind != SegmentType::Code;
            let writable =
                loaded.kind.writable() || self.mode == Mode::Real && loaded.kind.is_code();
            let permitted = match access {
                Access::Execute => segment == Segment::Cs,
                Access::Read => readable,
                Access::Write => writable && (!rmw || readable),
            };
            if !permitted {
                return Err(failure(SegmentCause::Type, u128::from(offset)));
            }
            let first = u128::from(offset);
            let last = first + u128::from(width) - 1;
            let upper = u128::from(loaded.limit);
            if loaded.kind.expand_down() {
                let upper = if loaded.default32 {
                    u128::from(u32::MAX)
                } else {
                    0xffff
                };
                if first <= u128::from(loaded.limit) || first > upper {
                    return Err(failure(SegmentCause::Limit, first));
                }
                if last > upper {
                    return Err(failure(SegmentCause::Limit, upper + 1));
                }
            } else if last > upper {
                return Err(failure(
                    SegmentCause::Limit,
                    if first > upper { first } else { upper + 1 },
                ));
            }
        }
        let address = u64::from(loaded.base.wrapping_add(offset) as u32);
        if u128::from(address) + u128::from(width) > 1u128 << 32 {
            return Err(AccessFailure::Linear(Fault {
                address,
                width,
                access,
                cause: Cause::AddressRange,
                failing: 1u128 << 32,
            }));
        }
        Ok(address)
    }

    pub fn translate_clflush(&self, offset: u64, segment: Segment) -> Result<u64, AccessFailure> {
        if self.is_long64() || self.segment(segment).kind != SegmentType::Code {
            return self.translate(offset, 1, segment, Access::Read, false);
        }
        // Keep the type exception local; ordinary read translation is unchanged.
        let mut readable = self.clone();
        readable.segments[segment as usize].kind = SegmentType::ReadableCode;
        readable.translate(offset, 1, segment, Access::Read, false)
    }

    pub fn fetch(&self, image: &Image, offset: u64) -> Result<u8, AccessFailure> {
        let address = self.translate(offset, 1, Segment::Cs, Access::Execute, false)?;
        image.fetch(address).map_err(AccessFailure::Linear)
    }

    pub fn check_target(&self, target: u64) -> Result<(), AccessFailure> {
        if self.is_long64() {
            if canonical48(target) {
                Ok(())
            } else {
                Err(AccessFailure::Linear(Fault {
                    address: target,
                    width: 0,
                    access: Access::Execute,
                    cause: Cause::Noncanonical,
                    failing: u128::from(target),
                }))
            }
        } else {
            self.translate(target, 1, Segment::Cs, Access::Execute, false)
                .map(|_| ())
        }
    }
}

mod snapshot;

#[cfg(test)]
mod tests;
