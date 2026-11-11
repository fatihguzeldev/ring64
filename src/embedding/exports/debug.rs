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
            addresses: std::array::from_fn(|i| {
                word(std::mem::offset_of!(State, addresses) + i * 8)
            }),
            dr6: word(std::mem::offset_of!(State, dr6)),
            dr7: word(std::mem::offset_of!(State, dr7)),
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
        let selection = crate::x86::debug::Selection::new(
            pc,
            resume,
            completed,
            crate::x86::flags::architectural(flags, &self.context),
            source,
        );
        self.publish_debug(selection)
    }
    fn publish_debug(&mut self, selection: crate::x86::debug::Selection) -> i32 {
        let state = unsafe { &mut *self.state.get() };
        state.debug.registers.select_source(selection.source);
        if selection
            .source
            .is_some_and(crate::x86::debug::Source::fault)
        {
            state.debug.continuation = crate::embedding::layout::debug::Continuation::default();
        }
        if !selection
            .source
            .is_some_and(crate::x86::debug::Source::fault)
            && state.delivery_enabled == 0
        {
            state.interruptibility = 0;
        }
        self.debug_candidate = 0;
        self.debug_exception = Some(selection);
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
    pub(super) fn finish_debug(
        &mut self,
        pc: u64,
        resume: u64,
        completed: bool,
        flags: u64,
        decision: u32,
    ) -> i32 {
        use crate::x86::debug::{Completion, Deferred, complete};
        let state = unsafe { &mut *self.state.get() };
        let raw = state.debug.continuation;
        let mut deferred = (raw.slots != 0).then_some(Deferred {
            slots: raw.slots as u8,
            origin: raw.origin,
        });
        let selected = complete(
            std::mem::take(&mut self.debug_candidate),
            &mut deferred,
            Completion {
                pc,
                resume,
                completed,
                flags: crate::x86::flags::architectural(flags, &self.context),
                single_step: decision & 1 != 0,
                incoming_ss: decision & 2 != 0,
                ss_producer: decision & 4 != 0,
            },
        );
        state.debug.continuation = deferred.map_or_else(Default::default, |d| {
            super::super::layout::debug::Continuation {
                slots: u32::from(d.slots),
                origin: d.origin,
                reserved: 0,
            }
        });
        if let Some(selection) = selected {
            self.publish_debug(selection)
        } else if state.debug.registers.active() {
            super::super::layout::debug::CONTINUE_ACTIVE
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
