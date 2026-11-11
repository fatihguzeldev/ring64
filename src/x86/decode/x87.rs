use super::{DecodeError, cursor::Cursor, operand::ModRm, prefix::Prefixes};
use crate::x86::instruction::{Operation, X87Instruction};
use crate::x86::x87::{Format, Kind, Op};

pub(super) fn refine<F>(
    opcode: u8,
    prefixes: Prefixes,
    cursor: &mut Cursor<F>,
) -> Result<Operation, DecodeError>
where
    F: FnMut(u64) -> Result<u8, DecodeError>,
{
    if opcode == 0x9b {
        return Ok(Operation::X87(X87Instruction {
            op: Op {
                kind: Kind::Wait,
                ..Op::default()
            },
            address: None,
        }));
    }
    let operands = ModRm::read(cursor, prefixes.rex)?;
    if operands.mode != 3 && matches!(opcode, 0xd9 | 0xdd) && matches!(operands.selector, 4 | 6) {
        return super::numeric_image::legacy(opcode, &operands, prefixes, cursor);
    }
    let modrm = (operands.mode << 6) | (operands.selector << 3) | (operands.rm & 7);
    let mut op = if operands.mode == 3 {
        register(opcode, modrm)?
    } else {
        memory(opcode, operands.selector)?
    };
    op.encoding = (u16::from(opcode & 7) << 8) | u16::from(modrm);
    let address = if operands.mode == 3 {
        None
    } else {
        Some(operands.address(cursor, prefixes)?)
    };
    Ok(Operation::X87(X87Instruction { op, address }))
}

fn arithmetic(selector: u8) -> Kind {
    match selector {
        0 => Kind::Add,
        1 => Kind::Mul,
        2 | 3 => Kind::Compare,
        4 => Kind::Sub,
        5 => Kind::SubReverse,
        6 => Kind::Div,
        7 => Kind::DivReverse,
        _ => unreachable!(),
    }
}

fn memory(opcode: u8, selector: u8) -> Result<Op, DecodeError> {
    use Format::*;
    use Kind::*;
    let mut op = Op::default();
    if matches!(opcode, 0xd8 | 0xda | 0xdc | 0xde) {
        op.kind = arithmetic(selector);
        op.format = match opcode {
            0xd8 => F32,
            0xda => I32,
            0xdc => F64,
            _ => I16,
        };
        op.pop = u8::from(selector == 3);
        return Ok(op);
    }
    let (kind, format, pop) = match (opcode, selector) {
        (0xd9, 0) => (Load, F32, 0),
        (0xdd, 0) => (Load, F64, 0),
        (0xdb, 5) => (Load, F80, 0),
        (0xdf, 0) => (Load, I16, 0),
        (0xdb, 0) => (Load, I32, 0),
        (0xdf, 5) => (Load, I64, 0),
        (0xdf, 4) => (Load, Bcd, 0),
        (0xdf, 6) => (Store, Bcd, 1),
        (0xd9, 2 | 3) => (Store, F32, selector - 2),
        (0xdd, 2 | 3) => (Store, F64, selector - 2),
        (0xdb, 7) => (Store, F80, 1),
        (0xdf, 2 | 3) => (Store, I16, selector - 2),
        (0xdb, 2 | 3) => (Store, I32, selector - 2),
        (0xdf, 7) => (Store, I64, 1),
        (0xd9, 5) => (LoadControl, None, 0),
        (0xd9, 7) => (StoreControl, None, 0),
        (0xdd, 7) => (StoreStatus, None, 0),
        _ => return Err(DecodeError::Unsupported),
    };
    Ok(Op {
        kind,
        format,
        pop,
        ..op
    })
}

fn register(opcode: u8, modrm: u8) -> Result<Op, DecodeError> {
    use Kind::*;
    let selector = (modrm >> 3) & 7;
    let index = modrm & 7;
    let mut op = Op {
        format: Format::Register,
        index,
        ..Op::default()
    };
    match opcode {
        0xd8 => {
            op.kind = arithmetic(selector);
            op.pop = u8::from(selector == 3);
        }
        0xdc | 0xde if matches!(selector, 0 | 1 | 4..=7) => {
            op.kind = match selector {
                4 => SubReverse,
                5 => Sub,
                6 => DivReverse,
                7 => Div,
                _ => arithmetic(selector),
            };
            op.dest_index = true;
            op.pop = u8::from(opcode == 0xde);
        }
        0xda | 0xdb if selector < 4 => {
            op.kind = ConditionalMove;
            op.condition = selector + if opcode == 0xdb { 4 } else { 0 };
        }
        0xdb | 0xdf if matches!(selector, 5 | 6) => {
            op.kind = if selector == 5 {
                CompareUnorderedFlags
            } else {
                CompareFlags
            };
            op.pop = u8::from(opcode == 0xdf);
        }
        0xdd if matches!(selector, 0 | 2..=5) => {
            op.kind = match selector {
                0 => Free,
                2 | 3 => Store,
                _ => CompareUnordered,
            };
            op.pop = u8::from(matches!(selector, 3 | 5));
        }
        0xda | 0xde if matches!((opcode, modrm), (0xda, 0xe9) | (0xde, 0xd9)) => {
            op.kind = if opcode == 0xda {
                CompareUnordered
            } else {
                Compare
            };
            op.index = 1;
            op.pop = 2;
        }
        0xd9 if selector < 2 => op.kind = if selector == 0 { Load } else { Exchange },
        0xd9 => {
            op.format = Format::None;
            op.index = 0;
            op.kind = match modrm {
                0xd0 => Nop,
                0xe0 => ChangeSign,
                0xe1 => Abs,
                0xe4 => Test,
                0xe5 => Examine,
                0xe8..=0xee => {
                    op.index = modrm - 0xe8;
                    Constant
                }
                0xf4 => Extract,
                0xf5 => RemainderNearest,
                0xf8 => Remainder,
                0xfd => Scale,
                0xf6 => DecTop,
                0xf7 => IncTop,
                0xfa => Sqrt,
                0xfc => Round,
                _ => return Err(DecodeError::Unsupported),
            };
        }
        0xdb if matches!(modrm, 0xe2 | 0xe3) => {
            op.kind = if modrm == 0xe2 { Clear } else { Init };
            op.format = Format::None;
            op.index = 0;
        }
        0xdf if modrm == 0xe0 => {
            op.kind = StoreStatus;
            op.format = Format::Ax;
            op.index = 0;
        }
        _ => return Err(DecodeError::Unsupported),
    }
    Ok(op)
}
