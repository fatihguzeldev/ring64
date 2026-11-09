use super::{DecodeError, prefix::Prefixes};
use crate::x86::instruction::{Operation, SystemFlagsDescriptor, SystemFlagsKind, Width};

pub(super) fn one_byte(opcode: u8, prefixes: Prefixes) -> Option<Result<Operation, DecodeError>> {
    if opcode == 0x17 {
        return Some(if prefixes.long64 {
            Err(DecodeError::Invalid)
        } else {
            Ok(Operation::PopSs {
                width: prefixes.stack_width(),
            })
        });
    }
    let kind = match opcode {
        0x9c => SystemFlagsKind::Push,
        0x9d => SystemFlagsKind::Pop,
        0xfa => SystemFlagsKind::Cli,
        0xfb => SystemFlagsKind::Sti,
        _ => return None,
    };
    Some(Ok(Operation::SystemFlags(SystemFlagsDescriptor {
        kind,
        width: if matches!(kind, SystemFlagsKind::Push | SystemFlagsKind::Pop) {
            prefixes.stack_width()
        } else {
            Width::W16
        },
    })))
}
