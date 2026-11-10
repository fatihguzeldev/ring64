// Debug sampling covers admitted instruction operands, including control-stack
// slots. Descriptor metadata and event-entry frame writes are separate traffic.
use super::super::debug::State;
use super::*;
use crate::x86::instruction::{FarDescriptor, FarKind, SoftwareEventDescriptor, SoftwareEventKind};

fn operand(
    bank: &State,
    before: &ExecutionContext,
    offset: u64,
    width: u32,
    segment: Segment,
    access: Access,
) -> u8 {
    before
        .translate(offset, width, segment, access, false)
        .ok()
        .map_or(0, |address| bank.matches(address, width, access))
}

pub fn protection(
    bank: &State,
    before: &ExecutionContext,
    descriptor: ProtectionDescriptor,
    offset: u64,
    segment: Segment,
) -> u8 {
    use ProtectionKind::*;
    let (width, access) = match descriptor.kind {
        StoreGdt | StoreIdt => (if before.is_long64() { 10 } else { 6 }, Access::Write),
        LoadGdt | LoadIdt => (if before.is_long64() { 10 } else { 6 }, Access::Read),
        ReadLdt | ReadTask | ReadSegment(_) if descriptor.memory => (2, Access::Write),
        Lar | Lsl | Verr | Verw | LoadLdt | LoadTask | LoadSegment(_) if descriptor.memory => {
            (2, Access::Read)
        }
        LoadFar(_) => (u32::from(descriptor.width.bytes()) + 2, Access::Read),
        _ => return 0,
    };
    operand(bank, before, offset, width, segment, access)
}

pub fn far(
    bank: &State,
    before: &ExecutionContext,
    after: &ExecutionContext,
    descriptor: FarDescriptor,
    offset: u64,
    sp: u64,
    segment: Segment,
) -> u8 {
    let size = u64::from(descriptor.width.bytes());
    let mask = before.stack_width().mask();
    let mut slots = if descriptor.memory {
        operand(bank, before, offset, size as u32 + 2, segment, Access::Read)
    } else {
        0
    };
    if descriptor.kind == FarKind::Call {
        for index in 1..=2 {
            slots |= operand(
                bank,
                before,
                sp.wrapping_sub(index * size) & mask,
                size as u32,
                Segment::Ss,
                Access::Write,
            );
        }
    } else if descriptor.kind == FarKind::Return {
        for index in 0..2 {
            slots |= operand(
                bank,
                before,
                sp.wrapping_add(index * size) & mask,
                size as u32,
                Segment::Ss,
                Access::Read,
            );
        }
        if after.cpl() > before.cpl() {
            for index in 2..4 {
                slots |= operand(
                    bank,
                    before,
                    sp.wrapping_add(index * size).wrapping_add(offset) & mask,
                    size as u32,
                    Segment::Ss,
                    Access::Read,
                );
            }
        }
    }
    slots
}

pub fn iret(
    bank: &State,
    before: &ExecutionContext,
    after: &ExecutionContext,
    operation: SoftwareEventDescriptor,
    sp: u64,
) -> u8 {
    if operation.kind != SoftwareEventKind::Return {
        return 0;
    }
    let count = if before.mode() == Mode::Protected && after.mode() == Mode::Virtual8086 {
        9
    } else if before.is_long64() || after.cpl() > before.cpl() {
        5
    } else {
        3
    };
    let size = u64::from(operation.width.bytes());
    let mask = before.stack_width().mask();
    (0..count).fold(0, |slots, index| {
        slots
            | operand(
                bank,
                before,
                sp.wrapping_add(index * size) & mask,
                size as u32,
                Segment::Ss,
                Access::Read,
            )
    })
}
