use super::access::{Lookup, ia32e};
use super::descriptor::Descriptor;
use super::*;
use crate::x86::context::TaskRegister;

pub(super) fn load(
    context: &mut ExecutionContext,
    image: &mut Image,
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
    let (address, access) = lookup.prepare_busy(context, image, width, descriptor.access)?;
    image
        .write(address, 1, u64::from(access))
        .expect("admitted private TSS busy write");
    Ok(context.set_tr(TaskRegister {
        selector,
        valid: true,
        base,
        limit: descriptor.limit,
        attributes: u16::from(access) | u16::from(descriptor.flags) << 8,
    }))
}

#[cfg(test)]
mod tests;
