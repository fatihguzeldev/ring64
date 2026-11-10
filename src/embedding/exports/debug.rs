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
    fn select_debug(
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
