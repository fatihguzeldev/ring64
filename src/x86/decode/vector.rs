use super::{DecodeError, cursor::Cursor, operand::ModRm, prefix::Prefixes};
use crate::x86::instruction::{
    VectorBinary, VectorCount, VectorInstruction, VectorMask, VectorOperand, VectorShift,
    VectorShuffle, Width,
};

#[derive(Clone, Copy)]
enum Form {
    HalfMove {
        high: bool,
        store: bool,
        memory_only: bool,
    },
    Move {
        bytes: u8,
        merge: bool,
        aligned: bool,
        store: bool,
    },
    ToXmm,
    FromXmm,
    Binary(VectorBinary),
    Shuffle(VectorShuffle),
    VariableShift(VectorShift),
    ImmediateShift(u8),
    InsertWord,
    ExtractWord,
    Mask(VectorMask),
}

pub(super) fn refine<F>(
    opcode: u8,
    prefixes: Prefixes,
    cursor: &mut Cursor<F>,
) -> Option<Result<VectorInstruction, DecodeError>>
where
    F: FnMut(u64) -> Result<u8, DecodeError>,
{
    use VectorBinary as B;
    use Width::*;
    // Group-one refining prefixes override 66; physical REX cancellation
    // remains the prefix scanner's responsibility.
    let mandatory = prefixes
        .repeat
        .or(prefixes.operand_override.then_some(0x66));
    let form = match (mandatory, opcode) {
        (None | Some(0x66), 0x54..=0x57) => Form::Binary(match opcode {
            0x54 => B::And,
            0x55 => B::AndNot,
            0x56 => B::Or,
            _ => B::Xor,
        }),
        (None | Some(0x66), 0x14 | 0x15) => Form::Binary(if opcode == 0x14 {
            B::UnpackLow(if mandatory.is_some() { W64 } else { W32 })
        } else {
            B::UnpackHigh(if mandatory.is_some() { W64 } else { W32 })
        }),
        (None | Some(0x66), 0x12 | 0x13 | 0x16 | 0x17) => Form::HalfMove {
            high: opcode >= 0x16,
            store: opcode & 1 != 0,
            memory_only: mandatory.is_some() || opcode & 1 != 0,
        },
        (None | Some(0x66), 0x10 | 0x11) => Form::Move {
            bytes: 16,
            merge: false,
            aligned: false,
            store: opcode == 0x11,
        },
        (Some(0xf2 | 0xf3), 0x10 | 0x11) => Form::Move {
            bytes: if mandatory == Some(0xf3) { 4 } else { 8 },
            merge: true,
            aligned: false,
            store: opcode == 0x11,
        },
        (None | Some(0x66), 0x28 | 0x29) => Form::Move {
            bytes: 16,
            merge: false,
            aligned: true,
            store: opcode == 0x29,
        },
        (Some(0x66 | 0xf3), 0x6f | 0x7f) => Form::Move {
            bytes: 16,
            merge: false,
            aligned: mandatory == Some(0x66),
            store: opcode == 0x7f,
        },
        (Some(0xf3), 0x7e) => Form::Move {
            bytes: 8,
            merge: false,
            aligned: false,
            store: false,
        },
        (Some(0x66), 0xd6) => Form::Move {
            bytes: 8,
            merge: false,
            aligned: false,
            store: true,
        },
        (Some(0x66), 0x6e) => Form::ToXmm,
        (Some(0x66), 0x7e) => Form::FromXmm,
        (Some(0x66), 0xc4) => Form::InsertWord,
        (Some(0x66), 0xc5) => Form::ExtractWord,
        (Some(0x66), 0xd7) => Form::Mask(VectorMask::Bytes),
        (None, 0x50) => Form::Mask(VectorMask::Singles),
        (Some(0x66), 0x50) => Form::Mask(VectorMask::Doubles),
        (Some(0x66), 0x70) => Form::Shuffle(VectorShuffle::Dwords),
        (Some(0xf2), 0x70) => Form::Shuffle(VectorShuffle::LowWords),
        (Some(0xf3), 0x70) => Form::Shuffle(VectorShuffle::HighWords),
        (None, 0xc6) => Form::Shuffle(VectorShuffle::RawSingles),
        (Some(0x66), 0xc6) => Form::Shuffle(VectorShuffle::RawDoubles),
        (Some(0x66), 0x71..=0x73) => Form::ImmediateShift(opcode),
        (Some(0x66), 0xd1) => Form::VariableShift(VectorShift::Right(W16)),
        (Some(0x66), 0xd2) => Form::VariableShift(VectorShift::Right(W32)),
        (Some(0x66), 0xd3) => Form::VariableShift(VectorShift::Right(W64)),
        (Some(0x66), 0xe1) => Form::VariableShift(VectorShift::ArithmeticRight(W16)),
        (Some(0x66), 0xe2) => Form::VariableShift(VectorShift::ArithmeticRight(W32)),
        (Some(0x66), 0xf1) => Form::VariableShift(VectorShift::Left(W16)),
        (Some(0x66), 0xf2) => Form::VariableShift(VectorShift::Left(W32)),
        (Some(0x66), 0xf3) => Form::VariableShift(VectorShift::Left(W64)),
        (Some(0x66), opcode) => Form::Binary(match opcode {
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
            0x6c => B::UnpackLow(W64),
            0x68 => B::UnpackHigh(W8),
            0x69 => B::UnpackHigh(W16),
            0x6a => B::UnpackHigh(W32),
            0x6d => B::UnpackHigh(W64),
            _ => return None,
        }),
        _ => return None,
    };
    Some(decode(form, prefixes, cursor))
}

fn location<F>(
    operands: &ModRm,
    prefixes: Prefixes,
    cursor: &mut Cursor<F>,
) -> Result<VectorOperand, DecodeError>
where
    F: FnMut(u64) -> Result<u8, DecodeError>,
{
    Ok(if operands.mode == 3 {
        VectorOperand::Register(operands.rm)
    } else {
        VectorOperand::Memory(operands.address(cursor, prefixes)?)
    })
}

fn register_only(operands: &ModRm) -> Result<(), DecodeError> {
    if operands.mode == 3 {
        Ok(())
    } else {
        Err(DecodeError::Invalid)
    }
}

fn decode<F>(
    form: Form,
    prefixes: Prefixes,
    cursor: &mut Cursor<F>,
) -> Result<VectorInstruction, DecodeError>
where
    F: FnMut(u64) -> Result<u8, DecodeError>,
{
    use VectorInstruction as V;
    let operands = ModRm::read(cursor, prefixes.rex)?;
    let reg = operands.register;
    Ok(match form {
        Form::HalfMove {
            high,
            store,
            memory_only,
        } => {
            if memory_only && operands.mode == 3 {
                return Err(DecodeError::Invalid);
            }
            V::HalfMove {
                register: reg,
                operand: location(&operands, prefixes, cursor)?,
                high,
                store,
            }
        }
        Form::Move {
            bytes,
            merge,
            aligned,
            store,
        } => V::Move {
            register: reg,
            operand: location(&operands, prefixes, cursor)?,
            bytes,
            preserve_upper: merge && operands.mode == 3,
            aligned,
            store,
        },
        Form::ToXmm | Form::FromXmm => {
            let width = if prefixes.rex.width() == Width::W64 {
                Width::W64
            } else {
                Width::W32
            };
            let rm = operands.location(cursor, prefixes, width)?;
            if matches!(form, Form::ToXmm) {
                V::ToXmm {
                    dst: reg,
                    src: rm,
                    width,
                }
            } else {
                V::FromXmm {
                    dst: rm,
                    src: reg,
                    width,
                }
            }
        }
        Form::Binary(kind) => V::Binary {
            kind,
            dst: reg,
            src: location(&operands, prefixes, cursor)?,
        },
        Form::Shuffle(kind) => {
            let src = location(&operands, prefixes, cursor)?;
            V::Shuffle {
                kind,
                dst: reg,
                src,
                immediate: cursor.byte()?,
            }
        }
        Form::VariableShift(kind) => V::Shift {
            kind,
            dst: reg,
            count: VectorCount::Vector(location(&operands, prefixes, cursor)?),
        },
        Form::ImmediateShift(opcode) => {
            use VectorShift::*;
            use Width::*;
            let width = match opcode {
                0x71 => W16,
                0x72 => W32,
                _ => W64,
            };
            let kind = match operands.selector {
                2 => Right(width),
                4 if opcode != 0x73 => ArithmeticRight(width),
                6 => Left(width),
                3 if opcode == 0x73 => ByteRight,
                7 if opcode == 0x73 => ByteLeft,
                _ => return Err(DecodeError::Unsupported),
            };
            register_only(&operands)?;
            V::Shift {
                kind,
                dst: operands.rm,
                count: VectorCount::Immediate(cursor.byte()?),
            }
        }
        Form::InsertWord => {
            let src = operands.location(cursor, prefixes, Width::W16)?;
            V::InsertWord {
                dst: reg,
                src,
                immediate: cursor.byte()?,
            }
        }
        Form::ExtractWord => {
            register_only(&operands)?;
            V::ExtractWord {
                dst: reg,
                src: operands.rm,
                immediate: cursor.byte()?,
            }
        }
        Form::Mask(kind) => {
            register_only(&operands)?;
            V::Mask {
                kind,
                dst: reg,
                src: operands.rm,
            }
        }
    })
}
