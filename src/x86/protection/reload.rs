use super::access::{Lookup, ia32e};
use super::descriptor::Descriptor;
use super::*;
use crate::x86::context::{LdtRegister, LoadedSegment, SegmentAttributes, SegmentType};

fn fault(selector: u16, vector: u8, phase: ProtectionPhase) -> Failure {
    Failure::Protection(ProtectionFault {
        vector,
        error_code: selector & 0xfffc,
        phase,
        selector: Some(selector),
    })
}

pub(super) fn segment(
    context: &mut ExecutionContext,
    image: &mut impl GuestMemory,
    target: Segment,
    selector: u16,
) -> Result<bool, Failure> {
    if matches!(context.mode(), Mode::Real | Mode::Virtual8086) {
        let mut loaded = context.segment(target);
        loaded.base = u64::from(selector) << 4;
        return Ok(context.set_segment(target, selector, loaded, context.attributes(target)));
    }
    if selector < 4 {
        if target == Segment::Ss
            && (!context.is_long64() || selector as u8 != context.cpl() || context.cpl() == 3)
        {
            return Err(fault(selector, 13, ProtectionPhase::Selector));
        }
        return Ok(context.set_segment(
            target,
            selector,
            LoadedSegment {
                base: 0,
                limit: 0,
                default32: false,
                usable: false,
                kind: SegmentType::ReadOnly,
            },
            SegmentAttributes::default(),
        ));
    }
    let lookup = Lookup::resolve(context, selector)
        .filter(|lookup| lookup.fits(8))
        .ok_or_else(|| fault(selector, 13, ProtectionPhase::Selector))?;
    let d = Descriptor::decode(lookup.read(context, image, 0)?);
    let rpl = selector as u8 & 3;
    let permitted = if target == Segment::Ss {
        d.writable() && rpl == context.cpl() && d.dpl() == context.cpl()
    } else {
        d.readable() && (d.conforming() || context.cpl() <= d.dpl() && rpl <= d.dpl())
    };
    if !permitted {
        return Err(fault(selector, 13, ProtectionPhase::Descriptor));
    }
    if !d.present() {
        return Err(fault(
            selector,
            if target == Segment::Ss { 12 } else { 11 },
            ProtectionPhase::Descriptor,
        ));
    }
    if !d.accessed() {
        lookup.set_accessed(context, image, d.access)?;
    }
    let kind = if d.code() {
        SegmentType::ReadableCode
    } else {
        match (d.access & 4 != 0, d.writable()) {
            (false, false) => SegmentType::ReadOnly,
            (false, true) => SegmentType::ReadWrite,
            (true, false) => SegmentType::ExpandDownReadOnly,
            (true, true) => SegmentType::ExpandDownReadWrite,
        }
    };
    Ok(context.set_segment(
        target,
        selector,
        LoadedSegment {
            base: u64::from(d.base),
            limit: d.limit,
            default32: d.flags & 4 != 0,
            usable: true,
            kind,
        },
        SegmentAttributes {
            dpl: d.dpl(),
            present: true,
            conforming: d.conforming(),
            accessed: true,
            long: d.flags & 2 != 0,
            granularity: d.flags & 8 != 0,
            available: d.flags & 1 != 0,
        },
    ))
}

pub(super) fn ldt(
    context: &mut ExecutionContext,
    image: &impl GuestMemory,
    selector: u16,
) -> Result<bool, Failure> {
    if selector < 4 {
        return Ok(context.set_ldtr(LdtRegister {
            selector,
            ..LdtRegister::default()
        }));
    }
    if selector & 4 != 0 {
        return Err(fault(selector, 13, ProtectionPhase::Selector));
    }
    let lookup = Lookup::resolve(context, selector).unwrap();
    if !lookup.fits(if ia32e(context) { 16 } else { 8 }) {
        return Err(fault(selector, 13, ProtectionPhase::Selector));
    }
    let d = Descriptor::decode(lookup.read(context, image, 0)?);
    if !d.system() || d.access & 15 != 2 {
        return Err(fault(selector, 13, ProtectionPhase::Descriptor));
    }
    if !d.present() {
        return Err(fault(selector, 11, ProtectionPhase::Descriptor));
    }
    let mut base = u64::from(d.base);
    if ia32e(context) {
        let upper = lookup.read(context, image, 8)?;
        base |= u64::from(upper as u32) << 32;
        if upper >> 32 & 0x1f00 != 0 || !crate::memory::canonical48(base) {
            return Err(fault(selector, 13, ProtectionPhase::Descriptor));
        }
    }
    Ok(context.set_ldtr(LdtRegister {
        selector,
        valid: true,
        base,
        limit: d.limit,
        attributes: u16::from(d.access) | u16::from(d.flags) << 8,
    }))
}
