use crate::memory::Fault;
use crate::x86::instruction::{
    Address, AddressBase, Alu, Bit, BitIndex, Carry, Condition, Count, DataOperand, DoubleShift,
    Location, MemoryAluOperands, Operand, Operation, RegisterView, Shift, Unary, Width,
};

use super::{cursor::Cursor, operand::ModRm, prefix::Prefixes, DecodeError};

pub(super) fn refine<F>(
    opcode: u8,
    prefixes: Prefixes,
    cursor: &mut Cursor<F>,
) -> Result<Operation, DecodeError>
where
    F: FnMut(u64) -> Result<u8, Fault>,
{
    let rex = prefixes.rex;
    let wide = prefixes.width();
    if prefixes.operand16
        && matches!(opcode, 0x50..=0x5f | 0x68 | 0x6a | 0x70..=0x7f | 0xc2 | 0xc3 | 0xe8 | 0xe9 | 0xeb)
    {
        return Err(DecodeError::Unsupported);
    }
    match opcode {
        0x50..=0x57 => Ok(Operation::Push {
            src: Operand::Register((opcode - 0x50) | rex.base_extension()),
        }),
        0x58..=0x5f => Ok(Operation::Pop {
            dst: (opcode - 0x58) | rex.base_extension(),
        }),
        0x68 | 0x6a => Ok(Operation::Push {
            src: Operand::Immediate(if opcode == 0x6a {
                cursor.byte()? as i8 as i64 as u64
            } else {
                cursor.unsigned(4)? as u32 as i32 as i64 as u64
            }),
        }),
        0xe8 => {
            let displacement = cursor.unsigned(4)? as u32 as i32 as i64;
            Ok(Operation::Call {
                target: Operand::Immediate(cursor.next_pc().wrapping_add(displacement as u64)),
            })
        }
        0xff => {
            let operands = ModRm::read(cursor, rex)?;
            if operands.selector <= 1 {
                return Ok(Operation::Unary {
                    kind: if operands.selector == 0 {
                        Unary::Inc
                    } else {
                        Unary::Dec
                    },
                    dst: operands.location(cursor, rex, wide)?,
                    width: wide,
                });
            }
            if prefixes.operand16 || operands.mode != 3 {
                return Err(DecodeError::Unsupported);
            }
            match operands.selector {
                2 => Ok(Operation::Call {
                    target: Operand::Register(operands.rm),
                }),
                4 => Ok(Operation::JumpRegister {
                    target: operands.rm,
                }),
                _ => Err(DecodeError::Unsupported),
            }
        }
        0xc3 => Ok(Operation::Return { cleanup: 0 }),
        0xc2 => Ok(Operation::Return {
            cleanup: cursor.unsigned(2)? as u16,
        }),
        0xb0..=0xbf => {
            let (start, width) = if opcode < 0xb8 {
                (0xb0, Width::W8)
            } else {
                (0xb8, wide)
            };
            Ok(Operation::Mov {
                dst: rex.view((opcode - start) | rex.base_extension(), width),
                src: DataOperand::Immediate(cursor.unsigned(width.bytes())?),
                width,
            })
        }
        0x88..=0x8b => {
            let width = byte_or_wide(opcode, wide);
            let operands = ModRm::read(cursor, rex)?;
            let register = rex.view(operands.register, width);
            let location = operands.location(cursor, rex, width)?;
            if opcode & 2 == 0 {
                Ok(move_to(location, DataOperand::Register(register), width))
            } else {
                Ok(match location {
                    Location::Register(src) => Operation::Mov {
                        dst: register,
                        src: DataOperand::Register(src),
                        width,
                    },
                    Location::Memory(address) => Operation::Load {
                        dst: register,
                        address,
                        width,
                    },
                })
            }
        }
        0xc6 | 0xc7 => {
            let width = byte_or_wide(opcode, wide);
            let operands = ModRm::read(cursor, rex)?;
            if operands.selector != 0 {
                return Err(DecodeError::Unsupported);
            }
            let destination = operands.location(cursor, rex, width)?;
            let value = immediate(cursor, width, false)?;
            Ok(move_to(destination, DataOperand::Immediate(value), width))
        }
        0xa0..=0xa3 => {
            let width = byte_or_wide(opcode, wide);
            let address = Address {
                base: AddressBase::None,
                index: None,
                displacement: cursor.unsigned(8)? as i64,
            };
            if opcode & 2 == 0 {
                Ok(Operation::Load {
                    dst: RegisterView::low(0),
                    address,
                    width,
                })
            } else {
                Ok(Operation::Store {
                    src: DataOperand::Register(RegisterView::low(0)),
                    address,
                    width,
                })
            }
        }
        0x8d => {
            let operands = ModRm::read(cursor, rex)?;
            if operands.mode == 3 {
                return Err(DecodeError::Invalid);
            }
            Ok(Operation::Lea {
                dst: rex.view(operands.register, wide),
                address: operands.address(cursor, rex)?,
                width: wide,
            })
        }
        0x00..=0x05
        | 0x08..=0x0d
        | 0x10..=0x15
        | 0x18..=0x1d
        | 0x20..=0x25
        | 0x28..=0x2d
        | 0x30..=0x35
        | 0x38..=0x3d
        | 0x84
        | 0x85 => {
            let width = byte_or_wide(opcode, wide);
            let kind = if matches!(opcode, 0x84 | 0x85) {
                Alu::Test
            } else {
                selector_kind((opcode >> 3) & 7).expect("admitted arithmetic opcode")
            };
            if opcode & 7 >= 4 && !matches!(opcode, 0x84 | 0x85) {
                return Ok(alu_to(
                    Location::Register(RegisterView::low(0)),
                    kind,
                    DataOperand::Immediate(immediate(cursor, width, false)?),
                    width,
                ));
            }
            let operands = ModRm::read(cursor, rex)?;
            let register = rex.view(operands.register, width);
            let location = operands.location(cursor, rex, width)?;
            if opcode & 2 == 0 || kind == Alu::Test {
                Ok(alu_to(
                    location,
                    kind,
                    DataOperand::Register(register),
                    width,
                ))
            } else {
                Ok(match location {
                    Location::Register(src) => Operation::Alu {
                        kind,
                        dst: register,
                        src: DataOperand::Register(src),
                        width,
                    },
                    Location::Memory(address) => Operation::MemoryAlu {
                        kind,
                        address,
                        operands: MemoryAluOperands::RegisterFirst(register),
                        width,
                    },
                })
            }
        }
        0x80 | 0x81 | 0x83 | 0xf6 | 0xf7 => {
            let width = if matches!(opcode, 0x80 | 0xf6) {
                Width::W8
            } else {
                wide
            };
            let operands = ModRm::read(cursor, rex)?;
            let kind = if matches!(opcode, 0xf6 | 0xf7) {
                match operands.selector {
                    0 => Alu::Test,
                    2 | 3 => {
                        return Ok(Operation::Unary {
                            kind: if operands.selector == 2 {
                                Unary::Not
                            } else {
                                Unary::Neg
                            },
                            dst: operands.location(cursor, rex, width)?,
                            width,
                        });
                    }
                    _ => return Err(DecodeError::Unsupported),
                }
            } else {
                selector_kind(operands.selector).ok_or(DecodeError::Unsupported)?
            };
            let destination = operands.location(cursor, rex, width)?;
            let value = immediate(cursor, width, opcode == 0x83)?;
            Ok(alu_to(
                destination,
                kind,
                DataOperand::Immediate(value),
                width,
            ))
        }
        0xfe => {
            let operands = ModRm::read(cursor, rex)?;
            if operands.selector > 1 {
                return Err(DecodeError::Unsupported);
            }
            Ok(Operation::Unary {
                kind: if operands.selector == 0 {
                    Unary::Inc
                } else {
                    Unary::Dec
                },
                dst: operands.location(cursor, rex, Width::W8)?,
                width: Width::W8,
            })
        }
        0xf8 | 0xf9 | 0xf5 => Ok(Operation::Carry {
            kind: match opcode {
                0xf8 => Carry::Clear,
                0xf9 => Carry::Set,
                _ => Carry::Complement,
            },
        }),
        0x9f => Ok(Operation::Lahf),
        0x9e => Ok(Operation::Sahf),
        0xc0 | 0xc1 | 0xd0..=0xd3 => {
            let width = byte_or_wide(opcode, wide);
            let operands = ModRm::read(cursor, rex)?;
            let kind = match operands.selector {
                0 => Shift::Rol,
                1 => Shift::Ror,
                2 => Shift::Rcl,
                3 => Shift::Rcr,
                4 => Shift::Shl,
                5 => Shift::Shr,
                7 => Shift::Sar,
                _ => return Err(DecodeError::Unsupported),
            };
            let dst = operands.location(cursor, rex, width)?;
            let count = match opcode {
                0xc0 | 0xc1 => Count::Immediate(cursor.byte()?),
                0xd0 | 0xd1 => Count::Immediate(1),
                _ => Count::Cl,
            };
            Ok(Operation::Shift {
                kind,
                dst,
                count,
                width,
            })
        }
        0xa8 | 0xa9 => {
            let width = byte_or_wide(opcode, wide);
            Ok(alu_to(
                Location::Register(RegisterView::low(0)),
                Alu::Test,
                DataOperand::Immediate(immediate(cursor, width, false)?),
                width,
            ))
        }
        0x63 => {
            let source_width = if wide == Width::W64 { Width::W32 } else { wide };
            let operands = ModRm::read(cursor, rex)?;
            Ok(Operation::Extend {
                dst: rex.view(operands.register, wide),
                src: operands.location(cursor, rex, source_width)?,
                source_width,
                width: wide,
                signed: true,
            })
        }
        0x98 => Ok(Operation::Extend {
            dst: RegisterView::low(0),
            src: Location::Register(RegisterView::low(0)),
            source_width: match wide {
                Width::W16 => Width::W8,
                Width::W32 => Width::W16,
                Width::W64 => Width::W32,
                Width::W8 => unreachable!(),
            },
            width: wide,
            signed: true,
        }),
        0x99 => Ok(Operation::SignHigh { width: wide }),
        0x0f => two_byte(cursor.byte()?, prefixes, cursor),
        0xeb | 0xe9 | 0x70..=0x7f => {
            if rex.present {
                return Err(DecodeError::Unsupported);
            }
            branch(opcode, cursor)
        }
        _ => Err(DecodeError::Unsupported),
    }
}

fn byte_or_wide(opcode: u8, wide: Width) -> Width {
    if opcode & 1 == 0 {
        Width::W8
    } else {
        wide
    }
}

fn immediate<F>(cursor: &mut Cursor<F>, width: Width, short: bool) -> Result<u64, DecodeError>
where
    F: FnMut(u64) -> Result<u8, Fault>,
{
    let value = if short {
        cursor.byte()? as i8 as i64 as u64
    } else if width == Width::W64 {
        cursor.unsigned(4)? as u32 as i32 as i64 as u64
    } else {
        cursor.unsigned(width.bytes())?
    };
    Ok(value & width.mask())
}

fn move_to(dst: Location, src: DataOperand, width: Width) -> Operation {
    match dst {
        Location::Register(dst) => Operation::Mov { dst, src, width },
        Location::Memory(address) => Operation::Store {
            src,
            address,
            width,
        },
    }
}

fn alu_to(dst: Location, kind: Alu, src: DataOperand, width: Width) -> Operation {
    match dst {
        Location::Register(dst) => Operation::Alu {
            kind,
            dst,
            src,
            width,
        },
        Location::Memory(address) => Operation::MemoryAlu {
            kind,
            address,
            operands: MemoryAluOperands::MemoryFirst(src),
            width,
        },
    }
}

fn selector_kind(selector: u8) -> Option<Alu> {
    match selector {
        0 => Some(Alu::Add),
        1 => Some(Alu::Or),
        2 => Some(Alu::Adc),
        3 => Some(Alu::Sbb),
        4 => Some(Alu::And),
        5 => Some(Alu::Sub),
        6 => Some(Alu::Xor),
        7 => Some(Alu::Cmp),
        _ => None,
    }
}

fn two_byte<F>(
    opcode: u8,
    prefixes: Prefixes,
    cursor: &mut Cursor<F>,
) -> Result<Operation, DecodeError>
where
    F: FnMut(u64) -> Result<u8, Fault>,
{
    let rex = prefixes.rex;
    let width = prefixes.width();
    match opcode {
        0xa3 | 0xab | 0xb3 | 0xbb => {
            let operands = ModRm::read(cursor, rex)?;
            Ok(Operation::Bit {
                kind: match opcode {
                    0xa3 => Bit::Test,
                    0xab => Bit::Set,
                    0xb3 => Bit::Reset,
                    0xbb => Bit::Complement,
                    _ => unreachable!(),
                },
                dst: operands.location(cursor, rex, width)?,
                index: BitIndex::Register(rex.view(operands.register, width)),
                width,
            })
        }
        0xba => {
            let operands = ModRm::read(cursor, rex)?;
            let kind = match operands.selector {
                4 => Bit::Test,
                5 => Bit::Set,
                6 => Bit::Reset,
                7 => Bit::Complement,
                _ => return Err(DecodeError::Unsupported),
            };
            let dst = operands.location(cursor, rex, width)?;
            Ok(Operation::Bit {
                kind,
                dst,
                index: BitIndex::Immediate(cursor.byte()?),
                width,
            })
        }
        0xbc | 0xbd => {
            let operands = ModRm::read(cursor, rex)?;
            Ok(Operation::Scan {
                reverse: opcode == 0xbd,
                dst: rex.view(operands.register, width),
                src: operands.location(cursor, rex, width)?,
                width,
            })
        }
        0xc8..=0xcf => {
            if width == Width::W16 {
                return Err(DecodeError::Unsupported);
            }
            Ok(Operation::Bswap {
                dst: rex.view((opcode - 0xc8) | rex.base_extension(), width),
                width,
            })
        }
        0xa4 | 0xa5 | 0xac | 0xad => {
            let operands = ModRm::read(cursor, rex)?;
            let dst = operands.location(cursor, rex, width)?;
            let count = if opcode & 1 == 0 {
                Count::Immediate(cursor.byte()?)
            } else {
                Count::Cl
            };
            Ok(Operation::DoubleShift {
                kind: if opcode & 8 == 0 {
                    DoubleShift::Left
                } else {
                    DoubleShift::Right
                },
                dst,
                src: rex.view(operands.register, width),
                count,
                width,
            })
        }
        0xb6 | 0xb7 | 0xbe | 0xbf => {
            let source_width = byte_or_wide(opcode, Width::W16);
            if source_width == Width::W16 && width == Width::W16 {
                return Err(DecodeError::Unsupported);
            }
            let operands = ModRm::read(cursor, rex)?;
            Ok(Operation::Extend {
                dst: rex.view(operands.register, width),
                src: operands.location(cursor, rex, source_width)?,
                source_width,
                width,
                signed: opcode & 8 != 0,
            })
        }
        0x40..=0x4f => {
            let operands = ModRm::read(cursor, rex)?;
            Ok(Operation::Cmov {
                dst: rex.view(operands.register, width),
                src: operands.location(cursor, rex, width)?,
                width,
                condition: condition(opcode),
            })
        }
        0x90..=0x9f => {
            let operands = ModRm::read(cursor, rex)?;
            Ok(Operation::Setcc {
                dst: operands.location(cursor, rex, Width::W8)?,
                condition: condition(opcode),
            })
        }
        0x80..=0x8f if !rex.present && !prefixes.operand16 => branch(opcode, cursor),
        _ => Err(DecodeError::Unsupported),
    }
}

fn branch<F>(opcode: u8, cursor: &mut Cursor<F>) -> Result<Operation, DecodeError>
where
    F: FnMut(u64) -> Result<u8, Fault>,
{
    let displacement = if matches!(opcode, 0xeb | 0x70..=0x7f) {
        i64::from(cursor.byte()? as i8)
    } else {
        i64::from(cursor.unsigned(4)? as u32 as i32)
    };
    let target = cursor.next_pc().wrapping_add(displacement as u64);
    if matches!(opcode, 0xe9 | 0xeb) {
        Ok(Operation::Jump { target })
    } else {
        Ok(Operation::Jcc {
            condition: condition(opcode),
            target,
        })
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
