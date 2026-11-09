use super::{DecodeError, cursor::Cursor, prefix::Prefixes};
use crate::x86::instruction::{Operation, SoftwareEventDescriptor, SoftwareEventKind, Width};

pub(super) fn one_byte<F>(
    opcode: u8,
    prefixes: Prefixes,
    cursor: &mut Cursor<F>,
) -> Option<Result<Operation, DecodeError>>
where
    F: FnMut(u64) -> Result<u8, DecodeError>,
{
    let kind = match opcode {
        0xcc => SoftwareEventKind::Int3,
        0xcd => SoftwareEventKind::Interrupt,
        0xce => SoftwareEventKind::Into,
        0xcf => SoftwareEventKind::Return,
        0xf1 => SoftwareEventKind::Int1,
        _ => return None,
    };
    Some((|| {
        if kind == SoftwareEventKind::Into && prefixes.long64 {
            return Err(DecodeError::Invalid);
        }
        let vector = match kind {
            SoftwareEventKind::Interrupt => cursor.unsigned(1)? as u8,
            SoftwareEventKind::Int3 => 3,
            SoftwareEventKind::Into => 4,
            SoftwareEventKind::Int1 => 1,
            SoftwareEventKind::Return => 0,
        };
        Ok(Operation::SoftwareEvent(SoftwareEventDescriptor {
            kind,
            vector,
            width: if kind == SoftwareEventKind::Return {
                prefixes.width()
            } else {
                Width::W16
            },
        }))
    })())
}
