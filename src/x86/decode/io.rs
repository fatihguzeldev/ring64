use super::{DecodeError, cursor::Cursor, prefix::Prefixes};
use crate::x86::context::Segment;
use crate::x86::instruction::{Operation, Repeat, StringKind, Width};

pub(super) fn refine<F>(
    opcode: u8,
    prefixes: Prefixes,
    cursor: &mut Cursor<F>,
) -> Option<Result<Operation, DecodeError>>
where
    F: FnMut(u64) -> Result<u8, DecodeError>,
{
    if !matches!(opcode, 0x6c..=0x6f | 0xe4..=0xe7 | 0xec..=0xef) {
        return None;
    }
    Some((|| {
        let string = matches!(opcode, 0x6c..=0x6f);
        let repeat = match prefixes.repeat {
            None => Repeat::None,
            Some(0xf3) if string => Repeat::Count,
            _ => return Err(DecodeError::Unsupported),
        };
        let width = if opcode & 1 == 0 {
            Width::W8
        } else if prefixes.long64 {
            if prefixes.operand_override {
                Width::W16
            } else {
                Width::W32
            }
        } else {
            prefixes.width()
        };
        let port = if matches!(opcode, 0xe4..=0xe7) {
            Some(cursor.byte()?)
        } else {
            None
        };
        if prefixes.lock {
            return Err(DecodeError::UndefinedEncoding);
        }
        Ok(if string {
            Operation::String {
                kind: if opcode & 2 == 0 {
                    StringKind::Ins
                } else {
                    StringKind::Outs
                },
                width,
                address_width: prefixes.address_width(),
                source_segment: prefixes.segment_override.unwrap_or(Segment::Ds),
                repeat,
            }
        } else {
            Operation::Io {
                input: opcode & 2 == 0,
                port,
                width,
            }
        })
    })())
}
