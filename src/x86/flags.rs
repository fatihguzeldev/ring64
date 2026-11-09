use super::context::{ExecutionContext, Mode};
use super::instruction::Width;
use super::protection::{ProtectionFault, ProtectionPhase};

pub const IMPORTED_MASK: u64 = 0x3d7fd7;
pub const TF: u64 = 1 << 8;
pub const IF: u64 = 1 << 9;
pub const RF: u64 = 1 << 16;
pub const VM: u64 = 1 << 17;

pub fn architectural(flags: u64, context: &ExecutionContext) -> u64 {
    flags
        | if context.mode() == Mode::Virtual8086 {
            VM
        } else {
            0
        }
}

pub fn valid_interruptibility(flags: u64, bits: u32) -> bool {
    bits <= 2 && (bits != 1 || flags & IF != 0)
}

fn denied() -> ProtectionFault {
    ProtectionFault {
        vector: 13,
        error_code: 0,
        phase: ProtectionPhase::Privilege,
        selector: None,
    }
}

pub fn admit_stack(flags: u64, context: &ExecutionContext) -> Result<(), ProtectionFault> {
    if context.mode() == Mode::Virtual8086 && flags & 0x3000 != 0x3000 {
        Err(denied())
    } else {
        Ok(())
    }
}

pub fn push(flags: u64, width: Width, context: &ExecutionContext) -> Result<u64, ProtectionFault> {
    admit_stack(flags, context)?;
    Ok(architectural(flags, context) & !(RF | VM) & width.mask())
}

pub fn pop(
    flags: u64,
    input: u64,
    width: Width,
    context: &ExecutionContext,
) -> Result<u64, ProtectionFault> {
    admit_stack(flags, context)?;
    let mut writable = if width == Width::W16 {
        0x7fd5
    } else {
        0x247fd5
    };
    if context.cpl() != 0 {
        writable &= !0x3000;
    }
    if context.mode() != Mode::Real && u64::from(context.cpl()) > (flags >> 12 & 3) {
        writable &= !IF;
    }
    Ok(flags & !(writable | RF) | input & writable)
}

pub fn interrupt(
    flags: u64,
    set: bool,
    context: &ExecutionContext,
) -> Result<u64, ProtectionFault> {
    let allowed = match context.mode() {
        Mode::Real => true,
        Mode::Virtual8086 => flags & 0x3000 == 0x3000,
        _ => u64::from(context.cpl()) <= (flags >> 12 & 3),
    };
    if !allowed {
        return Err(denied());
    }
    Ok(if set { flags | IF } else { flags & !IF })
}

#[cfg(test)]
mod tests;
