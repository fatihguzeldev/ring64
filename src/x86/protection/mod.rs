use super::context::{AccessFailure, ExecutionContext, Mode, Segment, TableRegister};
use super::instruction::{ProtectionDescriptor, ProtectionKind, Width};
use crate::memory::{Access, Cause, Image};

mod access;
mod descriptor;
pub mod far;
mod reload;
mod task;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod load_tests;

#[cfg(test)]
mod boundary_tests;

#[cfg(test)]
mod review_tests;

#[cfg(test)]
mod ss_tests;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProtectionPhase {
    Privilege,
    Selector,
    Descriptor,
    Target,
}

impl ProtectionPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Privilege => "privilege",
            Self::Selector => "selector",
            Self::Descriptor => "descriptor",
            Self::Target => "target",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProtectionFault {
    pub vector: u8,
    pub error_code: u16,
    pub phase: ProtectionPhase,
    pub selector: Option<u16>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Table {
    Gdt,
    Ldt,
    Ivt,
    Idt,
    Tss,
}

impl Table {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Gdt => "gdt",
            Self::Ldt => "ldt",
            Self::Ivt => "ivt",
            Self::Idt => "idt",
            Self::Tss => "tss",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SystemPhase {
    DescriptorRead,
    AccessedWrite,
    BusyWrite,
    GateRead,
    TssRead,
}

impl SystemPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DescriptorRead => "descriptor-read",
            Self::AccessedWrite => "descriptor-accessed-write",
            Self::BusyWrite => "descriptor-busy-write",
            Self::GateRead => "gate-read",
            Self::TssRead => "tss-read",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SystemReference {
    Selector(u16),
    Vector(u8),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SystemMemoryFault {
    pub address: u128,
    pub width: u32,
    pub access: Access,
    pub cause: Cause,
    pub failing_address: u128,
    pub phase: SystemPhase,
    pub table: Table,
    pub reference: SystemReference,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    Operand(AccessFailure),
    Protection(ProtectionFault),
    SystemMemory(SystemMemoryFault),
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Outcome {
    pub value: Option<u64>,
    pub zero: Option<bool>,
    pub context_changed: bool,
}

pub fn valid_in_mode(descriptor: ProtectionDescriptor, context: &ExecutionContext) -> bool {
    use ProtectionKind::*;
    let ProtectionDescriptor {
        kind,
        width,
        memory,
    } = descriptor;
    if width == Width::W8 || width == Width::W64 && !context.is_long64() {
        return false;
    }
    if matches!(
        kind,
        ReadLdt | LoadLdt | ReadTask | LoadTask | Lar | Lsl | Verr | Verw
    ) && matches!(context.mode(), Mode::Real | Mode::Virtual8086)
    {
        return false;
    }
    match kind {
        StoreGdt | StoreIdt | LoadGdt | LoadIdt => memory,
        ReadLdt | ReadTask | ReadSegment(_) => !memory || width == Width::W16,
        LoadLdt | LoadTask | Verr | Verw => width == Width::W16,
        LoadSegment(segment) => width == Width::W16 && segment != Segment::Cs,
        LoadFar(segment) => {
            memory
                && segment != Segment::Cs
                && !(context.is_long64() && matches!(segment, Segment::Ds | Segment::Es))
        }
        Lar | Lsl => true,
    }
}

pub fn execute(
    context: &mut ExecutionContext,
    image: &mut Image,
    descriptor: ProtectionDescriptor,
    offset: u64,
    input: u64,
    operand_segment: Segment,
) -> Result<Outcome, Failure> {
    use ProtectionKind::*;
    let ProtectionDescriptor {
        kind,
        width,
        memory,
    } = descriptor;
    if matches!(kind, LoadGdt | LoadIdt | LoadLdt | LoadTask) && context.cpl() != 0 {
        return Err(Failure::Protection(ProtectionFault {
            vector: 13,
            error_code: 0,
            phase: ProtectionPhase::Privilege,
            selector: None,
        }));
    }
    let value = |value| Outcome {
        value: Some(value),
        ..Outcome::default()
    };
    match kind {
        StoreGdt | StoreIdt => {
            let table = if kind == StoreGdt {
                context.gdtr()
            } else {
                context.idtr()
            };
            let mut bytes = [0; 10];
            bytes[..2].copy_from_slice(&table.limit.to_le_bytes());
            bytes[2..].copy_from_slice(&table.base.to_le_bytes());
            let length = if context.is_long64() { 10 } else { 6 };
            access::write_operand(context, image, offset, &bytes[..length], operand_segment)?;
            Ok(Outcome::default())
        }
        LoadGdt | LoadIdt => {
            let bytes = access::read_operand(
                context,
                image,
                offset,
                if context.is_long64() { 10 } else { 6 },
                operand_segment,
            )?;
            let mut base = u64::from_le_bytes(bytes[2..].try_into().unwrap());
            if !context.is_long64() && width == Width::W16 {
                base &= 0xffffff;
            }
            if context.is_long64() && !crate::memory::canonical48(base) {
                return Err(Failure::Protection(ProtectionFault {
                    vector: 13,
                    error_code: 0,
                    phase: ProtectionPhase::Descriptor,
                    selector: None,
                }));
            }
            let table = TableRegister {
                base,
                limit: u16::from_le_bytes(bytes[..2].try_into().unwrap()),
            };
            let changed = if kind == LoadGdt {
                context.set_gdtr(table)
            } else {
                context.set_idtr(table)
            };
            Ok(Outcome {
                context_changed: changed,
                ..Outcome::default()
            })
        }
        ReadLdt | ReadTask | ReadSegment(_) => {
            let selector = match kind {
                ReadSegment(segment) => context.selector(segment),
                ReadTask => context.tr().selector,
                _ => context.ldtr().selector,
            };
            if memory {
                access::write_operand(
                    context,
                    image,
                    offset,
                    &selector.to_le_bytes(),
                    operand_segment,
                )?;
                Ok(Outcome::default())
            } else {
                Ok(value(u64::from(selector)))
            }
        }
        Lar | Lsl | Verr | Verw => {
            let selector = if memory {
                let bytes = access::read_operand(context, image, offset, 2, operand_segment)?;
                u16::from_le_bytes(bytes[..2].try_into().unwrap())
            } else {
                input as u16
            };
            query(context, image, kind, width, selector)
        }
        LoadLdt | LoadTask | LoadSegment(_) => {
            let selector = if memory {
                let bytes = access::read_operand(context, image, offset, 2, operand_segment)?;
                u16::from_le_bytes(bytes[..2].try_into().unwrap())
            } else {
                input as u16
            };
            let changed = match kind {
                LoadLdt => reload::ldt(context, image, selector)?,
                LoadTask => task::load(context, image, selector)?,
                LoadSegment(segment) => reload::segment(context, image, segment, selector)?,
                _ => unreachable!(),
            };
            Ok(Outcome {
                context_changed: changed,
                ..Outcome::default()
            })
        }
        LoadFar(segment) => {
            let count = usize::from(width.bytes());
            let bytes =
                access::read_operand(context, image, offset, count as u32 + 2, operand_segment)?;
            let selector = u16::from_le_bytes(bytes[count..count + 2].try_into().unwrap());
            let mut offset_bytes = [0; 8];
            offset_bytes[..count].copy_from_slice(&bytes[..count]);
            let changed = reload::segment(context, image, segment, selector)?;
            Ok(Outcome {
                value: Some(u64::from_le_bytes(offset_bytes)),
                context_changed: changed,
                zero: None,
            })
        }
    }
}

fn query(
    context: &ExecutionContext,
    image: &Image,
    kind: ProtectionKind,
    width: Width,
    selector: u16,
) -> Result<Outcome, Failure> {
    let failed = Outcome {
        zero: Some(false),
        ..Outcome::default()
    };
    if selector < 4 {
        return Ok(failed);
    }
    let Some(lookup) = access::Lookup::resolve(context, selector) else {
        return Ok(failed);
    };
    if !lookup.fits(8) {
        return Ok(failed);
    }
    let descriptor = descriptor::Descriptor::decode(lookup.read(context, image, 0)?);
    if !descriptor.query(
        kind,
        access::ia32e(context),
        context.cpl(),
        selector as u8 & 3,
    ) {
        return Ok(failed);
    }
    if kind == ProtectionKind::Lsl && access::ia32e(context) && descriptor.system() {
        if !lookup.fits(16) {
            return Ok(failed);
        }
        if (lookup.read(context, image, 8)? >> 32) & 0x1f00 != 0 {
            return Ok(failed);
        }
    }
    Ok(Outcome {
        zero: Some(true),
        value: match kind {
            ProtectionKind::Lar => Some(u64::from(descriptor.rights()) & width.mask()),
            ProtectionKind::Lsl => Some(u64::from(descriptor.limit) & width.mask()),
            _ => None,
        },
        context_changed: false,
    })
}
