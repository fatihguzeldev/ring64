use crate::x86::context::{Mode, Segment};
use crate::x86::instruction::{
    Address, AddressBase, Alu, Bit, BitIndex, Carry, Condition, Count, CountCondition, DataOperand,
    DoubleShift, Location, MemoryAluOperands, Operand, Operation, RegisterView, Repeat, Shift,
    StringKind, Unary, Width,
};

use super::{DecodeError, cursor::Cursor, operand::ModRm, prefix::Prefixes};

pub(super) fn refine<F>(
    opcode: u8,
    prefixes: Prefixes,
    cursor: &mut Cursor<F>,
) -> Result<Operation, DecodeError>
where
    F: FnMut(u64) -> Result<u8, DecodeError>,
{
    if opcode == 0xf4 {
        return if prefixes.lock {
            Err(DecodeError::UndefinedEncoding)
        } else {
            Ok(Operation::Halt)
        };
    }
    let operation = refine_inner(opcode, prefixes, cursor)?;
    if prefixes.lock && !lockable(operation) {
        Err(DecodeError::Invalid)
    } else {
        Ok(operation)
    }
}

fn lockable(operation: Operation) -> bool {
    match operation {
        Operation::MemoryAlu {
            kind,
            operands: MemoryAluOperands::MemoryFirst(_),
            ..
        } => kind.writes_result(),
        Operation::Unary {
            dst: Location::Memory(_),
            ..
        }
        | Operation::Exchange {
            dst: Location::Memory(_),
            ..
        }
        | Operation::Xadd {
            dst: Location::Memory(_),
            ..
        }
        | Operation::CompareExchange {
            dst: Location::Memory(_),
            ..
        }
        | Operation::CompareExchange8b { .. } => true,
        Operation::Bit {
            kind,
            dst: Location::Memory(_),
            ..
        } => kind.writes_result(),
        _ => false,
    }
}

fn refine_inner<F>(
    opcode: u8,
    prefixes: Prefixes,
    cursor: &mut Cursor<F>,
) -> Result<Operation, DecodeError>
where
    F: FnMut(u64) -> Result<u8, DecodeError>,
{
    if let Some(result) = super::io::refine(opcode, prefixes, cursor) {
        return result;
    }
    if let Some(result) = super::software_events::one_byte(opcode, prefixes, cursor) {
        return result;
    }
    if let Some(result) = super::system_flags::one_byte(opcode, prefixes) {
        return result;
    }
    if let Some(result) = super::far::one_byte(opcode, prefixes, cursor) {
        return result;
    }
    if let Some(result) = super::protection::one_byte(opcode, prefixes, cursor) {
        return result;
    }
    if matches!(opcode, 0x9b | 0xd8..=0xdf) {
        return super::x87::refine(opcode, prefixes, cursor);
    }
    let string_kind = match opcode {
        0xa4 | 0xa5 => Some(StringKind::Movs),
        0xaa | 0xab => Some(StringKind::Stos),
        0xac | 0xad => Some(StringKind::Lods),
        0xa6 | 0xa7 => Some(StringKind::Cmps),
        0xae | 0xaf => Some(StringKind::Scas),
        _ => None,
    };
    if prefixes.lock
        && !matches!(opcode,
            0x00..=0x05 | 0x08..=0x0d | 0x0f | 0x10..=0x15 | 0x18..=0x1d
            | 0x20..=0x25 | 0x28..=0x2d | 0x30..=0x35 | 0x38..=0x3d
            | 0x50..=0x5f | 0x68 | 0x6a | 0x80 | 0x81 | 0x83..=0x87 | 0x8f | 0x90..=0x97
            | 0xc2 | 0xc3 | 0xc9 | 0xe0..=0xe3 | 0xe8 | 0xf6 | 0xf7 | 0xfe | 0xff)
    {
        return Err(if string_kind.is_some() || matches!(opcode, 0xfc | 0xfd) {
            DecodeError::Invalid
        } else {
            DecodeError::Unsupported
        });
    }
    if let Some(kind) = string_kind {
        let comparison = matches!(kind, StringKind::Cmps | StringKind::Scas);
        let repeat = match prefixes.repeat {
            None => Repeat::None,
            Some(0xf3) if comparison => Repeat::WhileEqual,
            Some(0xf2) if comparison => Repeat::WhileNotEqual,
            Some(0xf3) => Repeat::Count,
            _ => return Err(DecodeError::Unsupported),
        };
        return Ok(Operation::String {
            kind,
            width: byte_or_wide(opcode, prefixes.width()),
            address_width: prefixes.address_width(),
            source_segment: prefixes.segment_override.unwrap_or(Segment::Ds),
            repeat,
        });
    }
    if opcode == 0x0f {
        return two_byte(cursor.byte()?, prefixes, cursor);
    }
    if opcode == 0x90 && prefixes.repeat == Some(0xf3) {
        return Ok(Operation::Nop);
    }
    if prefixes.repeat.is_some() {
        return Err(DecodeError::Unsupported);
    }
    let rex = prefixes.rex;
    let wide = prefixes.width();
    let stack_width = prefixes.stack_width();
    let near_width = prefixes.near_width();
    match opcode {
        0x86 | 0x87 => {
            let width = byte_or_wide(opcode, wide);
            let operands = ModRm::read(cursor, rex)?;
            Ok(Operation::Exchange {
                dst: operands.location(cursor, prefixes, width)?,
                src: rex.view(operands.register, width),
                width,
            })
        }
        0x90..=0x97 => {
            let bank = (opcode - 0x90) | rex.base_extension();
            Ok(if bank == 0 {
                Operation::Nop
            } else {
                Operation::Exchange {
                    dst: Location::Register(RegisterView::low(bank)),
                    src: RegisterView::low(0),
                    width: wide,
                }
            })
        }
        0xfc | 0xfd => Ok(Operation::Direction {
            set: opcode == 0xfd,
        }),
        0x50..=0x57 => Ok(Operation::Push {
            src: Operand::Register((opcode - 0x50) | rex.base_extension()),
            width: stack_width,
        }),
        0x58..=0x5f => Ok(Operation::Pop {
            dst: (opcode - 0x58) | rex.base_extension(),
            width: stack_width,
        }),
        0x68 | 0x6a => Ok(Operation::Push {
            src: Operand::Immediate(immediate(cursor, stack_width, opcode == 0x6a)?),
            width: stack_width,
        }),
        0x8f => {
            let operands = ModRm::read(cursor, rex)?;
            if operands.selector != 0 {
                return Err(DecodeError::Unsupported);
            }
            Ok(match operands.location(cursor, prefixes, stack_width)? {
                Location::Register(register) => Operation::Pop {
                    dst: register.bank,
                    width: stack_width,
                },
                Location::Memory(address) => Operation::PopMemory {
                    address,
                    width: stack_width,
                },
            })
        }
        0xc9 => Ok(Operation::Leave { width: stack_width }),
        0x40..=0x4f => Ok(Operation::Unary {
            kind: if opcode < 0x48 {
                Unary::Inc
            } else {
                Unary::Dec
            },
            dst: Location::Register(RegisterView::low(opcode & 7)),
            width: wide,
        }),
        0x60 | 0x61 => Err(if prefixes.long64 {
            DecodeError::Invalid
        } else {
            DecodeError::Unsupported
        }),
        0x69 | 0x6b => {
            let operands = ModRm::read(cursor, rex)?;
            let src = operands.location(cursor, prefixes, wide)?;
            Ok(Operation::Imul {
                dst: rex.view(operands.register, wide),
                src,
                immediate: Some(immediate(cursor, wide, opcode == 0x6b)?),
                width: wide,
            })
        }
        0xe8 => {
            let displacement = relative_displacement(cursor, near_width)?;
            Ok(Operation::Call {
                target: Operand::Immediate(
                    cursor.next_pc().wrapping_add(displacement as u64) & near_width.mask(),
                ),
                width: near_width,
            })
        }
        0xe0..=0xe3 => {
            let displacement = i64::from(cursor.byte()? as i8);
            Ok(Operation::CountBranch {
                condition: match opcode {
                    0xe0 => CountCondition::NotEqual,
                    0xe1 => CountCondition::Equal,
                    0xe2 => CountCondition::Always,
                    _ => CountCondition::Zero,
                },
                count_width: prefixes.address_width(),
                target: cursor.next_pc().wrapping_add(displacement as u64) & near_width.mask(),
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
                    dst: operands.location(cursor, prefixes, wide)?,
                    width: wide,
                });
            }
            match operands.selector {
                3 | 5 => super::far::memory(&operands, prefixes, cursor),
                2 => Ok(Operation::Call {
                    target: stack_operand(operands.location(cursor, prefixes, near_width)?),
                    width: near_width,
                }),
                4 => Ok(match operands.location(cursor, prefixes, near_width)? {
                    Location::Register(register) => Operation::JumpRegister {
                        target: register.bank,
                        width: near_width,
                    },
                    Location::Memory(address) => Operation::JumpMemory {
                        address,
                        width: near_width,
                    },
                }),
                6 => Ok(Operation::Push {
                    src: stack_operand(operands.location(cursor, prefixes, stack_width)?),
                    width: stack_width,
                }),
                _ => Err(DecodeError::Unsupported),
            }
        }
        0xc3 => Ok(Operation::Return {
            cleanup: 0,
            width: near_width,
        }),
        0xc2 => Ok(Operation::Return {
            cleanup: cursor.unsigned(2)? as u16,
            width: near_width,
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
            let location = operands.location(cursor, prefixes, width)?;
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
            let destination = operands.location(cursor, prefixes, width)?;
            let value = immediate(cursor, width, false)?;
            Ok(move_to(destination, DataOperand::Immediate(value), width))
        }
        0xa0..=0xa3 => {
            let width = byte_or_wide(opcode, wide);
            let address = Address {
                base: AddressBase::None,
                index: None,
                displacement: cursor.unsigned(prefixes.address_width().bytes())? as i64,
                size: prefixes.address_width(),
                segment: prefixes.segment_override.unwrap_or(Segment::Ds),
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
                address: operands.address(cursor, prefixes)?,
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
            let location = operands.location(cursor, prefixes, width)?;
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
                            dst: operands.location(cursor, prefixes, width)?,
                            width,
                        });
                    }
                    4 | 5 => {
                        return Ok(Operation::Multiply {
                            signed: operands.selector == 5,
                            src: operands.location(cursor, prefixes, width)?,
                            width,
                        });
                    }
                    6 | 7 => {
                        return Ok(Operation::Divide {
                            signed: operands.selector == 7,
                            src: operands.location(cursor, prefixes, width)?,
                            width,
                        });
                    }
                    _ => return Err(DecodeError::Unsupported),
                }
            } else {
                selector_kind(operands.selector).ok_or(DecodeError::Unsupported)?
            };
            let destination = operands.location(cursor, prefixes, width)?;
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
                dst: operands.location(cursor, prefixes, Width::W8)?,
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
            let dst = operands.location(cursor, prefixes, width)?;
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
            if !prefixes.long64 {
                return Err(if matches!(prefixes.mode, Mode::Real | Mode::Virtual8086) {
                    DecodeError::Invalid
                } else {
                    DecodeError::Unsupported
                });
            }
            let source_width = if wide == Width::W64 { Width::W32 } else { wide };
            let operands = ModRm::read(cursor, rex)?;
            Ok(Operation::Extend {
                dst: rex.view(operands.register, wide),
                src: operands.location(cursor, prefixes, source_width)?,
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
        0xeb | 0xe9 | 0x70..=0x7f => branch(opcode, prefixes, cursor),
        _ => Err(DecodeError::Unsupported),
    }
}

fn byte_or_wide(opcode: u8, wide: Width) -> Width {
    if opcode & 1 == 0 { Width::W8 } else { wide }
}

fn immediate<F>(cursor: &mut Cursor<F>, width: Width, short: bool) -> Result<u64, DecodeError>
where
    F: FnMut(u64) -> Result<u8, DecodeError>,
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
    F: FnMut(u64) -> Result<u8, DecodeError>,
{
    if let Some(result) = super::paging::two_byte(opcode, prefixes, cursor) {
        return result;
    }
    if matches!(opcode, 0x21 | 0x23) {
        if prefixes.repeat.is_some() {
            return Err(DecodeError::Unsupported);
        }
        let byte = cursor.byte()?;
        let register = (byte >> 3) & 7;
        if prefixes.lock
            || prefixes.rex.reg_extension() != 0
            || !prefixes.paged && matches!(register, 4 | 5)
        {
            return Err(DecodeError::Invalid);
        }
        return Ok(Operation::DebugRegister {
            register,
            gpr: (byte & 7) | prefixes.rex.base_extension(),
            write: opcode == 0x23,
            width: if prefixes.long64 {
                Width::W64
            } else {
                Width::W32
            },
        });
    }
    if opcode == 0x0b && prefixes.repeat.is_none() {
        return Err(DecodeError::Undefined);
    }
    if let Some(result) = super::protection::two_byte(opcode, prefixes, cursor) {
        return result;
    }
    if let Some(result) = super::streaming::refine(opcode, prefixes, cursor) {
        return result;
    }
    if let Some(result) = super::mmx::refine(opcode, prefixes, cursor) {
        return result;
    }
    if let Some(result) = super::float::refine(opcode, prefixes, cursor) {
        return result;
    }
    if let Some(result) = super::vector::refine(opcode, prefixes, cursor) {
        return result.map(Operation::Vector);
    }
    if prefixes.repeat.is_some() {
        return Err(DecodeError::Unsupported);
    }
    let rex = prefixes.rex;
    let width = prefixes.width();
    if prefixes.lock
        && !matches!(
            opcode,
            0xa3 | 0xab | 0xb3 | 0xbb | 0xba | 0xb0 | 0xb1 | 0xc0 | 0xc1 | 0xc7
        )
    {
        return Err(DecodeError::Unsupported);
    }
    match opcode {
        0xb0 | 0xb1 | 0xc0 | 0xc1 => {
            let width = byte_or_wide(opcode, width);
            let operands = ModRm::read(cursor, rex)?;
            let dst = operands.location(cursor, prefixes, width)?;
            let src = rex.view(operands.register, width);
            Ok(if opcode & 0xf0 == 0xb0 {
                Operation::CompareExchange { dst, src, width }
            } else {
                Operation::Xadd { dst, src, width }
            })
        }
        0xc7 => {
            let operands = ModRm::read(cursor, rex)?;
            if operands.selector != 1 {
                return Err(DecodeError::Unsupported);
            }
            if operands.mode == 3 {
                return Err(DecodeError::Invalid);
            }
            if width == Width::W64 {
                return Err(DecodeError::Unsupported);
            }
            Ok(Operation::CompareExchange8b {
                address: operands.address(cursor, prefixes)?,
            })
        }
        0xaf => {
            let operands = ModRm::read(cursor, rex)?;
            Ok(Operation::Imul {
                dst: rex.view(operands.register, width),
                src: operands.location(cursor, prefixes, width)?,
                immediate: None,
                width,
            })
        }
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
                dst: operands.location(cursor, prefixes, width)?,
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
            let dst = operands.location(cursor, prefixes, width)?;
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
                src: operands.location(cursor, prefixes, width)?,
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
            let dst = operands.location(cursor, prefixes, width)?;
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
                src: operands.location(cursor, prefixes, source_width)?,
                source_width,
                width,
                signed: opcode & 8 != 0,
            })
        }
        0x40..=0x4f => {
            let operands = ModRm::read(cursor, rex)?;
            Ok(Operation::Cmov {
                dst: rex.view(operands.register, width),
                src: operands.location(cursor, prefixes, width)?,
                width,
                condition: condition(opcode),
            })
        }
        0x90..=0x9f => {
            let operands = ModRm::read(cursor, rex)?;
            Ok(Operation::Setcc {
                dst: operands.location(cursor, prefixes, Width::W8)?,
                condition: condition(opcode),
            })
        }
        0x80..=0x8f => branch(opcode, prefixes, cursor),
        _ => Err(DecodeError::Unsupported),
    }
}

fn stack_operand(location: Location) -> Operand {
    match location {
        Location::Register(register) => Operand::Register(register.bank),
        Location::Memory(address) => Operand::Memory(address),
    }
}

fn relative_displacement<F>(cursor: &mut Cursor<F>, width: Width) -> Result<i64, DecodeError>
where
    F: FnMut(u64) -> Result<u8, DecodeError>,
{
    Ok(if width == Width::W16 {
        i64::from(cursor.unsigned(2)? as u16 as i16)
    } else {
        i64::from(cursor.unsigned(4)? as u32 as i32)
    })
}

fn branch<F>(
    opcode: u8,
    prefixes: Prefixes,
    cursor: &mut Cursor<F>,
) -> Result<Operation, DecodeError>
where
    F: FnMut(u64) -> Result<u8, DecodeError>,
{
    let width = prefixes.near_width();
    let displacement = if matches!(opcode, 0xeb | 0x70..=0x7f) {
        i64::from(cursor.byte()? as i8)
    } else {
        relative_displacement(cursor, width)?
    };
    let target = cursor.next_pc().wrapping_add(displacement as u64) & width.mask();
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
