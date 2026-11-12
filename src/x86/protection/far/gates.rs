use super::*;
use crate::x86::context::SegmentCause;

// Call-gate frames are bounded by 31 parameters plus SS/SP/CS/PC. Geometry and
// captured values stay local to this begun instruction, including on a refusal.
struct Frame {
    writes: [Write; 35],
    count: usize,
    cursor: u64,
    raw: u64,
    pointer_width: Width,
    new_ss: Option<u16>,
}

impl Frame {
    fn new(context: &ExecutionContext, sp: u64, new_ss: Option<u16>) -> Self {
        let pointer_width = context.stack_width();
        Self {
            writes: [Write::default(); 35],
            count: 0,
            cursor: sp & pointer_width.mask(),
            raw: sp,
            pointer_width,
            new_ss,
        }
    }

    fn push(
        &mut self,
        context: &ExecutionContext,
        value: u64,
        width: Width,
    ) -> Result<(), FarFailure> {
        self.cursor = step(
            self.cursor,
            0u64.wrapping_sub(u64::from(width.bytes())),
            self.pointer_width,
        );
        let address = stack_geometry(
            context,
            self.cursor,
            u32::from(width.bytes()),
            Access::Write,
        )
        .map_err(|failure| match failure {
            FarFailure::Operand {
                failure: AccessFailure::Segment(segment),
                ..
            } if self.new_ss.is_some() && segment.cause == SegmentCause::Limit => {
                selector_fault(self.new_ss.unwrap(), 12, ProtectionPhase::Target)
            }
            FarFailure::Operand {
                failure:
                    AccessFailure::Linear(crate::memory::Fault {
                        cause: crate::memory::Cause::Noncanonical,
                        ..
                    }),
                ..
            } if context.is_long64() => FarFailure::Protection(ProtectionFault {
                vector: 12,
                error_code: 0,
                phase: ProtectionPhase::Target,
                selector: None,
            }),
            other => other,
        })?;
        self.writes[self.count] = Write {
            address,
            width: u32::from(width.bytes()),
            value: value & width.mask(),
        };
        self.count += 1;
        Ok(())
    }

    fn sp(&self) -> u64 {
        merge(self.raw, self.cursor, self.pointer_width)
    }
}

pub(super) fn execute(
    context: &mut ExecutionContext,
    image: &mut impl GuestMemory,
    kind: FarKind,
    operands: FarOperands,
    gate: Loaded,
    raw: u64,
    observe: &mut impl FnMut(u64, u32, Access),
) -> Result<FarOutcome, FarFailure> {
    let gate_selector = gate.lookup.selector;
    let wide = ia32e(context);
    let gate_kind = gate.descriptor.access & 15;
    if wide && gate_kind != 12 {
        return Err(selector_fault(
            gate_selector,
            13,
            ProtectionPhase::Descriptor,
        ));
    }
    if wide && !gate.lookup.fits(16) {
        return Err(selector_fault(gate_selector, 13, ProtectionPhase::Selector));
    }
    if context.cpl() > gate.descriptor.dpl() || (gate_selector as u8 & 3) > gate.descriptor.dpl() {
        return Err(selector_fault(
            gate_selector,
            13,
            ProtectionPhase::Descriptor,
        ));
    }
    if !gate.descriptor.present() {
        return Err(selector_fault(
            gate_selector,
            11,
            ProtectionPhase::Descriptor,
        ));
    }
    let upper = if wide {
        let upper = gate
            .lookup
            .read(context, image, 8)
            .map_err(system_failure)?;
        if upper >> 32 & 0x1f00 != 0 {
            return Err(selector_fault(
                gate_selector,
                13,
                ProtectionPhase::Descriptor,
            ));
        }
        upper
    } else {
        0
    };
    let selector = (raw >> 16) as u16;
    let code = lookup(context, image, selector)?;
    let d = code.descriptor;
    let allowed = d.code()
        && d.dpl() <= context.cpl()
        && (kind == FarKind::Call || d.conforming() || d.dpl() == context.cpl());
    if !allowed || wide && d.flags & 6 != 2 {
        return Err(selector_fault(selector, 13, ProtectionPhase::Descriptor));
    }
    if !d.present() {
        return Err(selector_fault(selector, 11, ProtectionPhase::Descriptor));
    }
    let cpl = if d.conforming() {
        context.cpl()
    } else {
        d.dpl()
    };
    let mode = if wide { Mode::Long64 } else { Mode::Protected };
    let width = if wide {
        Width::W64
    } else if gate_kind == 12 {
        Width::W32
    } else {
        Width::W16
    };
    let mut pc = raw & 0xffff;
    if width != Width::W16 {
        pc |= (raw >> 48) << 16;
    }
    if wide {
        pc |= (upper & u64::from(u32::MAX)) << 32;
    }
    let inner = kind == FarKind::Call && cpl < context.cpl();
    let count = if inner && !wide {
        (raw >> 32) as usize & 31
    } else {
        0
    };
    let mut prepared = context.clone();
    prepared.set_mode_and_cpl(mode, cpl);
    prepared.set_segment(
        Segment::Cs,
        (selector & !3) | u16::from(cpl),
        code.cache(),
        code.attributes(),
    );
    let mut new_stack = None;
    let initial_sp = if inner {
        if wide {
            let sp = super::super::task::read_rsp_at(context, image, 4 + u32::from(cpl) * 8, 0)
                .map_err(system_failure)?;
            let mut cache = context.segment(Segment::Ss);
            cache.usable = false;
            let mut attributes = context.attributes(Segment::Ss);
            attributes.dpl = cpl;
            prepared.set_segment(Segment::Ss, u16::from(cpl), cache, attributes);
            sp
        } else {
            let (sp, ss) = super::super::task::read_legacy_stack(context, image, cpl, 0)
                .map_err(system_failure)?;
            let loaded = stack(context, image, cpl, ss)?;
            prepared.set_segment(Segment::Ss, ss, loaded.cache(), loaded.attributes());
            new_stack = Some(loaded);
            sp
        }
    } else {
        operands.input_sp
    };
    let mut frame = Frame::new(
        &prepared,
        initial_sp,
        new_stack.map(|loaded| loaded.lookup.selector),
    );
    if kind == FarKind::Call {
        if inner {
            frame.push(&prepared, u64::from(context.selector(Segment::Ss)), width)?;
            frame.push(&prepared, operands.input_sp, width)?;
            for _ in 0..count {
                frame.push(&prepared, 0, width)?;
            }
        }
        frame.push(&prepared, u64::from(context.selector(Segment::Cs)), width)?;
        frame.push(&prepared, operands.next_pc, width)?;
    }
    if wide {
        if !crate::memory::canonical48(pc) {
            return Err(target_fault());
        }
    } else if pc > u64::from(d.limit) {
        return Err(target_fault());
    }
    // Capture in ascending old-stack order, then publish in the gate's reverse
    // push order. Payload/descriptor aliases cannot change a captured parameter.
    for index in 0..count {
        let offset = step(
            operands.input_sp,
            index as u64 * u64::from(width.bytes()),
            context.stack_width(),
        );
        let value = read_stack(context, image, offset, width, observe)?;
        frame.writes[2 + count - 1 - index].value = value;
    }
    let code_write = (!d.accessed())
        .then(|| code.lookup.prepare_accessed(context, image, d.access))
        .transpose()
        .map_err(system_failure)?;
    let stack_write = new_stack
        .filter(|loaded| !loaded.descriptor.accessed())
        .map(|loaded| {
            loaded
                .lookup
                .prepare_accessed(context, image, loaded.descriptor.access)
        })
        .transpose()
        .map_err(system_failure)?;
    for slot in &frame.writes[..frame.count] {
        image
            .check_frame_write(slot.address, slot.width, cpl)
            .map_err(|failure| linear_failure(failure, Segment::Ss))?;
        observe(slot.address, slot.width, Access::Write);
    }
    image.prepare_publication_ordered().map_err(|fault| {
        let mut descriptors = code_write.into_iter().chain(stack_write);
        // A page A alias can replace the authority between admissions of the
        // same linear address. The captured order identifies the actual owner.
        let descriptor = match fault.index {
            Some(index) => descriptors.nth(index),
            None => descriptors.find(|write| write.contains(fault.failure)),
        };
        if let Some(write) = descriptor {
            system_failure(write.failure(fault.failure))
        } else {
            linear_failure(fault.failure, Segment::Ss)
        }
    })?;
    for write in code_write.into_iter().chain(stack_write) {
        write.commit(image);
    }
    for slot in &frame.writes[..frame.count] {
        image
            .write(slot.address, slot.width, slot.value)
            .expect("admitted private gate frame write");
    }
    let mut changed = context.set_mode_and_cpl(mode, cpl);
    changed |= context.set_segment(
        Segment::Cs,
        prepared.selector(Segment::Cs),
        code.cache(),
        code.attributes(),
    );
    if inner {
        changed |= context.set_segment(
            Segment::Ss,
            prepared.selector(Segment::Ss),
            prepared.segment(Segment::Ss),
            prepared.attributes(Segment::Ss),
        );
    }
    Ok(FarOutcome {
        pc,
        sp: if kind == FarKind::Call {
            frame.sp()
        } else {
            operands.input_sp
        },
        context_changed: changed,
    })
}

fn stack(
    context: &ExecutionContext,
    image: &impl GuestMemory,
    cpl: u8,
    selector: u16,
) -> Result<Loaded, FarFailure> {
    if selector as u8 & 3 != cpl {
        return Err(selector_fault(selector, 10, ProtectionPhase::Selector));
    }
    let loaded = lookup(context, image, selector).map_err(|failure| match failure {
        FarFailure::Protection(mut fault) => {
            fault.vector = 10;
            FarFailure::Protection(fault)
        }
        other => other,
    })?;
    let d = loaded.descriptor;
    if !d.writable() || d.dpl() != cpl {
        return Err(selector_fault(selector, 10, ProtectionPhase::Descriptor));
    }
    if !d.present() {
        return Err(selector_fault(selector, 12, ProtectionPhase::Descriptor));
    }
    Ok(loaded)
}
