use crate::memory::Fault;

use super::instruction::Instruction;

mod cursor;
mod opcode;
mod operand;
mod prefix;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeError {
    Unsupported,
    Invalid,
    Fetch(Fault),
}

pub fn decode<F>(pc: u64, read: F) -> Result<Instruction, DecodeError>
where
    F: FnMut(u64) -> Result<u8, Fault>,
{
    let mut cursor = cursor::Cursor::new(pc, read);
    let (prefixes, opcode) = prefix::read(&mut cursor)?;
    let operation = opcode::refine(opcode, prefixes, &mut cursor)?;
    Ok(Instruction {
        pc,
        next_pc: cursor.next_pc(),
        operation,
    })
}

#[cfg(test)]
mod tests;
