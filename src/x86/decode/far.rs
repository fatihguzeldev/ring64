use super::{DecodeError, cursor::Cursor, operand::ModRm, prefix::Prefixes};
use crate::x86::instruction::{FarInstruction, FarKind, FarOperand, Operation};

pub(super) fn one_byte<F>(
    opcode: u8,
    prefixes: Prefixes,
    cursor: &mut Cursor<F>,
) -> Option<Result<Operation, DecodeError>>
where
    F: FnMut(u64) -> Result<u8, DecodeError>,
{
    if !matches!(opcode, 0x9a | 0xea | 0xca | 0xcb)
        && !(opcode == 0xff && prefixes.repeat.is_some())
    {
        return None;
    }
    Some((|| {
        if opcode == 0xff {
            let operands = ModRm::read(cursor, prefixes.rex)?;
            return if matches!(operands.selector, 3 | 5) {
                memory(&operands, prefixes, cursor)
            } else {
                Err(DecodeError::Unsupported)
            };
        }
        let width = prefixes.width();
        let (kind, operand) = if matches!(opcode, 0xca | 0xcb) {
            (
                FarKind::Return,
                FarOperand::Return {
                    cleanup: if opcode == 0xca {
                        cursor.unsigned(2)? as u16
                    } else {
                        0
                    },
                },
            )
        } else {
            if prefixes.long64 {
                return Err(DecodeError::Invalid);
            }
            let offset = cursor.unsigned(width.bytes())?;
            let selector = cursor.unsigned(2)? as u16;
            (
                if opcode == 0x9a {
                    FarKind::Call
                } else {
                    FarKind::Jump
                },
                FarOperand::Immediate { selector, offset },
            )
        };
        Ok(Operation::Far(FarInstruction {
            kind,
            width,
            operand,
        }))
    })())
}

pub(super) fn memory<F>(
    operands: &ModRm,
    prefixes: Prefixes,
    cursor: &mut Cursor<F>,
) -> Result<Operation, DecodeError>
where
    F: FnMut(u64) -> Result<u8, DecodeError>,
{
    if operands.mode == 3 {
        return Err(DecodeError::Invalid);
    }
    let kind = if operands.selector == 3 {
        FarKind::Call
    } else {
        FarKind::Jump
    };
    Ok(Operation::Far(FarInstruction {
        kind,
        width: prefixes.width(),
        operand: FarOperand::Memory(operands.address(cursor, prefixes)?),
    }))
}
