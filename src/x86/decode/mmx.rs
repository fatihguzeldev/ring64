use super::{DecodeError, cursor::Cursor, operand::ModRm, prefix::Prefixes};
use crate::x86::instruction::{Operation, VectorBinary, VectorShift, Width};
use crate::x86::mmx::{Kind, Op};

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
    let kind = match (mandatory, opcode) {
        (None, 0x77) => Kind::Empty,
        (None, 0x6e) => Kind::FromGpr,
        (None, 0x7e) => Kind::ToGpr,
        (None, 0x6f | 0x7f) => Kind::Move,
        (None, 0x70) => Kind::Shuffle,
        (None, 0xc4) => Kind::InsertWord,
        (None, 0xc5) => Kind::ExtractWord,
        (None, 0xd7) => Kind::Mask,
        (Some(0xf2), 0xd6) => Kind::FromXmm,
        (Some(0xf3), 0xd6) => Kind::ToXmm,
        (None, 0x2a) => Kind::PiToPs,
        (Some(0x66), 0x2a) => Kind::PiToPd,
        (None, 0x2c) => Kind::TruncPsToPi,
        (None, 0x2d) => Kind::PsToPi,
        (Some(0x66), 0x2c) => Kind::TruncPdToPi,
        (Some(0x66), 0x2d) => Kind::PdToPi,
        (None, 0x71..=0x73) => Kind::Shift(VectorShift::Left(Width::W16)),
        (None, 0xd1..=0xd3) => Kind::Shift(VectorShift::Right(lane(opcode - 0xd1))),
        (None, 0xe1..=0xe2) => Kind::Shift(VectorShift::ArithmeticRight(lane(opcode - 0xe1))),
        (None, 0xf1..=0xf3) => Kind::Shift(VectorShift::Left(lane(opcode - 0xf1))),
        (None, _) => Kind::Binary(binary(opcode)?),
        _ => return None,
    };
    Some(decode(kind, opcode, prefixes, cursor))
}

fn lane(index: u8) -> Width {
    [Width::W16, Width::W32, Width::W64][usize::from(index)]
}

fn decode<F>(
    kind: Kind,
    opcode: u8,
    prefixes: Prefixes,
    cursor: &mut Cursor<F>,
) -> Result<Operation, DecodeError>
where
    F: FnMut(u64) -> Result<u8, DecodeError>,
{
    let mut op = Op {
        kind,
        dst: 0,
        src: 0,
        memory: false,
        wide: false,
        immediate: 0,
        immediate_count: false,
    };
    if kind == Kind::Empty {
        return Ok(Operation::Mmx { op, address: None });
    }
    let operands = ModRm::read(cursor, prefixes.rex)?;
    if matches!(opcode, 0x71..=0x73) {
        let width = lane(opcode - 0x71);
        op.kind = Kind::Shift(match operands.selector {
            2 => VectorShift::Right(width),
            4 if width != Width::W64 => VectorShift::ArithmeticRight(width),
            6 => VectorShift::Left(width),
            _ => return Err(DecodeError::Unsupported),
        });
        op.immediate_count = true;
        op.dst = operands.rm & 7;
    } else {
        match kind {
            Kind::FromGpr | Kind::InsertWord => {
                op.dst = operands.selector;
                op.src = if operands.mode == 3 { operands.rm } else { 0 };
            }
            Kind::ToGpr => {
                op.dst = if operands.mode == 3 { operands.rm } else { 0 };
                op.src = operands.selector;
                if operands.mode != 3 {
                    op.kind = Kind::Store;
                }
            }
            Kind::Move if opcode == 0x7f => {
                op.dst = operands.rm & 7;
                op.src = operands.selector;
                if operands.mode != 3 {
                    op.kind = Kind::Store;
                    op.dst = 0;
                    op.wide = true;
                }
            }
            Kind::ToXmm | Kind::PiToPs | Kind::PiToPd | Kind::ExtractWord | Kind::Mask => {
                op.dst = operands.register;
                op.src = operands.rm & 7;
            }
            Kind::FromXmm | Kind::PsToPi | Kind::PdToPi | Kind::TruncPsToPi | Kind::TruncPdToPi => {
                op.dst = operands.selector;
                op.src = operands.rm;
            }
            _ => {
                op.dst = operands.selector;
                op.src = operands.rm & 7;
            }
        }
    }
    if matches!(opcode, 0x6e | 0x7e) {
        op.wide = prefixes.long64 && prefixes.rex.width() == Width::W64;
    }
    let register_only = op.immediate_count
        || matches!(
            kind,
            Kind::ExtractWord | Kind::Mask | Kind::FromXmm | Kind::ToXmm
        );
    if register_only && operands.mode != 3 {
        return Err(DecodeError::Invalid);
    }
    op.memory = operands.mode != 3;
    let address = if op.memory {
        op.src = if op.is_store() { op.src } else { 0 };
        Some(operands.address(cursor, prefixes)?)
    } else {
        None
    };
    if op.immediate_count || matches!(kind, Kind::Shuffle | Kind::InsertWord | Kind::ExtractWord) {
        op.immediate = cursor.byte()?;
    }
    Ok(Operation::Mmx { op, address })
}

fn binary(opcode: u8) -> Option<VectorBinary> {
    use VectorBinary as B;
    use Width::*;
    Some(match opcode {
        0xdb => B::And,
        0xdf => B::AndNot,
        0xeb => B::Or,
        0xef => B::Xor,
        0xfc => B::Add(W8),
        0xfd => B::Add(W16),
        0xfe => B::Add(W32),
        0xd4 => B::Add(W64),
        0xf8 => B::Sub(W8),
        0xf9 => B::Sub(W16),
        0xfa => B::Sub(W32),
        0xfb => B::Sub(W64),
        0xec => B::SignedSaturatingAdd(W8),
        0xed => B::SignedSaturatingAdd(W16),
        0xdc => B::UnsignedSaturatingAdd(W8),
        0xdd => B::UnsignedSaturatingAdd(W16),
        0xe8 => B::SignedSaturatingSub(W8),
        0xe9 => B::SignedSaturatingSub(W16),
        0xd8 => B::UnsignedSaturatingSub(W8),
        0xd9 => B::UnsignedSaturatingSub(W16),
        0x74 => B::CompareEqual(W8),
        0x75 => B::CompareEqual(W16),
        0x76 => B::CompareEqual(W32),
        0x64 => B::CompareGreater(W8),
        0x65 => B::CompareGreater(W16),
        0x66 => B::CompareGreater(W32),
        0xda => B::MinUnsignedByte,
        0xde => B::MaxUnsignedByte,
        0xea => B::MinSignedWord,
        0xee => B::MaxSignedWord,
        0xe0 => B::Average(W8),
        0xe3 => B::Average(W16),
        0xd5 => B::MulLowWord,
        0xe5 => B::MulHighWord { signed: true },
        0xe4 => B::MulHighWord { signed: false },
        0xf4 => B::MulUnsignedDword,
        0xf5 => B::MaddSignedWord,
        0xf6 => B::SumAbsoluteByteDifferences,
        0x63 => B::PackSigned(W16),
        0x6b => B::PackSigned(W32),
        0x67 => B::PackUnsignedWord,
        0x60 => B::UnpackLow(W8),
        0x61 => B::UnpackLow(W16),
        0x62 => B::UnpackLow(W32),
        0x68 => B::UnpackHigh(W8),
        0x69 => B::UnpackHigh(W16),
        0x6a => B::UnpackHigh(W32),
        _ => return None,
    })
}
