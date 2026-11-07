use super::{DecodeError, cursor::Cursor, operand::ModRm, prefix::Prefixes};
use crate::x86::float::{Format, Kind, Op};
use crate::x86::instruction::{FloatInstruction, Location, Operation, RegisterView, Width};

pub(super) fn refine<F>(
    opcode: u8,
    prefixes: Prefixes,
    cursor: &mut Cursor<F>,
) -> Option<Result<Operation, DecodeError>>
where
    F: FnMut(u64) -> Result<u8, DecodeError>,
{
    let mandatory = prefixes
        .repeat
        .or(prefixes.operand_override.then_some(0x66));
    if opcode == 0xae && mandatory.is_none() {
        return Some(mxcsr(prefixes, cursor));
    }
    let scalar = matches!(mandatory, Some(0xf2 | 0xf3));
    let format = if matches!(mandatory, Some(0x66 | 0xf2)) {
        Format::F64
    } else {
        Format::F32
    };
    let mut op = Op {
        kind: Kind::Add,
        format,
        scalar,
        integer64: false,
        predicate: 0,
    };
    use Kind::*;
    op.kind = match opcode {
        0x58 => Add,
        0x5c => Sub,
        0x59 => Mul,
        0x5e => Div,
        0x51 => Sqrt,
        0x5d => Min,
        0x5f => Max,
        0xc2 => Cmp,
        0x2f if !scalar => {
            op.scalar = true;
            Comi
        }
        0x2e if !scalar => {
            op.scalar = true;
            Ucomi
        }
        0x53 if format == Format::F32 => Rcp,
        0x52 if format == Format::F32 => Rsqrt,
        0x5a => FloatConvert,
        0x5b if mandatory.is_none() => {
            op.format = Format::F32;
            IntToFloat
        }
        0x5b if mandatory == Some(0x66) => {
            op.format = Format::F32;
            FloatToInt
        }
        0x5b if mandatory == Some(0xf3) => {
            op.format = Format::F32;
            op.scalar = false;
            TruncToInt
        }
        0xe6 if mandatory == Some(0xf3) => {
            op.format = Format::F64;
            op.scalar = false;
            IntToFloat
        }
        0xe6 if mandatory == Some(0xf2) => {
            op.format = Format::F64;
            op.scalar = false;
            FloatToInt
        }
        0xe6 if mandatory == Some(0x66) => {
            op.format = Format::F64;
            TruncToInt
        }
        0x2a if scalar => IntToFloat,
        0x2d if scalar => FloatToInt,
        0x2c if scalar => TruncToInt,
        _ => return None,
    };
    Some(decode(op, prefixes, cursor))
}

fn mxcsr<F>(prefixes: Prefixes, cursor: &mut Cursor<F>) -> Result<Operation, DecodeError>
where
    F: FnMut(u64) -> Result<u8, DecodeError>,
{
    let operands = ModRm::read(cursor, prefixes.rex)?;
    if !matches!(operands.selector, 2 | 3) {
        return Err(DecodeError::Unsupported);
    }
    if operands.mode == 3 {
        return Err(DecodeError::Invalid);
    }
    Ok(Operation::Mxcsr {
        address: operands.address(cursor, prefixes)?,
        store: operands.selector == 3,
    })
}

fn decode<F>(
    mut op: Op,
    prefixes: Prefixes,
    cursor: &mut Cursor<F>,
) -> Result<Operation, DecodeError>
where
    F: FnMut(u64) -> Result<u8, DecodeError>,
{
    let operands = ModRm::read(cursor, prefixes.rex)?;
    op.integer64 = op.scalar
        && matches!(
            op.kind,
            Kind::IntToFloat | Kind::FloatToInt | Kind::TruncToInt
        )
        && prefixes.rex.width() == Width::W64;
    let source_is_gpr = op.scalar && op.kind == Kind::IntToFloat;
    let src = if source_is_gpr {
        operands.location(
            cursor,
            prefixes,
            if op.integer64 { Width::W64 } else { Width::W32 },
        )?
    } else if operands.mode == 3 {
        Location::Register(RegisterView::low(operands.rm))
    } else {
        Location::Memory(operands.address(cursor, prefixes)?)
    };
    if op.kind == Kind::Cmp {
        op.predicate = cursor.byte()?;
    }
    Ok(Operation::Float(FloatInstruction {
        op,
        dst: operands.register,
        src,
    }))
}
