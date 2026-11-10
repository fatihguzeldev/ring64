use super::super::access::{Lookup, ia32e};
use super::super::descriptor::Descriptor;
use super::super::far::Loaded;
use super::super::{SystemPhase, SystemReference, Table};
use super::frame::Frame;
use super::system::SystemRead;
use super::*;

pub(super) fn execute(
    context: &mut ExecutionContext,
    image: &mut Image,
    event: SoftwareEventDescriptor,
    inputs: EventInputs,
) -> Result<EventOutcome, EventFailure> {
    enter(context, image, Source::Software(event), inputs)
}

pub(super) fn enter_exception(
    context: &mut ExecutionContext,
    image: &mut Image,
    event: ExceptionEvent,
    sp: u64,
    live_flags: u64,
) -> Result<EventOutcome, EventFailure> {
    enter(
        context,
        image,
        Source::Exception(event),
        EventInputs {
            flags: live_flags,
            sp,
            next_pc: event.return_pc,
        },
    )
}

pub(super) fn enter_interrupt(
    context: &mut ExecutionContext,
    image: &mut Image,
    event: InterruptEvent,
    sp: u64,
    live_flags: u64,
) -> Result<EventOutcome, EventFailure> {
    enter(
        context,
        image,
        Source::Interrupt(event),
        EventInputs {
            flags: live_flags,
            sp,
            next_pc: event.return_pc,
        },
    )
}

enum Source {
    Software(SoftwareEventDescriptor),
    Exception(ExceptionEvent),
    Interrupt(InterruptEvent),
}

fn enter(
    context: &mut ExecutionContext,
    image: &mut Image,
    source: Source,
    inputs: EventInputs,
) -> Result<EventOutcome, EventFailure> {
    let (vector, ext, check_dpl, check_iopl, saved_flags, error_code) = match source {
        Source::Software(event) => (
            event.vector,
            u16::from(event.kind == SoftwareEventKind::Int1),
            event.kind != SoftwareEventKind::Int1,
            event.kind == SoftwareEventKind::Interrupt,
            crate::x86::flags::architectural(inputs.flags, context),
            None,
        ),
        Source::Exception(event) => (
            event.vector,
            1,
            false,
            false,
            event.saved_flags,
            event.error_code,
        ),
        Source::Interrupt(event) => (
            event.source.vector(),
            1,
            false,
            false,
            event.saved_flags,
            None,
        ),
    };
    let root = context.idtr();
    if context.mode() == Mode::Virtual8086 && check_iopl && (inputs.flags >> 12) & 3 != 3 {
        return Err(fault(13, 0, ProtectionPhase::Privilege, None));
    }
    if context.mode() == Mode::Real {
        let offset = u32::from(vector) * 4;
        if offset + 3 > u32::from(root.limit) {
            return Err(fault(13, 0, ProtectionPhase::Selector, None));
        }
        let gate = SystemRead {
            base: root.base,
            offset,
            width: 4,
            table: Table::Ivt,
            reference: SystemReference::Vector(vector),
            phase: SystemPhase::GateRead,
        }
        .read(context, image, ext)?;
        let mut frame = Frame::new(context, inputs.sp);
        for value in [
            saved_flags,
            u64::from(context.selector(Segment::Cs)),
            inputs.next_pc,
        ] {
            frame.push(context, value, Width::W16, ext)?;
        }
        frame.admit(image)?;
        let pc = u64::from(u16::from_le_bytes(gate[..2].try_into().unwrap()));
        let selector = u16::from_le_bytes(gate[2..4].try_into().unwrap());
        let mut cache = context.segment(Segment::Cs);
        cache.base = u64::from(selector) << 4;
        frame.commit(image);
        let changed = context.set_segment(
            Segment::Cs,
            selector,
            cache,
            context.attributes(Segment::Cs),
        );
        return Ok(EventOutcome {
            pc,
            sp: frame.sp(),
            flags: inputs.flags & !0x50300,
            context_changed: changed,
        });
    }
    let gate_width = if ia32e(context) { 16 } else { 8 };
    let offset = u32::from(vector) * gate_width;
    let idt_error = (u16::from(vector) * 8) | 2 | ext;
    if offset + gate_width - 1 > u32::from(root.limit) {
        return Err(fault(13, idt_error, ProtectionPhase::Selector, None));
    }
    let bytes = SystemRead {
        base: root.base,
        offset,
        width: gate_width,
        table: Table::Idt,
        reference: SystemReference::Vector(vector),
        phase: SystemPhase::GateRead,
    }
    .read(context, image, ext)?;
    let access = bytes[5];
    let kind = access & 15;
    if ia32e(context) && matches!(kind, 6 | 7) && access & 0x10 == 0 {
        return Err(fault(13, 0, ProtectionPhase::Descriptor, None));
    }
    let valid_type = access & 0x10 == 0
        && if ia32e(context) {
            matches!(kind, 14 | 15)
        } else {
            matches!(kind, 5 | 6 | 7 | 14 | 15)
        };
    if !valid_type || ia32e(context) && (bytes[4] & 0xf8 != 0 || bytes[12..16] != [0; 4]) {
        return Err(fault(13, idt_error, ProtectionPhase::Descriptor, None));
    }
    if check_dpl && (access >> 5) & 3 < context.cpl() {
        return Err(fault(13, idt_error, ProtectionPhase::Privilege, None));
    }
    if access & 0x80 == 0 {
        return Err(fault(11, idt_error, ProtectionPhase::Descriptor, None));
    }
    if kind == 5 {
        return Err(EventFailure::Unsupported);
    }
    if matches!(source, Source::Exception(_) | Source::Interrupt(_))
        && context.mode() == Mode::Virtual8086
        && matches!(kind, 6 | 7)
    {
        return Err(EventFailure::Unsupported);
    }
    let selector = u16::from_le_bytes(bytes[2..4].try_into().unwrap());
    let code = code(context, image, selector, ext, idt_error)?;
    let d = code.descriptor;
    let cpl = if d.conforming() {
        context.cpl()
    } else {
        d.dpl()
    };
    if context.mode() == Mode::Virtual8086 && (d.conforming() || cpl != 0) {
        return Err(selector_fault(
            selector,
            13,
            ext,
            ProtectionPhase::Descriptor,
        ));
    }
    let width = if ia32e(context) {
        Width::W64
    } else if kind & 8 != 0 {
        Width::W32
    } else {
        Width::W16
    };
    let mut pc = u64::from(u16::from_le_bytes(bytes[..2].try_into().unwrap()));
    if width != Width::W16 {
        pc |= u64::from(u16::from_le_bytes(bytes[6..8].try_into().unwrap())) << 16;
    }
    if width == Width::W64 {
        pc |= u64::from(u32::from_le_bytes(bytes[8..12].try_into().unwrap())) << 32;
    }
    let mut prepared = context.clone();
    prepared.set_mode_and_cpl(
        if ia32e(context) {
            Mode::Long64
        } else {
            Mode::Protected
        },
        cpl,
    );
    prepared.set_segment(
        Segment::Cs,
        (selector & !3) | u16::from(cpl),
        code.cache(),
        code.attributes(),
    );
    let ist = if ia32e(context) { bytes[4] & 7 } else { 0 };
    let switch = cpl < context.cpl() || ist != 0;
    let mut stack_loaded = None;
    let initial_sp = if ia32e(context) {
        let sp = if switch {
            read_rsp(context, image, cpl, ist, ext)?
        } else {
            inputs.sp
        };
        if !crate::memory::canonical48(sp) {
            return Err(fault(12, ext, ProtectionPhase::Target, None));
        }
        if switch {
            let mut cache = context.segment(Segment::Ss);
            cache.usable = false;
            let mut attributes = context.attributes(Segment::Ss);
            attributes.dpl = cpl;
            prepared.set_segment(Segment::Ss, u16::from(cpl), cache, attributes);
        }
        sp & !15
    } else if switch {
        let (sp, selector) = read_legacy_stack(context, image, cpl, ext)?;
        let stack = stack(context, image, cpl, selector, ext)?;
        prepared.set_segment(Segment::Ss, selector, stack.cache(), stack.attributes());
        stack_loaded = Some(stack);
        sp
    } else {
        inputs.sp
    };
    let mut frame = Frame::new(&prepared, initial_sp);
    if context.mode() == Mode::Virtual8086 {
        for segment in [Segment::Gs, Segment::Fs, Segment::Ds, Segment::Es] {
            frame.push(&prepared, u64::from(context.selector(segment)), width, ext)?;
            let mut cache = context.segment(segment);
            cache.usable = false;
            prepared.set_segment(segment, 0, cache, context.attributes(segment));
        }
    }
    if switch || ia32e(context) {
        frame.push(
            &prepared,
            u64::from(context.selector(Segment::Ss)),
            width,
            ext,
        )?;
        frame.push(&prepared, inputs.sp, width, ext)?;
    }
    frame.push(&prepared, saved_flags, width, ext)?;
    frame.push(
        &prepared,
        u64::from(context.selector(Segment::Cs)),
        width,
        ext,
    )?;
    frame.push(&prepared, inputs.next_pc, width, ext)?;
    if let Some(error_code) = error_code {
        frame.push(&prepared, u64::from(error_code), width, ext)?;
    }
    if if ia32e(context) {
        !crate::memory::canonical48(pc)
    } else {
        pc > u64::from(d.limit)
    } {
        return Err(fault(13, ext, ProtectionPhase::Target, None));
    }
    let code_write = if !d.accessed() {
        Some(
            code.lookup
                .prepare_accessed(context, image, d.access)
                .map_err(descriptor_failure)?,
        )
    } else {
        None
    };
    let stack_write = if let Some(stack) = stack_loaded
        && !stack.descriptor.accessed()
    {
        Some(
            stack
                .lookup
                .prepare_accessed(context, image, stack.descriptor.access)
                .map_err(descriptor_failure)?,
        )
    } else {
        None
    };
    frame.admit(image)?;
    for (address, byte) in code_write.into_iter().chain(stack_write) {
        image
            .write(address, 1, u64::from(byte))
            .expect("admitted private event accessed write");
    }
    frame.commit(image);
    let context_changed = *context != prepared;
    *context = prepared;
    Ok(EventOutcome {
        pc,
        sp: frame.sp(),
        flags: inputs.flags & !(0x34100 | if kind & 1 == 0 { 0x200 } else { 0 }),
        context_changed,
    })
}

fn code(
    context: &ExecutionContext,
    image: &Image,
    selector: u16,
    ext: u16,
    idt_error: u16,
) -> Result<Loaded, EventFailure> {
    let loaded = lookup(context, image, selector, 13, ext)?;
    let d = loaded.descriptor;
    if !d.code() || d.dpl() > context.cpl() {
        return Err(selector_fault(
            selector,
            13,
            ext,
            ProtectionPhase::Descriptor,
        ));
    }
    if ia32e(context) && d.flags & 6 != 2 {
        return Err(fault(13, idt_error, ProtectionPhase::Descriptor, None));
    }
    if !d.present() {
        return Err(selector_fault(
            selector,
            11,
            ext,
            ProtectionPhase::Descriptor,
        ));
    }
    Ok(loaded)
}

fn stack(
    context: &ExecutionContext,
    image: &Image,
    cpl: u8,
    selector: u16,
    ext: u16,
) -> Result<Loaded, EventFailure> {
    if selector as u8 & 3 != cpl {
        return Err(selector_fault(selector, 10, ext, ProtectionPhase::Selector));
    }
    let loaded = lookup(context, image, selector, 10, ext)?;
    let d = loaded.descriptor;
    if !d.writable() || d.dpl() != cpl {
        return Err(selector_fault(
            selector,
            10,
            ext,
            ProtectionPhase::Descriptor,
        ));
    }
    if !d.present() {
        return Err(selector_fault(
            selector,
            12,
            ext,
            ProtectionPhase::Descriptor,
        ));
    }
    Ok(loaded)
}

fn lookup(
    context: &ExecutionContext,
    image: &Image,
    selector: u16,
    vector: u8,
    ext: u16,
) -> Result<Loaded, EventFailure> {
    if selector < 4 {
        return Err(selector_fault(
            selector,
            vector,
            ext,
            ProtectionPhase::Selector,
        ));
    }
    let lookup = Lookup::resolve(context, selector)
        .filter(|lookup| lookup.fits(8))
        .ok_or_else(|| selector_fault(selector, vector, ext, ProtectionPhase::Selector))?;
    let descriptor =
        Descriptor::decode(lookup.read(context, image, 0).map_err(descriptor_failure)?);
    Ok(Loaded { lookup, descriptor })
}

fn task(
    context: &ExecutionContext,
    last: u32,
    ext: u16,
) -> Result<crate::x86::context::TaskRegister, EventFailure> {
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
        return Err(selector_fault(
            task.selector,
            10,
            ext,
            ProtectionPhase::Descriptor,
        ));
    }
    Ok(task)
}

fn read_rsp(
    context: &ExecutionContext,
    image: &Image,
    cpl: u8,
    ist: u8,
    ext: u16,
) -> Result<u64, EventFailure> {
    let offset = if ist == 0 {
        4 + u32::from(cpl) * 8
    } else {
        28 + u32::from(ist) * 8
    };
    let task = task(context, offset + 7, ext)?;
    let bytes = SystemRead {
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

fn read_legacy_stack(
    context: &ExecutionContext,
    image: &Image,
    cpl: u8,
    ext: u16,
) -> Result<(u64, u16), EventFailure> {
    let wide = context.tr().attributes & 15 == 11;
    let (offset, width) = if wide {
        (4 + u32::from(cpl) * 8, 4)
    } else {
        (2 + u32::from(cpl) * 4, 2)
    };
    let task = task(context, offset + width + 1, ext)?;
    let attempt = SystemRead {
        base: task.base,
        offset: offset + width,
        width: 2,
        table: Table::Tss,
        reference: SystemReference::Selector(task.selector),
        phase: SystemPhase::TssRead,
    };
    let ss = attempt.read(context, image, ext)?;
    let sp = SystemRead {
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
