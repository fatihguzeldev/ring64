use super::*;
use crate::x86::debug::State;

#[unsafe(no_mangle)]
pub extern "C" fn core_import_debug() -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        if bridge.input.len() != size_of::<State>() {
            return bridge.error("debug bank input length differs");
        }
        let word =
            |offset| u64::from_le_bytes(bridge.input[offset..offset + 8].try_into().unwrap());
        let mut input = State {
            addresses: std::array::from_fn(|i| word(i * 8)),
            dr6: word(32),
            dr7: word(40),
        };
        if input.dr6 > u32::MAX.into() || input.dr7 > u32::MAX.into() {
            return bridge.error("debug control input exceeds unsigned32");
        }
        input.normalize();
        unsafe {
            (*bridge.core.as_mut().unwrap().state.get()).debug.registers = input;
        }
        0
    })
}

impl Core {
    pub(super) fn select_debug(
        &mut self,
        pc: u64,
        resume: u64,
        completed: bool,
        flags: u64,
        source: Option<crate::x86::debug::Source>,
    ) -> i32 {
        use crate::x86::{debug::Source, flags};
        let (slots, step, gd) = match source {
            Some(Source::Execute(slots)) => (slots, false, false),
            Some(Source::GeneralDetect) => (0, false, true),
            Some(Source::Data {
                slots, single_step, ..
            }) => (slots, single_step, false),
            None => (0, true, false),
        };
        let state = unsafe { &mut *self.state.get() };
        state.debug.registers.select(slots, step, gd);
        if source.is_some_and(crate::x86::debug::Source::fault) {
            state.debug.continuation = crate::embedding::layout::debug::Continuation::default();
        }
        if !source.is_some_and(crate::x86::debug::Source::fault) && state.delivery_enabled == 0 {
            state.interruptibility = 0;
        }
        self.debug_candidate = 0;
        let mut resume_flags = flags::architectural(flags, &self.context);
        if matches!(source, Some(Source::GeneralDetect))
            || !completed && !matches!(source, Some(Source::Execute(_)))
        {
            resume_flags |= flags::RF;
        }
        self.debug_exception = Some(super::system_flags::DebugException {
            source,
            instruction_pc: pc,
            resume_pc: resume,
            completed,
            resume_flags,
        });
        if state.event.kind == 3 {
            state.set_event(crate::x86::exception::EventState::Ready);
        }
        crate::embedding::layout::DEBUG_EXCEPTION
    }
    pub(super) fn debug_execute(&mut self, pc: u64, flags: u64, shadow: u32) -> i32 {
        if flags & crate::x86::flags::RF != 0 || shadow == 2 {
            return 0;
        }
        let slots = self
            .context
            .translate(pc, 0, Segment::Cs, Access::Execute, false)
            .ok()
            .map_or(0, |linear| unsafe {
                (*self.state.get())
                    .debug
                    .registers
                    .matches(linear, 1, Access::Execute)
            });
        if slots == 0 {
            0
        } else {
            self.select_debug(
                pc,
                pc,
                false,
                flags,
                Some(crate::x86::debug::Source::Execute(slots)),
            )
        }
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn core_debug_register(operation: u32, input: u64, pc: u64, flags: u64) -> i32 {
    use crate::x86::{
        context::Mode,
        protection::{ProtectionFault, ProtectionPhase},
    };
    let register = (operation & 7) as u8;
    if operation & !31 != 0 || matches!(register, 4 | 5) {
        return -1;
    }
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        if (operation & 16 != 0) != core.context.is_long64() {
            return -1;
        }
        if core.context.mode() != Mode::Real && core.context.cpl() != 0 {
            core.protection_fault = Some(ProtectionFault {
                vector: 13,
                error_code: 0,
                phase: ProtectionPhase::Privilege,
                selector: None,
            });
            return crate::embedding::layout::PROTECTION;
        }
        if unsafe { (*core.state.get()).debug.registers.general_detect() } {
            return core.select_debug(
                pc,
                pc,
                false,
                flags,
                Some(crate::x86::debug::Source::GeneralDetect),
            );
        }
        let state = unsafe { &mut *core.state.get() };
        if operation & 8 != 0 {
            let input = if core.context.is_long64() {
                input
            } else {
                u64::from(input as u32)
            };
            if register >= 6 && input > u32::MAX.into() {
                core.protection_fault = Some(ProtectionFault {
                    vector: 13,
                    error_code: 0,
                    phase: ProtectionPhase::Target,
                    selector: None,
                });
                return crate::embedding::layout::PROTECTION;
            }
            state.debug.registers.write(register, input);
        } else {
            state.vector_scratch[..8]
                .copy_from_slice(&state.debug.registers.read(register).to_le_bytes());
        }
        0
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_debug_begin(pc: u64, flags: u64, shadow: u32) -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        core.debug_candidate = 0;
        core.debug_execute(pc, flags, shadow)
    })
}

impl Core {
    pub(super) fn debug_operand(&mut self, address: u64, width: u32, access: Access) {
        self.debug_candidate |= unsafe {
            (*self.state.get())
                .debug
                .registers
                .matches(address, width, access)
        };
    }
    fn finish_debug(
        &mut self,
        pc: u64,
        resume: u64,
        completed: bool,
        flags: u64,
        decision: u32,
    ) -> i32 {
        use crate::embedding::layout::debug::Continuation;
        let step = decision & 1 != 0;
        let incoming_ss = decision & 2 != 0;
        let first_ss = decision & 4 != 0 && !incoming_ss;
        let slots = std::mem::take(&mut self.debug_candidate);
        let state = unsafe { &mut *self.state.get() };
        let deferred = state.debug.continuation;
        if first_ss || !completed && incoming_ss && !step {
            if slots != 0 {
                state.debug.continuation = Continuation {
                    slots: deferred.slots | u32::from(slots),
                    reserved: 0,
                    origin: if deferred.slots != 0 {
                        deferred.origin
                    } else {
                        pc
                    },
                };
            }
            return 0;
        }
        let slots = slots | deferred.slots as u8;
        state.debug.continuation = Continuation::default();
        if slots != 0 {
            self.select_debug(
                pc,
                resume,
                completed,
                flags,
                Some(crate::x86::debug::Source::Data {
                    slots,
                    single_step: step,
                    completed,
                    origin: (deferred.slots != 0).then_some(deferred.origin),
                }),
            )
        } else if step {
            self.select_debug(pc, resume, completed, flags, None)
        } else {
            0
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn core_debug_finish(
    pc: u64,
    resume: u64,
    completed: u32,
    flags: u64,
    decision: u32,
) -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        bridge
            .core
            .as_mut()
            .unwrap()
            .finish_debug(pc, resume, completed != 0, flags, decision)
    })
}

impl Core {
    // These operations commit a context transition inside their semantic helper. Use
    // the admitted operand's old context, without observing descriptor-table traffic.
    fn debug_offset(
        &mut self,
        before: &ExecutionContext,
        offset: u64,
        width: u32,
        segment: Segment,
        access: Access,
    ) {
        if let Ok(address) = before.translate(offset, width, segment, access, false) {
            self.debug_operand(address, width, access);
        }
    }
    pub(super) fn debug_protection(
        &mut self,
        before: &ExecutionContext,
        descriptor: crate::x86::instruction::ProtectionDescriptor,
        offset: u64,
        segment: Segment,
    ) {
        use crate::x86::instruction::ProtectionKind::*;
        let (width, access) = match descriptor.kind {
            StoreGdt | StoreIdt => (if before.is_long64() { 10 } else { 6 }, Access::Write),
            LoadGdt | LoadIdt => (if before.is_long64() { 10 } else { 6 }, Access::Read),
            ReadLdt | ReadTask | ReadSegment(_) if descriptor.memory => (2, Access::Write),
            Lar | Lsl | Verr | Verw | LoadLdt | LoadTask | LoadSegment(_) if descriptor.memory => {
                (2, Access::Read)
            }
            LoadFar(_) => (u32::from(descriptor.width.bytes()) + 2, Access::Read),
            _ => return,
        };
        self.debug_offset(before, offset, width, segment, access);
    }
    pub(super) fn debug_far(
        &mut self,
        before: &ExecutionContext,
        descriptor: crate::x86::instruction::FarDescriptor,
        offset: u64,
        sp: u64,
        segment: Segment,
    ) {
        use crate::x86::instruction::FarKind;
        let size = u64::from(descriptor.width.bytes());
        let mask = before.stack_width().mask();
        if descriptor.memory {
            self.debug_offset(before, offset, size as u32 + 2, segment, Access::Read);
        }
        if descriptor.kind == FarKind::Call {
            for index in 1..=2 {
                self.debug_offset(
                    before,
                    sp.wrapping_sub(index * size) & mask,
                    size as u32,
                    Segment::Ss,
                    Access::Write,
                );
            }
        } else if descriptor.kind == FarKind::Return {
            for index in 0..2 {
                self.debug_offset(
                    before,
                    sp.wrapping_add(index * size) & mask,
                    size as u32,
                    Segment::Ss,
                    Access::Read,
                );
            }
            if self.context.cpl() > before.cpl() {
                for index in 2..4 {
                    self.debug_offset(
                        before,
                        sp.wrapping_add(index * size).wrapping_add(offset) & mask,
                        size as u32,
                        Segment::Ss,
                        Access::Read,
                    );
                }
            }
        }
    }
    pub(super) fn debug_iret(
        &mut self,
        before: &ExecutionContext,
        operation: crate::x86::instruction::SoftwareEventDescriptor,
        sp: u64,
    ) {
        use crate::x86::{context::Mode, instruction::SoftwareEventKind};
        if operation.kind != SoftwareEventKind::Return {
            return;
        }
        let count = if before.mode() == Mode::Protected && self.context.mode() == Mode::Virtual8086
        {
            9
        } else if before.is_long64() || self.context.cpl() > before.cpl() {
            5
        } else {
            3
        };
        let size = u64::from(operation.width.bytes());
        let mask = before.stack_width().mask();
        for index in 0..count {
            self.debug_offset(
                before,
                sp.wrapping_add(index * size) & mask,
                size as u32,
                Segment::Ss,
                Access::Read,
            );
        }
    }
}
