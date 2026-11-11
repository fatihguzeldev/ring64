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
    if prefixes.paged && opcode == 0x06 {
        return Some(if prefixes.repeat.is_some() {
            Err(DecodeError::Unsupported)
        } else if prefixes.lock {
            Err(DecodeError::UndefinedEncoding)
        } else {
            Ok(Operation::Paging(PagingInstruction::ClearTaskSwitched))
        });
    }
    if prefixes.paged
        && matches!(
            prefixes.mode,
            crate::x86::context::Mode::Long64 | crate::x86::context::Mode::Compatibility
        )
        && matches!(opcode, 0x05 | 0x07 | 0x34 | 0x35)
    {
        use crate::x86::fast_system::Instruction;
        return Some(
            if prefixes.lock || matches!(opcode, 0x05 | 0x07) && !prefixes.long64 {
                Err(DecodeError::UndefinedEncoding)
            } else {
                let wide = prefixes.long64 && prefixes.rex.width() == Width::W64;
                Ok(Operation::FastSystem(match opcode {
                    0x05 => Instruction::Syscall,
                    0x07 => Instruction::Sysret { wide },
                    0x34 => Instruction::Sysenter,
                    _ => Instruction::Sysexit { wide },
                }))
            },
        );
    }
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
