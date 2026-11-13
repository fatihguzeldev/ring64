use super::*;
use crate::embedding::layout::PROTECTION;
use crate::x86::exception::EventState;
use crate::x86::flags;
use crate::x86::instruction::{SystemFlagsDescriptor, SystemFlagsKind};

pub(super) use crate::x86::debug::Selection as DebugException;

impl DebugException {
    pub(super) fn json(&self) -> serde_json::Value {
        let mut value = serde_json::json!({
            "vector": 1,
            "class": "trap",
            "cause": "single-step",
            "instructionPc": format!("0x{:x}", self.instruction_pc),
            "resumePc": format!("0x{:x}", self.resume_pc),
            "instructionCompleted": self.completed,
            "resumeFlags": format!("0x{:x}", self.resume_flags),
        });
        if let Some(source) = self.source {
            let fields = source.json();
            for (key, field) in fields.as_object().unwrap() {
                value[key] = field.clone();
            }
            if matches!(
                source,
                crate::x86::debug::Source::Data {
                    single_step: true,
                    ..
                }
            ) {
                value["cause"] = serde_json::json!("combined");
            }
        }
        value
    }
}

fn valid_flags(flags: u64) -> bool {
    flags & !flags::IMPORTED_MASK == 0 && flags & 2 != 0
}

impl Core {
    pub(super) fn boundary_observed(&self) -> bool {
        if self.paging.is_some() {
            return true;
        }
        let state = unsafe { &*self.state.get() };
        state.flags & (flags::TF | flags::RF) != 0
            || state.interruptibility != 0
            || state.debug.registers.active()
            || state.debug.continuation.slots != 0
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn core_boundary_observed() -> i32 {
    BRIDGE.with_borrow(|bridge| i32::from(bridge.core.as_ref().unwrap().boundary_observed()))
}

#[unsafe(no_mangle)]
pub extern "C" fn core_halt(input_flags: u64) -> i32 {
    if !valid_flags(input_flags) {
        return -1;
    }
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        let event = match EventState::halt(&core.context) {
            Ok(event) => event,
            Err(fault) => {
                core.protection_fault = Some(fault);
                return PROTECTION;
            }
        };
        unsafe {
            (*core.state.get()).set_event(event);
        }
        0
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_flags(operation: u32, flags: u64, input: u64) -> i32 {
    let Some(operation) = SystemFlagsDescriptor::try_decode(operation) else {
        return -1;
    };
    if !valid_flags(flags) {
        return -1;
    }
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        if !operation.valid_in_mode(&core.context) {
            return -1;
        }
        core.fault = None;
        core.segment_fault = None;
        core.alignment_fault = None;
        core.simd_exception = None;
        core.numeric_fault = None;
        core.general_protection = None;
        core.protection_fault = None;
        core.system_memory_fault = None;
        core.debug_exception = None;
        core.divide_failed = false;
        core.decode_fault = None;
        let result = match operation.kind {
            SystemFlagsKind::Push => flags::push(flags, operation.width, &core.context),
            SystemFlagsKind::Pop => flags::pop(flags, input, operation.width, &core.context),
            SystemFlagsKind::Cli | SystemFlagsKind::Sti => {
                flags::interrupt(flags, operation.kind == SystemFlagsKind::Sti, &core.context)
            }
            SystemFlagsKind::Clac | SystemFlagsKind::Stac => {
                let Some(value) = flags::alignment_check(
                    flags,
                    operation.kind == SystemFlagsKind::Stac,
                    &core.context,
                ) else {
                    core.decode_fault = Some(decode::DecodeFault::UndefinedOpcode);
                    return INVALID;
                };
                Ok(value)
            }
        };
        match result {
            Ok(value) => {
                unsafe {
                    let state = &mut *core.state.get();
                    state.vector_scratch[..8].copy_from_slice(&value.to_le_bytes());
                }
                0
            }
            Err(fault) => {
                core.protection_fault = Some(fault);
                PROTECTION
            }
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_debug_step(
    instruction_pc: u64,
    resume_pc: u64,
    completed: u32,
    flags: u64,
) -> i32 {
    if completed > 1 || !valid_flags(flags) {
        return -1;
    }
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        core.select_debug(instruction_pc, resume_pc, completed != 0, flags, None)
    })
}
