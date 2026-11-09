use super::{ExecutionContext, Image, ProtectionFault, ProtectionPhase, SystemMemoryFault};
use crate::x86::context::{AccessFailure, Mode, Segment};
use crate::x86::instruction::{SoftwareEventDescriptor, SoftwareEventKind, Width};

mod entry;
#[cfg(test)]
mod flags;
mod frame;
mod system;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod entry_priority_tests;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EventInputs {
    pub flags: u64,
    pub sp: u64,
    pub next_pc: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EventOutcome {
    pub pc: u64,
    pub sp: u64,
    pub flags: u64,
    pub context_changed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventFailure {
    Operand {
        segment: Segment,
        failure: AccessFailure,
    },
    Protection(ProtectionFault),
    SystemMemory(SystemMemoryFault),
    Unsupported,
}

pub fn valid_in_mode(descriptor: SoftwareEventDescriptor, context: &ExecutionContext) -> bool {
    descriptor.width != Width::W8
        && SoftwareEventDescriptor::try_decode(descriptor.encode()) == Some(descriptor)
        && (descriptor.width != Width::W64 || context.is_long64())
        && !(descriptor.kind == SoftwareEventKind::Into && context.is_long64())
}

pub fn execute(
    context: &mut ExecutionContext,
    image: &mut Image,
    descriptor: SoftwareEventDescriptor,
    inputs: EventInputs,
) -> Result<EventOutcome, EventFailure> {
    if descriptor.width == Width::W8 || !valid_in_mode(descriptor, context) {
        return Err(EventFailure::Unsupported);
    }
    if descriptor.kind == SoftwareEventKind::Return {
        return Err(EventFailure::Unsupported);
    }
    if descriptor.kind == SoftwareEventKind::Into && inputs.flags & 0x800 == 0 {
        return Ok(EventOutcome {
            pc: inputs.next_pc,
            sp: inputs.sp,
            flags: inputs.flags,
            context_changed: false,
        });
    }
    entry::execute(context, image, descriptor, inputs)
}

fn fault(
    vector: u8,
    error_code: u16,
    phase: ProtectionPhase,
    selector: Option<u16>,
) -> EventFailure {
    EventFailure::Protection(ProtectionFault {
        vector,
        error_code,
        phase,
        selector,
    })
}

fn selector_fault(selector: u16, vector: u8, ext: u16, phase: ProtectionPhase) -> EventFailure {
    fault(vector, (selector & 0xfffc) | ext, phase, Some(selector))
}

fn descriptor_failure(failure: super::Failure) -> EventFailure {
    match failure {
        super::Failure::Protection(failure) => EventFailure::Protection(failure),
        super::Failure::SystemMemory(failure) => EventFailure::SystemMemory(failure),
        super::Failure::Operand(_) => unreachable!("unsegmented descriptor access"),
    }
}
