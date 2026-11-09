use crate::memory::Fault;
use crate::x86::context::{ExecutionContext, SegmentFault};

use super::instruction::Instruction;

mod cursor;
mod far;
mod float;
mod mmx;
mod numeric_image;
mod opcode;
mod operand;
mod prefix;
mod protection;
mod software_events;
mod streaming;
mod system_flags;
mod vector;
mod x87;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeError {
    Unsupported,
    Invalid,
    Fetch(Fault),
    Segment(SegmentFault),
}

pub fn decode<F>(pc: u64, mut read: F) -> Result<Instruction, DecodeError>
where
    F: FnMut(u64) -> Result<u8, Fault>,
{
    decode_with_context(pc, &ExecutionContext::default(), |address| {
        read(address).map_err(DecodeError::Fetch)
    })
}

pub fn decode_with_context<F>(
    pc: u64,
    context: &ExecutionContext,
    read: F,
) -> Result<Instruction, DecodeError>
where
    F: FnMut(u64) -> Result<u8, DecodeError>,
{
    let mut cursor = cursor::Cursor::new(pc, context.is_long64(), read);
    let (prefixes, opcode) = prefix::read(&mut cursor, context)?;
    let operation = opcode::refine(opcode, prefixes, &mut cursor)?;
    Ok(Instruction {
        pc,
        next_pc: cursor.next_pc(),
        operation,
    })
}

#[cfg(test)]
mod tests;
