use super::access::{Lookup, ia32e};
use super::descriptor::Descriptor;
use super::*;
use crate::x86::context::TaskRegister;

pub(super) fn load(
    context: &mut ExecutionContext,
    image: &mut impl GuestMemory,
    selector: u16,
) -> Result<bool, Failure> {
    let fault = |vector, phase| {
        Failure::Protection(ProtectionFault {
            vector,
            error_code: selector & 0xfffc,
            phase,
            selector: Some(selector),
        })
    };
    if selector < 4 || selector & 4 != 0 {
        return Err(fault(13, ProtectionPhase::Selector));
    }
    let lookup = Lookup::resolve(context, selector).unwrap();
    let width = if ia32e(context) { 16 } else { 8 };
    if !lookup.fits(width) {
        return Err(fault(13, ProtectionPhase::Selector));
    }
    let descriptor = Descriptor::decode(lookup.read(context, image, 0)?);
    let kind = descriptor.access & 15;
    if !descriptor.system() || kind != 9 && (ia32e(context) || kind != 1) {
        return Err(fault(13, ProtectionPhase::Descriptor));
    }
    if !descriptor.present() {
        return Err(fault(11, ProtectionPhase::Descriptor));
    }
    let mut base = u64::from(descriptor.base);
    if ia32e(context) {
        let upper = lookup.read(context, image, 8)?;
        base |= u64::from(upper as u32) << 32;
        if upper >> 32 & 0x1f00 != 0 || !crate::memory::canonical48(base) {
            return Err(fault(13, ProtectionPhase::Descriptor));
        }
    }
    let write = lookup.prepare_busy(context, image, width, descriptor.access)?;
    image
        .prepare_publication()
        .map_err(|failure| write.failure(failure))?;
    write.commit(image);
    let access = descriptor.access | 2;
    Ok(context.set_tr(TaskRegister {
        selector,
        valid: true,
        base,
        limit: descriptor.limit,
        attributes: u16::from(access) | u16::from(descriptor.flags) << 8,
    }))
}

// The cached task register owns stack-field layout and admission. Callers choose
// the entry policy (privilege RSP versus IST); neither alignment nor frame state
// belongs to the TSS read.
fn cached_task(context: &ExecutionContext, last: u32, ext: u16) -> Result<TaskRegister, Failure> {
    let task = context.tr();
    let kind = task.attributes & 15;
    let valid = task.valid
        && task.selector >= 4
        && task.selector & 4 == 0
        && task.attributes & 0x90 == 0x80
        && if ia32e(context) {
            kind == 11
        } else {
            matches!(kind, 3 | 11)
        };
    if !valid || last > task.limit {
        return Err(Failure::Protection(ProtectionFault {
            vector: 10,
            error_code: (task.selector & 0xfffc) | ext,
            phase: ProtectionPhase::Descriptor,
            selector: Some(task.selector),
        }));
    }
    Ok(task)
}

pub(super) fn read_rsp_at(
    context: &ExecutionContext,
    image: &impl GuestMemory,
    offset: u32,
    ext: u16,
) -> Result<u64, Failure> {
    let task = cached_task(context, offset + 7, ext)?;
    let bytes = super::access::SystemRead {
        base: task.base,
        offset,
        width: 8,
        table: Table::Tss,
        reference: SystemReference::Selector(task.selector),
        phase: SystemPhase::TssRead,
    }
    .read(context, image, ext)?;
    Ok(u64::from_le_bytes(bytes[..8].try_into().unwrap()))
}

pub(super) fn read_legacy_stack(
    context: &ExecutionContext,
    image: &impl GuestMemory,
    cpl: u8,
    ext: u16,
) -> Result<(u64, u16), Failure> {
    let wide = context.tr().attributes & 15 == 11;
    let (offset, width) = if wide {
        (4 + u32::from(cpl) * 8, 4)
    } else {
        (2 + u32::from(cpl) * 4, 2)
    };
    let task = cached_task(context, offset + width + 1, ext)?;
    let attempt = super::access::SystemRead {
        base: task.base,
        offset: offset + width,
        width: 2,
        table: Table::Tss,
        reference: SystemReference::Selector(task.selector),
        phase: SystemPhase::TssRead,
    };
    let ss = attempt.read(context, image, ext)?;
    let sp = super::access::SystemRead {
        offset,
        width,
        ..attempt
    }
    .read(context, image, ext)?;
    Ok((
        u64::from_le_bytes(sp[..8].try_into().unwrap()),
        u16::from_le_bytes(ss[..2].try_into().unwrap()),
    ))
}

#[cfg(test)]
mod tests;
