use super::*;
use crate::embedding::layout::{DEBUG_EXCEPTION, PROTECTION};
use crate::x86::flags;
use crate::x86::instruction::{SystemFlagsDescriptor, SystemFlagsKind};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct DebugException {
    pub(super) instruction_pc: u64,
    pub(super) resume_pc: u64,
    completed: bool,
    pub(super) resume_flags: u64,
}

impl DebugException {
    pub(super) fn json(&self) -> serde_json::Value {
        serde_json::json!({
            "vector": 1,
            "class": "trap",
            "cause": "single-step",
            "instructionPc": format!("0x{:x}", self.instruction_pc),
            "resumePc": format!("0x{:x}", self.resume_pc),
            "instructionCompleted": self.completed,
            "resumeFlags": format!("0x{:x}", self.resume_flags),
        })
    }
}

fn valid_flags(flags: u64) -> bool {
    flags & !flags::IMPORTED_MASK == 0 && flags & 2 != 0
}

impl Core {
    pub(super) fn boundary_observed(&self) -> bool {
        let state = unsafe { &*self.state.get() };
        state.flags & (flags::TF | flags::RF) != 0 || state.interruptibility != 0
    }

    pub(super) fn owner_matches_boundary(&self, owner: u64) -> bool {
        self.observed_owners.contains(&owner) == self.boundary_observed()
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn core_boundary_observed() -> i32 {
    BRIDGE.with_borrow(|bridge| i32::from(bridge.core.as_ref().unwrap().boundary_observed()))
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
        let result = match operation.kind {
            SystemFlagsKind::Push => flags::push(flags, operation.width, &core.context),
            SystemFlagsKind::Pop => flags::pop(flags, input, operation.width, &core.context),
            SystemFlagsKind::Cli | SystemFlagsKind::Sti => {
                flags::interrupt(flags, operation.kind == SystemFlagsKind::Sti, &core.context)
            }
        };
        core.fault = None;
        core.segment_fault = None;
        core.alignment_fault = None;
        core.simd_exception = None;
        core.general_protection = None;
        core.protection_fault = None;
        core.system_memory_fault = None;
        core.debug_exception = None;
        core.divide_failed = false;
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
        let mut resume_flags = flags::architectural(flags, &core.context);
        if completed == 0 {
            resume_flags |= flags::RF;
        }
        core.debug_exception = Some(DebugException {
            instruction_pc,
            resume_pc,
            completed: completed != 0,
            resume_flags,
        });
        unsafe {
            if (*core.state.get()).delivery_enabled == 0 {
                (*core.state.get()).interruptibility = 0;
            }
        };
        DEBUG_EXCEPTION
    })
}
