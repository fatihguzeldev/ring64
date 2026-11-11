use super::{DecodeError, cursor::Cursor, operand::ModRm, prefix::Prefixes};
use crate::x86::instruction::{Operation, PagingInstruction, Width};

pub(super) fn two_byte<F>(
    opcode: u8,
    prefixes: Prefixes,
    cursor: &mut Cursor<F>,
) -> Option<Result<Operation, DecodeError>>
where
    F: FnMut(u64) -> Result<u8, DecodeError>,
{
    if !prefixes.paged || !matches!(opcode, 0x20 | 0x22 | 0x30 | 0x32) {
        return None;
    }
    Some((|| {
        if prefixes.repeat.is_some() {
            return Err(DecodeError::Unsupported);
        }
        let operation = if matches!(opcode, 0x20 | 0x22) {
            let byte = cursor.byte()?;
            let register = ((byte >> 3) & 7) | prefixes.rex.reg_extension();
            if !matches!(register, 0 | 2 | 3 | 4 | 8) {
                return Err(DecodeError::Invalid);
            }
            PagingInstruction::ControlRegister {
                register,
                gpr: (byte & 7) | prefixes.rex.base_extension(),
                write: opcode == 0x22,
                width: if prefixes.long64 {
                    Width::W64
                } else {
                    Width::W32
                },
            }
        } else {
            PagingInstruction::ModelSpecificRegister {
                write: opcode == 0x30,
            }
        };
        Ok(Operation::Paging(operation))
    })())
}

pub(super) fn invlpg<F>(
    operands: ModRm,
    prefixes: Prefixes,
    cursor: &mut Cursor<F>,
) -> Result<Operation, DecodeError>
where
    F: FnMut(u64) -> Result<u8, DecodeError>,
{
    if prefixes.repeat.is_some() {
        return Err(DecodeError::Unsupported);
    }
    if operands.mode == 3 {
        return Err(DecodeError::Invalid);
    }
    Ok(Operation::Paging(PagingInstruction::InvalidatePage(
        operands.address(cursor, prefixes)?,
    )))
}
