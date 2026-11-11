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
mod paging;
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
    Undefined,
    UndefinedEncoding,
    /// Recognized illegal form; unknown or unimplemented forms use Unsupported.
    Invalid,
    InstructionLength,
    Fetch(Fault),
    Segment(SegmentFault),
    Paging(crate::x86::paging::walk::Failure),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeFault {
    UndefinedOpcode,
    InstructionLength,
}

impl DecodeFault {
    pub fn vector_and_code(self) -> (u8, Option<u16>) {
        match self {
            Self::UndefinedOpcode => (6, None),
            Self::InstructionLength => (13, Some(0)),
        }
    }
}

impl DecodeError {
    pub fn architectural_fault(self) -> Option<DecodeFault> {
        match self {
            Self::Undefined | Self::UndefinedEncoding | Self::Invalid => {
                Some(DecodeFault::UndefinedOpcode)
            }
            Self::InstructionLength => Some(DecodeFault::InstructionLength),
            Self::Unsupported | Self::Fetch(_) | Self::Segment(_) | Self::Paging(_) => None,
        }
    }
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
    decode_with_profile(pc, context, false, read)
}

pub fn decode_with_profile<F>(
    pc: u64,
    context: &ExecutionContext,
    paged: bool,
    read: F,
) -> Result<Instruction, DecodeError>
where
    F: FnMut(u64) -> Result<u8, DecodeError>,
{
    let mut cursor = cursor::Cursor::new(pc, context.is_long64(), read);
    let (mut prefixes, opcode) = prefix::read(&mut cursor, context)?;
    prefixes.paged = paged
        && matches!(
            context.mode(),
            crate::x86::context::Mode::Long64 | crate::x86::context::Mode::Compatibility
        );
    let operation = opcode::refine(opcode, prefixes, &mut cursor)?;
    Ok(Instruction {
        pc,
        next_pc: cursor.next_pc(),
        operation,
    })
}

#[cfg(test)]
mod tests;

#[cfg(test)]
#[path = "tests/paging.rs"]
mod paging_tests;
