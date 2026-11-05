use crate::memory::Fault;
use crate::x86::instruction::{Alu, Condition, MemoryAluOperands, Operand, Operation, Width};

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
        0x8d => {
            let operands = ModRm::read(cursor, rex)?;
            if operands.mode == 3 {
                return Err(DecodeError::Invalid);
            }
            Ok(Operation::Lea {
                dst: operands.register,
                address: operands.address(cursor, rex)?,
                width,
            })
        }
        0x01 | 0x03 | 0x09 | 0x0b | 0x21 | 0x23 | 0x29 | 0x2b | 0x31 | 0x33 | 0x39 | 0x3b
        | 0x85 => {
            let operands = ModRm::read(cursor, rex)?;
            if operands.mode == 3 && matches!(opcode, 0x03 | 0x2b | 0x3b) {
                return Err(DecodeError::Unsupported);
            }
            let kind = match opcode {
                0x01 | 0x03 => Alu::Add,
                0x09 | 0x0b => Alu::Or,
                0x21 | 0x23 => Alu::And,
                0x29 | 0x2b => Alu::Sub,
                0x31 | 0x33 => Alu::Xor,
                0x39 | 0x3b => Alu::Cmp,
                0x85 => Alu::Test,
                _ => unreachable!(),
            };
            let register_first = matches!(opcode, 0x03 | 0x0b | 0x23 | 0x2b | 0x33 | 0x3b);
            if operands.mode != 3 {
                return Ok(Operation::MemoryAlu {
                    kind,
                    address: operands.address(cursor, rex)?,
                    operands: if register_first {
                        MemoryAluOperands::RegisterFirst(operands.register)
                    } else {
                        MemoryAluOperands::MemoryFirst(Operand::Register(operands.register))
                    },
                    width,
                });
            }
            let (dst, src) = if register_first {
                (operands.register, operands.rm)
            } else {
                (operands.rm, operands.register)
            };
            Ok(Operation::Alu {
                kind,
                dst,
                src: Operand::Register(src),
                width,
            })
        }
        0x81 | 0x83 | 0xf7 => {
            let operands = ModRm::read(cursor, rex)?;
            // REX.R extends register operands, never this opcode selector.
            let kind = match (opcode, operands.selector) {
                (0xf7, 0) => Alu::Test,
                (0xf7, _) => return Err(DecodeError::Unsupported),
                (_, 0) => Alu::Add,
                (_, 1) => Alu::Or,
                (_, 4) => Alu::And,
                (_, 5) => Alu::Sub,
                (_, 6) => Alu::Xor,
                (_, 7) => Alu::Cmp,
                _ => return Err(DecodeError::Unsupported),
            };
            let address = if operands.mode == 3 {
                None
            } else {
                Some(operands.address(cursor, rex)?)
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
            if let Some(address) = address {
                Ok(Operation::MemoryAlu {
                    kind,
                    address,
                    operands: MemoryAluOperands::MemoryFirst(Operand::Immediate(value)),
                    width,
                })
            } else {
                Ok(Operation::Alu {
                    kind,
                    dst: operands.rm,
                    src: Operand::Immediate(value),
                    width,
                })
            }
        }
        0xeb | 0xe9 | 0x70..=0x7f | 0x0f => {
            if rex.present {
                return Err(DecodeError::Unsupported);
            }
            let conditional = match opcode {
                0x70..=0x7f => Some(condition(opcode)),
                0x0f => {
                    let second = cursor.byte()?;
                    if !(0x80..=0x8f).contains(&second) {
                        return Err(DecodeError::Unsupported);
                    }
                    Some(condition(second))
                }
                _ => None,
            };
            let displacement = if matches!(opcode, 0xeb | 0x70..=0x7f) {
                i64::from(cursor.byte()? as i8)
            } else {
                i64::from(cursor.unsigned(4)? as u32 as i32)
            };
            let target = cursor.next_pc().wrapping_add(displacement as u64);
            if let Some(condition) = conditional {
                Ok(Operation::Jcc { condition, target })
            } else {
                Ok(Operation::Jump { target })
            }
        }
        _ => Err(DecodeError::Unsupported),
    }
}

fn condition(opcode: u8) -> Condition {
    match opcode & 15 {
        0x0 => Condition::Overflow,
        0x1 => Condition::NotOverflow,
        0x2 => Condition::Below,
        0x3 => Condition::AboveOrEqual,
        0x4 => Condition::Equal,
        0x5 => Condition::NotEqual,
        0x6 => Condition::BelowOrEqual,
        0x7 => Condition::Above,
        0x8 => Condition::Sign,
        0x9 => Condition::NotSign,
        0xa => Condition::Parity,
        0xb => Condition::NotParity,
        0xc => Condition::Less,
        0xd => Condition::GreaterOrEqual,
        0xe => Condition::LessOrEqual,
        0xf => Condition::Greater,
        _ => unreachable!(),
    }
}
