use super::{DecodeError, cursor::Cursor, operand::ModRm, prefix::Prefixes};
use crate::x86::context::{Mode, Segment};
use crate::x86::instruction::{Operation, ProtectionInstruction, ProtectionKind as Kind, Width};

pub(super) fn one_byte<F>(
    opcode: u8,
    prefixes: Prefixes,
    cursor: &mut Cursor<F>,
) -> Option<Result<Operation, DecodeError>>
where
    F: FnMut(u64) -> Result<u8, DecodeError>,
{
    if !matches!(opcode, 0x8c | 0x8e | 0xc4 | 0xc5) {
        return None;
    }
    if prefixes.long64 && matches!(opcode, 0xc4 | 0xc5) {
        return Some(Err(DecodeError::Unsupported));
    }
    Some((|| {
        let operands = ModRm::read(cursor, prefixes.rex)?;
        let (kind, width, register) = match opcode {
            0x8c | 0x8e => {
                let segment = match operands.selector {
                    0 => Segment::Es,
                    1 => Segment::Cs,
                    2 => Segment::Ss,
                    3 => Segment::Ds,
                    4 => Segment::Fs,
                    5 => Segment::Gs,
                    _ => return Err(DecodeError::Invalid),
                };
                if opcode == 0x8e {
                    if segment == Segment::Cs {
                        return Err(DecodeError::Invalid);
                    }
                    (Kind::LoadSegment(segment), Width::W16, 0)
                } else {
                    (
                        Kind::ReadSegment(segment),
                        if operands.mode == 3 {
                            prefixes.width()
                        } else {
                            Width::W16
                        },
                        0,
                    )
                }
            }
            _ => {
                if operands.mode == 3 {
                    return Err(DecodeError::Unsupported);
                }
                (
                    Kind::LoadFar(if opcode == 0xc4 {
                        Segment::Es
                    } else {
                        Segment::Ds
                    }),
                    prefixes.width(),
                    operands.register,
                )
            }
        };
        Ok(Operation::Protection(ProtectionInstruction {
            kind,
            width,
            register,
            operand: operands.location(cursor, prefixes, Width::W16)?,
        }))
    })())
}

pub(super) fn two_byte<F>(
    opcode: u8,
    prefixes: Prefixes,
    cursor: &mut Cursor<F>,
) -> Option<Result<Operation, DecodeError>>
where
    F: FnMut(u64) -> Result<u8, DecodeError>,
{
    if !matches!(opcode, 0x00..=0x03 | 0xb2 | 0xb4 | 0xb5) {
        return None;
    }
    Some((|| {
        let operands = ModRm::read(cursor, prefixes.rex)?;
        let (kind, width, register) = match opcode {
            0x00 => match operands.selector {
                0 | 1 => (
                    if operands.selector == 0 {
                        Kind::ReadLdt
                    } else {
                        Kind::ReadTask
                    },
                    if operands.mode == 3 {
                        prefixes.width()
                    } else {
                        Width::W16
                    },
                    0,
                ),
                2 | 3 => (
                    if operands.selector == 2 {
                        Kind::LoadLdt
                    } else {
                        Kind::LoadTask
                    },
                    Width::W16,
                    0,
                ),
                4 => (Kind::Verr, Width::W16, 0),
                5 => (Kind::Verw, Width::W16, 0),
                _ => return Err(DecodeError::Unsupported),
            },
            0x01 => {
                if prefixes.paged
                    && operands.mode == 3
                    && operands.selector == 7
                    && operands.rm & 7 == 0
                {
                    return if prefixes.lock || !prefixes.long64 {
                        Err(DecodeError::UndefinedEncoding)
                    } else {
                        Ok(Operation::FastSystem(
                            crate::x86::fast_system::Instruction::Swapgs,
                        ))
                    };
                }
                if prefixes.paged && operands.selector == 7 {
                    return super::paging::invlpg(operands, prefixes, cursor);
                }
                if operands.mode == 3 || operands.selector > 3 {
                    return Err(DecodeError::Unsupported);
                }
                let kind = match operands.selector {
                    0 => Kind::StoreGdt,
                    1 => Kind::StoreIdt,
                    2 => Kind::LoadGdt,
                    _ => Kind::LoadIdt,
                };
                (
                    kind,
                    if prefixes.long64 {
                        Width::W64
                    } else {
                        prefixes.width()
                    },
                    0,
                )
            }
            0x02 | 0x03 => (
                if opcode == 0x02 { Kind::Lar } else { Kind::Lsl },
                prefixes.width(),
                operands.register,
            ),
            _ => {
                if operands.mode == 3 {
                    return Err(DecodeError::Invalid);
                }
                (
                    Kind::LoadFar(match opcode {
                        0xb2 => Segment::Ss,
                        0xb4 => Segment::Fs,
                        _ => Segment::Gs,
                    }),
                    prefixes.width(),
                    operands.register,
                )
            }
        };
        let operand = operands.location(cursor, prefixes, Width::W16)?;
        if matches!(prefixes.mode, Mode::Real | Mode::Virtual8086)
            && matches!(
                kind,
                Kind::ReadLdt
                    | Kind::LoadLdt
                    | Kind::ReadTask
                    | Kind::LoadTask
                    | Kind::Lar
                    | Kind::Lsl
                    | Kind::Verr
                    | Kind::Verw
            )
        {
            return Err(DecodeError::Invalid);
        }
        Ok(Operation::Protection(ProtectionInstruction {
            kind,
            width,
            register,
            operand,
        }))
    })())
}
