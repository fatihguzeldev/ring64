use super::*;
use crate::embedding::layout::{PROTECTION, SYSTEM_MEMORY};
use crate::x86::compound_stack::{self as semantics, CompoundStack};
use crate::x86::protection::Failure;

#[unsafe(no_mangle)]
pub extern "C" fn core_compound_stack(descriptor: u32) -> i32 {
    execute::<false, false>(descriptor)
}
#[unsafe(no_mangle)]
pub extern "C" fn core_compound_stack_observed(descriptor: u32) -> i32 {
    execute::<true, false>(descriptor)
}
#[unsafe(no_mangle)]
pub extern "C" fn core_paged_compound_stack(descriptor: u32) -> i32 {
    execute::<false, true>(descriptor)
}
#[unsafe(no_mangle)]
pub extern "C" fn core_paged_compound_stack_observed(descriptor: u32) -> i32 {
    execute::<true, true>(descriptor)
}

fn execute<const OBSERVED: bool, const PAGED: bool>(descriptor: u32) -> i32 {
    let Some(operation) = CompoundStack::try_decode(descriptor) else {
        return -1;
    };
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
        core.divide_failed = false;
        unsafe {
            (*core.state.get()).target = 0;
            (*core.state.get()).fault_segment = Segment::Ss as u32;
        }
        let registers = unsafe { &mut (*core.state.get()).registers };
        let mut candidate = 0;
        let result = if OBSERVED {
            let bank = unsafe { (*core.state.get()).debug.registers };
            guest_semantics!(
                core,
                PAGED,
                semantics::execute_observing,
                registers,
                operation,
                &mut |address, width, access| candidate |= bank.matches(address, width, access)
            )
        } else {
            guest_semantics!(core, PAGED, semantics::execute, registers, operation)
        };
        if PAGED && result.is_err() {
            core.paging_work.clear();
        }
        match result {
            Ok(()) => {
                core.debug_candidate |= candidate;
                if core.image.active_changed() { 2 } else { 0 }
            }
            Err(Failure::Operand(failure)) => {
                core.access_failure(failure);
                if core.segment_fault.is_some() {
                    SEGMENT
                } else {
                    core.memory_failure_reason()
                }
            }
            Err(Failure::Protection(fault)) => {
                core.protection_fault = Some(fault);
                PROTECTION
            }
            Err(Failure::SystemMemory(fault)) => {
                core.system_memory_fault = Some(fault);
                SYSTEM_MEMORY
            }
            Err(Failure::SystemPaging(fault)) => core.system_paging_failure(fault),
        }
    })
}
