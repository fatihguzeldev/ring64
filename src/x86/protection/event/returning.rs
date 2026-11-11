use super::super::{access::ia32e, far};
use super::*;
use crate::memory::Access;
use crate::x86::context::{LoadedSegment, SegmentAttributes, SegmentType};
use crate::x86::instruction::FarKind;

pub(super) fn execute(
    context: &mut ExecutionContext,
    image: &mut impl GuestMemory,
    descriptor: SoftwareEventDescriptor,
    inputs: EventInputs,
) -> Result<EventOutcome, EventFailure> {
    let virtual_mode = context.mode() == Mode::Virtual8086;
    let real = context.mode() == Mode::Real;
    if virtual_mode && (inputs.flags >> 12) & 3 != 3 {
        return Err(fault(13, 0, ProtectionPhase::Privilege, None));
    }
    if !real && !virtual_mode && inputs.flags & 0x4000 != 0 {
        return Err(if ia32e(context) {
            fault(13, 0, ProtectionPhase::Privilege, None)
        } else {
            EventFailure::Unsupported
        });
    }
    let mut reader = Reader::new(context, image, inputs.sp, descriptor.width);
    let pc = reader.next()?;
    let selector = reader.next()? as u16;
    let frame_flags = reader.next()?;
    if real || virtual_mode {
        if pc > u64::from(context.segment(Segment::Cs).limit) {
            return Err(fault(13, 0, ProtectionPhase::Target, None));
        }
        let sp = reader.sp();
        let flags = super::flags::restore(context, inputs.flags, frame_flags, descriptor.width);
        let mut cache = context.segment(Segment::Cs);
        cache.base = u64::from(selector) << 4;
        let changed = context.set_segment(
            Segment::Cs,
            selector,
            cache,
            context.attributes(Segment::Cs),
        );
        return Ok(EventOutcome {
            pc,
            sp,
            flags,
            context_changed: changed,
        });
    }
    if context.mode() == Mode::Protected
        && context.cpl() == 0
        && descriptor.width == Width::W32
        && frame_flags & 0x20000 != 0
    {
        if pc > 0xffff {
            return Err(fault(13, 0, ProtectionPhase::Target, None));
        }
        let sp = reader.next()?;
        let ss = reader.next()? as u16;
        let es = reader.next()? as u16;
        let ds = reader.next()? as u16;
        let fs = reader.next()? as u16;
        let gs = reader.next()? as u16;
        let mut prepared = context.clone();
        prepared.set_mode_and_cpl(Mode::Virtual8086, 3);
        for (segment, selector) in [
            (Segment::Cs, selector),
            (Segment::Ss, ss),
            (Segment::Es, es),
            (Segment::Ds, ds),
            (Segment::Fs, fs),
            (Segment::Gs, gs),
        ] {
            prepared.set_segment(
                segment,
                selector,
                LoadedSegment {
                    base: u64::from(selector) << 4,
                    limit: 0xffff,
                    default32: false,
                    usable: true,
                    kind: SegmentType::ReadWrite,
                },
                SegmentAttributes {
                    dpl: 3,
                    present: true,
                    accessed: true,
                    ..SegmentAttributes::default()
                },
            );
        }
        let context_changed = *context != prepared;
        *context = prepared;
        return Ok(EventOutcome {
            pc,
            sp,
            flags: (frame_flags & crate::x86::flags::IMPORTED_MASK) | 2,
            context_changed,
        });
    }
    let cpl = selector as u8 & 3;
    if cpl < context.cpl() {
        return Err(selector_fault(selector, 13, 0, ProtectionPhase::Selector));
    }
    let code = far::code(context, image, FarKind::Return, selector).map_err(far_failure)?;
    let mode = if ia32e(context) {
        if code.descriptor.flags & 2 != 0 {
            Mode::Long64
        } else {
            Mode::Compatibility
        }
    } else {
        Mode::Protected
    };
    let outer = cpl > context.cpl();
    let mut sp = reader.sp();
    let stack = if outer || context.is_long64() {
        sp = reader.next()?;
        let selector = reader.next()? as u16;
        Some(
            far::stack(context, image, mode, cpl, selector).map_err(|failure| {
                let mut failure = far_failure(failure);
                if let EventFailure::Protection(ref mut protection) = failure
                    && protection.vector == 12
                {
                    protection.error_code = 0;
                }
                failure
            })?,
        )
    } else {
        None
    };
    if if mode == Mode::Long64 {
        !crate::memory::canonical48(pc)
    } else {
        pc > u64::from(code.descriptor.limit)
    } {
        return Err(fault(13, 0, ProtectionPhase::Target, None));
    }
    let code_write = if !code.descriptor.accessed() {
        Some(
            code.lookup
                .prepare_accessed(context, image, code.descriptor.access)
                .map_err(descriptor_failure)?,
        )
    } else {
        None
    };
    let stack_write = if let Some(stack) = stack
        && let Some(loaded) = stack.loaded
        && !loaded.descriptor.accessed()
    {
        Some(
            loaded
                .lookup
                .prepare_accessed(context, image, loaded.descriptor.access)
                .map_err(descriptor_failure)?,
        )
    } else {
        None
    };
    let flags = super::flags::restore(context, inputs.flags, frame_flags, descriptor.width);
    let mut prepared = context.clone();
    prepared.set_mode_and_cpl(mode, cpl);
    prepared.set_segment(Segment::Cs, selector, code.cache(), code.attributes());
    if let Some(stack) = stack {
        prepared.set_segment(Segment::Ss, stack.selector, stack.cache, stack.attributes);
    }
    if outer {
        clear_inaccessible(&mut prepared, cpl);
    }
    image.prepare_publication().map_err(|failure| {
        if let Some(write) = code_write
            .into_iter()
            .chain(stack_write)
            .find(|write| write.contains(failure))
        {
            descriptor_failure(write.failure(failure))
        } else {
            EventFailure::Operand {
                segment: Segment::Ss,
                failure,
            }
        }
    })?;
    for write in code_write.into_iter().chain(stack_write) {
        write.commit(image);
    }
    let context_changed = *context != prepared;
    *context = prepared;
    Ok(EventOutcome {
        pc,
        sp,
        flags,
        context_changed,
    })
}

struct Reader<'a, M: GuestMemory> {
    context: &'a ExecutionContext,
    image: &'a M,
    raw: u64,
    cursor: u64,
    pointer_width: Width,
    width: Width,
}

impl<'a, M: GuestMemory> Reader<'a, M> {
    fn new(context: &'a ExecutionContext, image: &'a M, sp: u64, width: Width) -> Self {
        let pointer_width = context.stack_width();
        Self {
            context,
            image,
            raw: sp,
            cursor: sp & pointer_width.mask(),
            pointer_width,
            width,
        }
    }

    fn next(&mut self) -> Result<u64, EventFailure> {
        let width = u32::from(self.width.bytes());
        let address = self
            .context
            .translate(self.cursor, width, Segment::Ss, Access::Read, false)
            .map_err(|failure| EventFailure::Operand {
                segment: Segment::Ss,
                failure,
            })?;
        let bytes =
            self.image
                .read_vector(address, width)
                .map_err(|failure| EventFailure::Operand {
                    segment: Segment::Ss,
                    failure,
                })?;
        self.cursor = self.cursor.wrapping_add(u64::from(width)) & self.pointer_width.mask();
        Ok(u64::from_le_bytes(bytes[..8].try_into().unwrap()))
    }

    fn sp(&self) -> u64 {
        self.raw & !self.pointer_width.mask() | self.cursor
    }
}

fn far_failure(failure: far::FarFailure) -> EventFailure {
    match failure {
        far::FarFailure::Operand { segment, failure } => EventFailure::Operand { segment, failure },
        far::FarFailure::Protection(failure) => EventFailure::Protection(failure),
        far::FarFailure::SystemMemory(failure) => EventFailure::SystemMemory(failure),
        far::FarFailure::SystemPaging(failure) => EventFailure::SystemPaging(failure),
        far::FarFailure::Unsupported => EventFailure::Unsupported,
    }
}

fn clear_inaccessible(context: &mut ExecutionContext, cpl: u8) {
    for segment in [Segment::Es, Segment::Ds, Segment::Fs, Segment::Gs] {
        let mut cache = context.segment(segment);
        let attributes = context.attributes(segment);
        if context.selector(segment) < 4
            || attributes.dpl < cpl
                && (!matches!(cache.kind, SegmentType::Code | SegmentType::ReadableCode)
                    || !attributes.conforming)
        {
            cache.usable = false;
            context.set_segment(segment, 0, cache, attributes);
        }
    }
}
