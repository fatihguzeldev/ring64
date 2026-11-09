use super::access::{Lookup, ia32e};
use super::descriptor::Descriptor;
use super::{ExecutionContext, Image, ProtectionFault, ProtectionPhase};
use crate::memory::Access;
use crate::x86::context::{
    AccessFailure, LoadedSegment, Mode, Segment, SegmentAttributes, SegmentType,
};
use crate::x86::instruction::{FarDescriptor, FarKind, Width};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FarOperands {
    pub offset: u64,
    pub selector: u16,
    pub input_sp: u64,
    pub next_pc: u64,
    pub segment: Segment,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FarOutcome {
    pub pc: u64,
    pub sp: u64,
    pub context_changed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FarFailure {
    Operand {
        segment: Segment,
        failure: AccessFailure,
    },
    Protection(super::ProtectionFault),
    SystemMemory(super::SystemMemoryFault),
    Unsupported,
}

pub fn valid_in_mode(descriptor: FarDescriptor, context: &ExecutionContext) -> bool {
    descriptor.width != Width::W8
        && (descriptor.width != Width::W64 || context.is_long64())
        && if descriptor.kind == FarKind::Return {
            !descriptor.memory
        } else {
            descriptor.memory || !context.is_long64()
        }
}

pub fn execute(
    context: &mut ExecutionContext,
    image: &mut Image,
    descriptor: FarDescriptor,
    operands: FarOperands,
) -> Result<FarOutcome, FarFailure> {
    if !valid_in_mode(descriptor, context) {
        return Err(FarFailure::Unsupported);
    }
    let width = descriptor.width;
    let size = u64::from(width.bytes());
    let stack_width = context.stack_width();
    let old_sp = operands.input_sp & stack_width.mask();
    let real = matches!(context.mode(), Mode::Real | Mode::Virtual8086);
    let mut next_sp = operands.input_sp;
    let mut slots = None;
    let mut restored_stack = None;

    let (mut pc, selector) = if descriptor.kind == FarKind::Return {
        let pc = read_stack(context, image, old_sp, width)?;
        let second = step(old_sp, size, stack_width);
        let selector = read_stack(context, image, second, width)? as u16;
        next_sp = merge(
            operands.input_sp,
            step(second, size, stack_width),
            stack_width,
        );
        (pc, selector)
    } else if descriptor.memory {
        let bytes = super::access::read_operand(
            context,
            image,
            operands.offset,
            size as u32 + 2,
            operands.segment,
        )
        .map_err(|failure| operand_failure(failure, operands.segment))?;
        let mut offset = [0; 8];
        offset[..size as usize].copy_from_slice(&bytes[..size as usize]);
        (
            u64::from_le_bytes(offset),
            u16::from_le_bytes(bytes[size as usize..size as usize + 2].try_into().unwrap()),
        )
    } else {
        (operands.offset & width.mask(), operands.selector)
    };

    let code = if real {
        None
    } else {
        Some(code(context, image, descriptor.kind, selector)?)
    };
    let (mode, cpl) = match code {
        Some(code) => (
            if ia32e(context) {
                if code.descriptor.flags & 2 != 0 {
                    Mode::Long64
                } else {
                    Mode::Compatibility
                }
            } else {
                Mode::Protected
            },
            if descriptor.kind == FarKind::Return {
                selector as u8 & 3
            } else {
                context.cpl()
            },
        ),
        None => (context.mode(), context.cpl()),
    };

    if descriptor.kind == FarKind::Call {
        let first = step(old_sp, 0u64.wrapping_sub(size), stack_width);
        let second = step(first, 0u64.wrapping_sub(size), stack_width);
        let first_address = stack_geometry(context, first, size as u32, Access::Write)?;
        let second_address = stack_geometry(context, second, size as u32, Access::Write)?;
        slots = Some([
            Write {
                address: first_address,
                width: size as u32,
                value: u64::from(context.selector(Segment::Cs)),
            },
            Write {
                address: second_address,
                width: size as u32,
                value: operands.next_pc & width.mask(),
            },
        ]);
        next_sp = merge(operands.input_sp, second, stack_width);
    } else if descriptor.kind == FarKind::Return {
        let cleanup = operands.offset as u16;
        if !real && cpl > context.cpl() {
            let mut cursor = next_sp & stack_width.mask();
            if cleanup != 0 {
                stack_geometry(context, cursor, u32::from(cleanup), Access::Read)?;
                cursor = step(cursor, u64::from(cleanup), stack_width);
            }
            let restored_sp = read_stack(context, image, cursor, width)?;
            cursor = step(cursor, size, stack_width);
            let restored_ss = read_stack(context, image, cursor, width)? as u16;
            let stack = stack(context, image, mode, cpl, restored_ss)?;
            let target_width = if mode == Mode::Long64 {
                Width::W64
            } else if stack.cache.default32 {
                Width::W32
            } else {
                Width::W16
            };
            next_sp = merge(
                restored_sp,
                step(restored_sp, u64::from(cleanup), target_width),
                target_width,
            );
            restored_stack = Some(stack);
        } else {
            next_sp = merge(
                next_sp,
                step(next_sp, u64::from(cleanup), stack_width),
                stack_width,
            );
        }
    }

    let limit = code.map_or(context.segment(Segment::Cs).limit, |code| {
        code.descriptor.limit
    });
    if descriptor.kind == FarKind::Call && mode == Mode::Compatibility {
        pc &= u64::from(u32::MAX);
    }
    if mode == Mode::Long64 {
        if !crate::memory::canonical48(pc) {
            return Err(target_fault());
        }
    } else if pc > u64::from(limit)
        || real && descriptor.kind == FarKind::Call && width == Width::W32 && pc >> 16 != 0
    {
        return Err(target_fault());
    }

    let code_write = code
        .filter(|code| !code.descriptor.accessed())
        .map(|code| {
            code.lookup
                .prepare_accessed(context, image, code.descriptor.access)
                .map_err(system_failure)
        })
        .transpose()?;
    let stack_write = restored_stack
        .and_then(|stack| stack.loaded)
        .filter(|loaded| !loaded.descriptor.accessed())
        .map(|loaded| {
            loaded
                .lookup
                .prepare_accessed(context, image, loaded.descriptor.access)
                .map_err(system_failure)
        })
        .transpose()?;
    if let Some(slots) = slots {
        for slot in slots {
            image
                .check_write(slot.address, slot.width)
                .map_err(|failure| linear_failure(failure, Segment::Ss))?;
        }
    }

    for (address, byte) in code_write.into_iter().chain(stack_write) {
        image
            .write(address, 1, u64::from(byte))
            .expect("admitted private descriptor write");
    }
    if let Some(slots) = slots {
        for slot in slots {
            image
                .write(slot.address, slot.width, slot.value)
                .expect("admitted private frame write");
        }
    }

    let mut changed = context.set_mode_and_cpl(mode, cpl);
    if let Some(code) = code {
        changed |= context.set_segment(
            Segment::Cs,
            (selector & !3) | u16::from(cpl),
            code.cache(),
            code.attributes(),
        );
    } else {
        let mut cache = context.segment(Segment::Cs);
        cache.base = u64::from(selector) << 4;
        changed |= context.set_segment(
            Segment::Cs,
            selector,
            cache,
            context.attributes(Segment::Cs),
        );
    }
    if let Some(stack) = restored_stack {
        changed |= context.set_segment(Segment::Ss, stack.selector, stack.cache, stack.attributes);
        for segment in [Segment::Es, Segment::Ds, Segment::Fs, Segment::Gs] {
            let mut cache = context.segment(segment);
            let attributes = context.attributes(segment);
            if attributes.dpl < cpl
                && (!matches!(cache.kind, SegmentType::Code | SegmentType::ReadableCode)
                    || !attributes.conforming)
            {
                cache.usable = false;
                changed |= context.set_segment(segment, 0, cache, attributes);
            }
        }
    }
    Ok(FarOutcome {
        pc,
        sp: next_sp,
        context_changed: changed,
    })
}

#[derive(Clone, Copy)]
pub(super) struct Loaded {
    pub lookup: Lookup,
    pub descriptor: Descriptor,
}

impl Loaded {
    pub fn cache(self) -> LoadedSegment {
        let d = self.descriptor;
        LoadedSegment {
            base: u64::from(d.base),
            limit: d.limit,
            default32: d.flags & 4 != 0,
            usable: true,
            kind: if d.code() {
                if d.readable() {
                    SegmentType::ReadableCode
                } else {
                    SegmentType::Code
                }
            } else if d.access & 4 != 0 {
                SegmentType::ExpandDownReadWrite
            } else {
                SegmentType::ReadWrite
            },
        }
    }

    pub fn attributes(self) -> SegmentAttributes {
        let d = self.descriptor;
        SegmentAttributes {
            dpl: d.dpl(),
            present: true,
            accessed: true,
            conforming: d.conforming(),
            long: d.flags & 2 != 0,
            granularity: d.flags & 8 != 0,
            available: d.flags & 1 != 0,
        }
    }
}

#[derive(Clone, Copy)]
pub(super) struct Stack {
    pub selector: u16,
    pub cache: LoadedSegment,
    pub attributes: SegmentAttributes,
    pub loaded: Option<Loaded>,
}

#[derive(Clone, Copy)]
struct Write {
    address: u64,
    width: u32,
    value: u64,
}

fn lookup(context: &ExecutionContext, image: &Image, selector: u16) -> Result<Loaded, FarFailure> {
    if selector < 4 {
        return Err(selector_fault(selector, 13, ProtectionPhase::Selector));
    }
    let lookup = Lookup::resolve(context, selector)
        .filter(|lookup| lookup.fits(8))
        .ok_or_else(|| selector_fault(selector, 13, ProtectionPhase::Selector))?;
    let descriptor = Descriptor::decode(lookup.read(context, image, 0).map_err(system_failure)?);
    Ok(Loaded { lookup, descriptor })
}

pub(super) fn code(
    context: &ExecutionContext,
    image: &Image,
    kind: FarKind,
    selector: u16,
) -> Result<Loaded, FarFailure> {
    let loaded = lookup(context, image, selector)?;
    let d = loaded.descriptor;
    if !d.code() {
        if kind != FarKind::Return
            && d.system()
            && if ia32e(context) {
                d.access & 15 == 12
            } else {
                matches!(d.access & 15, 1 | 3 | 4 | 5 | 9 | 11 | 12)
            }
        {
            return Err(FarFailure::Unsupported);
        }
        return Err(selector_fault(selector, 13, ProtectionPhase::Descriptor));
    }
    let rpl = selector as u8 & 3;
    let allowed = if kind == FarKind::Return {
        rpl >= context.cpl()
            && if d.conforming() {
                d.dpl() <= rpl
            } else {
                d.dpl() == rpl
            }
    } else if d.conforming() {
        d.dpl() <= context.cpl()
    } else {
        d.dpl() == context.cpl() && rpl <= context.cpl()
    };
    if ia32e(context) && d.flags & 6 == 6 || !allowed {
        return Err(selector_fault(selector, 13, ProtectionPhase::Descriptor));
    }
    if !d.present() {
        return Err(selector_fault(selector, 11, ProtectionPhase::Descriptor));
    }
    Ok(loaded)
}

pub(super) fn stack(
    context: &ExecutionContext,
    image: &Image,
    mode: Mode,
    cpl: u8,
    selector: u16,
) -> Result<Stack, FarFailure> {
    if selector < 4 {
        if mode != Mode::Long64 || cpl == 3 || selector as u8 != cpl {
            return Err(selector_fault(selector, 13, ProtectionPhase::Selector));
        }
        let mut cache = context.segment(Segment::Ss);
        cache.usable = false;
        return Ok(Stack {
            selector,
            cache,
            attributes: context.attributes(Segment::Ss),
            loaded: None,
        });
    }
    let loaded = lookup(context, image, selector)?;
    let d = loaded.descriptor;
    if !d.writable() || d.dpl() != cpl || selector as u8 & 3 != cpl {
        return Err(selector_fault(selector, 13, ProtectionPhase::Descriptor));
    }
    if !d.present() {
        return Err(selector_fault(selector, 12, ProtectionPhase::Descriptor));
    }
    Ok(Stack {
        selector,
        cache: loaded.cache(),
        attributes: loaded.attributes(),
        loaded: Some(loaded),
    })
}

fn stack_geometry(
    context: &ExecutionContext,
    offset: u64,
    width: u32,
    access: Access,
) -> Result<u64, FarFailure> {
    context
        .translate(offset, width, Segment::Ss, access, false)
        .map_err(|failure| FarFailure::Operand {
            segment: Segment::Ss,
            failure,
        })
}

fn read_stack(
    context: &ExecutionContext,
    image: &Image,
    offset: u64,
    width: Width,
) -> Result<u64, FarFailure> {
    let address = stack_geometry(context, offset, u32::from(width.bytes()), Access::Read)?;
    let bytes = image
        .read_vector(address, u32::from(width.bytes()))
        .map_err(|failure| linear_failure(failure, Segment::Ss))?;
    Ok(u64::from_le_bytes(bytes[..8].try_into().unwrap()))
}

fn step(value: u64, amount: u64, width: Width) -> u64 {
    value.wrapping_add(amount) & width.mask()
}
fn merge(old: u64, value: u64, width: Width) -> u64 {
    (old & !width.mask()) | (value & width.mask())
}

fn selector_fault(selector: u16, vector: u8, phase: ProtectionPhase) -> FarFailure {
    FarFailure::Protection(ProtectionFault {
        vector,
        error_code: selector & 0xfffc,
        phase,
        selector: Some(selector),
    })
}
fn target_fault() -> FarFailure {
    FarFailure::Protection(ProtectionFault {
        vector: 13,
        error_code: 0,
        phase: ProtectionPhase::Target,
        selector: None,
    })
}
fn linear_failure(failure: crate::memory::Fault, segment: Segment) -> FarFailure {
    FarFailure::Operand {
        segment,
        failure: AccessFailure::Linear(failure),
    }
}
fn operand_failure(failure: super::Failure, segment: Segment) -> FarFailure {
    match failure {
        super::Failure::Operand(failure) => FarFailure::Operand { segment, failure },
        other => system_failure(other),
    }
}
fn system_failure(failure: super::Failure) -> FarFailure {
    match failure {
        super::Failure::Protection(failure) => FarFailure::Protection(failure),
        super::Failure::SystemMemory(failure) => FarFailure::SystemMemory(failure),
        super::Failure::Operand(_) => unreachable!("descriptor access is unsegmented"),
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod boundary_tests;

#[cfg(test)]
mod review_tests;
