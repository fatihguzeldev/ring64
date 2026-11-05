use crate::memory::Fault;
use crate::x86::instruction::{Alu, Operand, Operation, Width};

use super::{DecodeError, cursor::Cursor, operand::ModRm, prefix::Rex};

pub(super) fn refine<F>(
    opcode: u8,
    rex: Rex,
    cursor: &mut Cursor<F>,
) -> Result<Operation, DecodeError>
where
    F: FnMut(u64) -> Result<u8, Fault>,
{
    let width = rex.width();
    match opcode {
        0xb8..=0xbf => Ok(Operation::Mov {
            dst: (opcode - 0xb8) | rex.base_extension(),
            src: Operand::Immediate(cursor.unsigned(width.bytes())?),
            width,
        }),
        0x89 | 0x8b => {
            let operands = ModRm::read(cursor, rex)?;
            if operands.mode == 3 {
                let (dst, src) = if opcode == 0x89 {
                    (operands.rm, operands.register)
                } else {
                    (operands.register, operands.rm)
                };
                Ok(Operation::Mov {
                    dst,
                    src: Operand::Register(src),
                    width,
                })
            } else {
                let address = operands.address(cursor, rex)?;
                if opcode == 0x89 {
                    Ok(Operation::Store {
                        src: operands.register,
                        address,
                        width,
                    })
                } else {
                    Ok(Operation::Load {
                        dst: operands.register,
                        address,
                        width,
                    })
                }
            }
        }
        0x01 | 0x29 | 0x39 => {
            let operands = ModRm::read(cursor, rex)?;
            if operands.mode != 3 {
                return Err(DecodeError::Unsupported);
            }
            let kind = match opcode {
                0x01 => Alu::Add,
                0x29 => Alu::Sub,
                0x39 => Alu::Cmp,
                _ => unreachable!(),
            };
            Ok(Operation::Alu {
                kind,
                dst: operands.rm,
                src: Operand::Register(operands.register),
                width,
            })
        }
        0x81 | 0x83 => {
            let operands = ModRm::read(cursor, rex)?;
            if operands.mode != 3 {
                return Err(DecodeError::Unsupported);
            }
            // REX.R extends register operands, never this opcode selector.
            let kind = match operands.selector {
                0 => Alu::Add,
                5 => Alu::Sub,
                7 => Alu::Cmp,
                _ => return Err(DecodeError::Unsupported),
            };
            let value = if opcode == 0x83 {
                cursor.byte()? as i8 as i64 as u64
            } else {
                cursor.unsigned(4)? as u32 as i32 as i64 as u64
            };
            let value = match width {
                Width::W32 => u64::from(value as u32),
                Width::W64 => value,
            };
            Ok(Operation::Alu {
                kind,
                dst: operands.rm,
                src: Operand::Immediate(value),
                width,
            })
        }
        0xeb | 0xe9 | 0x75 | 0x0f => {
            if rex.present {
                return Err(DecodeError::Unsupported);
            }
            let conditional = match opcode {
                0x75 => true,
                0x0f if cursor.byte()? == 0x85 => true,
                0x0f => return Err(DecodeError::Unsupported),
                _ => false,
            };
            let displacement = if opcode == 0xeb || opcode == 0x75 {
                i64::from(cursor.byte()? as i8)
            } else {
                i64::from(cursor.unsigned(4)? as u32 as i32)
            };
            let target = cursor.next_pc().wrapping_add(displacement as u64);
            if conditional {
                Ok(Operation::Jnz { target })
            } else {
                Ok(Operation::Jump { target })
            }
        }
        _ => Err(DecodeError::Unsupported),
    }
}
