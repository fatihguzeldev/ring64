use super::access::GuestMemory;
use super::context::{AccessFailure, ExecutionContext, Mode, Segment, SegmentCause, SegmentType};
use super::instruction::Width;
use super::protection::{Failure, ProtectionFault, ProtectionPhase};
use crate::memory::Access;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompoundStackKind {
    Enter { allocation: u16, nesting: u8 },
    PushAll,
    PopAll,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CompoundStack {
    pub kind: CompoundStackKind,
    pub width: Width,
}

impl CompoundStack {
    pub fn encode(self) -> u32 {
        let width = match self.width {
            Width::W16 => 0,
            Width::W32 => 1,
            Width::W64 => 2,
            Width::W8 => unreachable!("compound stack operands are not bytes"),
        };
        let (kind, allocation, nesting) = match self.kind {
            CompoundStackKind::Enter {
                allocation,
                nesting,
            } => {
                assert!(
                    nesting <= 31,
                    "decoded ENTER nesting is masked to five bits"
                );
                (0, u32::from(allocation), u32::from(nesting))
            }
            CompoundStackKind::PushAll => (1, 0, 0),
            CompoundStackKind::PopAll => (2, 0, 0),
        };
        kind | (width << 2) | (allocation << 4) | (nesting << 20)
    }

    pub fn try_decode(word: u32) -> Option<Self> {
        if word >> 25 != 0 {
            return None;
        }
        let width = match (word >> 2) & 3 {
            0 => Width::W16,
            1 => Width::W32,
            2 => Width::W64,
            _ => return None,
        };
        let kind = match word & 3 {
            0 => CompoundStackKind::Enter {
                allocation: (word >> 4) as u16,
                nesting: ((word >> 20) & 31) as u8,
            },
            1 if word >> 4 == 0 => CompoundStackKind::PushAll,
            2 if word >> 4 == 0 => CompoundStackKind::PopAll,
            _ => return None,
        };
        Some(Self { kind, width })
    }

    pub fn valid_in_mode(self, context: &ExecutionContext) -> bool {
        if let CompoundStackKind::Enter { nesting, .. } = self.kind
            && nesting > 31
        {
            return false;
        }
        if context.is_long64() {
            matches!(self.kind, CompoundStackKind::Enter { .. })
                && matches!(self.width, Width::W16 | Width::W64)
        } else {
            matches!(self.width, Width::W16 | Width::W32)
        }
    }
}

pub fn execute(
    context: &ExecutionContext,
    memory: &mut impl GuestMemory,
    registers: &mut [u64; 16],
    operation: CompoundStack,
) -> Result<(), Failure> {
    execute_observing(context, memory, registers, operation, &mut |_, _, _| {})
}

/// Observations belong to this instruction's tentative completion. The caller
/// discards them on failure, including the selected POPA stack-limit residue.
pub fn execute_observing(
    context: &ExecutionContext,
    memory: &mut impl GuestMemory,
    registers: &mut [u64; 16],
    operation: CompoundStack,
    observe: &mut impl FnMut(u64, u32, Access),
) -> Result<(), Failure> {
    assert!(
        operation.valid_in_mode(context),
        "admitted compound stack operation"
    );
    let width = operation.width;
    let stack = context.stack_width();
    let mut sp = registers[4];
    match operation.kind {
        CompoundStackKind::Enter {
            allocation,
            nesting,
        } => {
            let bp = registers[5];
            let mut chain = bp & stack.mask();
            push(context, memory, &mut sp, bp, width, observe)?;
            let frame = sp & width.mask();
            for _ in 1..nesting {
                chain = chain.wrapping_sub(u64::from(width.bytes())) & stack.mask();
                let value = read(context, memory, chain, width, observe)?;
                push(context, memory, &mut sp, value, width, observe)?;
            }
            if nesting != 0 {
                push(context, memory, &mut sp, frame, width, observe)?;
            }
            sp = merge(sp, sp.wrapping_sub(u64::from(allocation)), stack);
            let address = stack_address(context, sp & stack.mask(), 1, Access::Write)?;
            memory.probe_write(address).map_err(Failure::Operand)?;
            registers[5] = merge(bp, frame, width);
        }
        CompoundStackKind::PushAll => {
            if canonical_small_stack(context) && matches!(sp & stack.mask(), 7 | 9 | 11 | 13 | 15) {
                return Err(Failure::Protection(ProtectionFault {
                    vector: 13,
                    error_code: 0,
                    phase: ProtectionPhase::Target,
                    selector: None,
                }));
            }
            let sources: [u64; 8] = registers[..8].try_into().unwrap();
            for value in sources {
                push(context, memory, &mut sp, value, width, observe)?;
            }
        }
        CompoundStackKind::PopAll => {
            const BANKS: [usize; 7] = [7, 6, 5, 3, 2, 1, 0];
            let mut values = [0; 7];
            for index in 0..BANKS.len() {
                if index == 3 {
                    sp = merge(sp, sp.wrapping_add(u64::from(width.bytes())), stack);
                }
                match read(context, memory, sp & stack.mask(), width, observe) {
                    Ok(value) => values[index] = value,
                    Err(failure) => {
                        if matches!(failure, Failure::Operand(AccessFailure::Segment(s))
                            if s.segment == Segment::Ss && s.cause == SegmentCause::Limit)
                        {
                            for prior in 0..index {
                                let bank = BANKS[prior];
                                registers[bank] = merge(registers[bank], values[prior], width);
                            }
                        }
                        return Err(failure);
                    }
                }
                sp = merge(sp, sp.wrapping_add(u64::from(width.bytes())), stack);
            }
            for (bank, value) in BANKS.into_iter().zip(values) {
                registers[bank] = merge(registers[bank], value, width);
            }
        }
    }
    registers[4] = sp;
    Ok(())
}

fn merge(raw: u64, value: u64, width: Width) -> u64 {
    (raw & !width.mask()) | (value & width.mask())
}

fn stack_address(
    context: &ExecutionContext,
    cursor: u64,
    width: u32,
    access: Access,
) -> Result<u64, Failure> {
    context
        .translate(cursor, width, Segment::Ss, access, false)
        .map_err(Failure::Operand)
}

fn read(
    context: &ExecutionContext,
    memory: &impl GuestMemory,
    cursor: u64,
    width: Width,
    observe: &mut impl FnMut(u64, u32, Access),
) -> Result<u64, Failure> {
    let size = u32::from(width.bytes());
    let address = stack_address(context, cursor, size, Access::Read)?;
    let value = memory.read(address, size).map_err(Failure::Operand)?;
    observe(address, size, Access::Read);
    Ok(value & width.mask())
}

fn push(
    context: &ExecutionContext,
    memory: &mut impl GuestMemory,
    sp: &mut u64,
    value: u64,
    width: Width,
    observe: &mut impl FnMut(u64, u32, Access),
) -> Result<(), Failure> {
    let stack = context.stack_width();
    let next = merge(*sp, sp.wrapping_sub(u64::from(width.bytes())), stack);
    let size = u32::from(width.bytes());
    let address = stack_address(context, next & stack.mask(), size, Access::Write)?;
    memory
        .check_write(address, size)
        .map_err(Failure::Operand)?;
    memory.prepare_publication().map_err(Failure::Operand)?;
    memory
        .write(address, size, value & width.mask())
        .map_err(Failure::Operand)?;
    observe(address, size, Access::Write);
    *sp = next;
    Ok(())
}

fn canonical_small_stack(context: &ExecutionContext) -> bool {
    let ss = context.segment(Segment::Ss);
    matches!(context.mode(), Mode::Real | Mode::Virtual8086)
        && !ss.default32
        && ss.usable
        && ss.kind == SegmentType::ReadWrite
        && ss.limit == 0xffff
        && ss.base == u64::from(context.selector(Segment::Ss)) << 4
        && context.attributes(Segment::Ss).present
}

#[cfg(test)]
#[path = "compound_stack/tests.rs"]
mod tests;
