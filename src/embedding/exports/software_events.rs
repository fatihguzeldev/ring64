use super::*;
use crate::embedding::layout::{PROTECTION, SYSTEM_MEMORY};
use crate::x86::flags;
use crate::x86::instruction::{SoftwareEventDescriptor, SoftwareEventKind};
use crate::x86::protection::event::{self, EventFailure, EventInputs};

#[unsafe(no_mangle)]
pub extern "C" fn core_software_event(
    operation: u32,
    input_sp: u64,
    input_flags: u64,
    next_pc: u64,
) -> i32 {
    core_software_event_impl::<false>(operation, input_sp, input_flags, next_pc)
}

#[unsafe(no_mangle)]
pub extern "C" fn core_software_event_observed(
    operation: u32,
    input_sp: u64,
    input_flags: u64,
    next_pc: u64,
) -> i32 {
    core_software_event_impl::<true>(operation, input_sp, input_flags, next_pc)
}

fn core_software_event_impl<const OBSERVED: bool>(
    operation: u32,
    input_sp: u64,
    input_flags: u64,
    next_pc: u64,
) -> i32 {
    let Some(operation) = SoftwareEventDescriptor::try_decode(operation) else {
        return -1;
    };
    if input_flags & !flags::IMPORTED_MASK != 0 || input_flags & 2 == 0 {
        return -1;
    }
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        if !event::valid_in_mode(operation, &core.context) {
            return -1;
        }
        if operation.kind == SoftwareEventKind::Return {
            unsafe { (*core.state.get()).interrupts.nmi_blocked = 0 };
        }
        core.fault = None;
        core.segment_fault = None;
        core.alignment_fault = None;
        core.simd_exception = None;
        core.general_protection = None;
        core.protection_fault = None;
        core.system_memory_fault = None;
        core.debug_exception = None;
        core.divide_failed = false;
        unsafe {
            (*core.state.get()).target = 0;
            (*core.state.get()).fault_segment = Segment::Cs as u32;
        }
        let before = OBSERVED.then(|| core.context.clone());
        let outcome = match event::execute(
            &mut core.context,
            &mut core.image,
            operation,
            EventInputs {
                flags: input_flags,
                sp: input_sp,
                next_pc,
            },
        ) {
            Err(EventFailure::SystemPaging(fault)) => return core.system_paging_failure(fault),
            Ok(outcome) => outcome,
            Err(EventFailure::Operand { segment, failure }) => {
                unsafe {
                    (*core.state.get()).fault_segment = segment as u32;
                }
                core.access_failure(failure);
                return if core.segment_fault.is_some() {
                    SEGMENT
                } else {
                    DATA
                };
            }
            Err(EventFailure::StackLimit {
                failure,
                protection,
            }) => {
                core.segment_fault = Some(failure);
                core.protection_fault = Some(protection);
                return SEGMENT;
            }
            Err(EventFailure::Protection(fault)) => {
                core.protection_fault = Some(fault);
                return PROTECTION;
            }
            Err(EventFailure::SystemMemory(fault)) => {
                core.system_memory_fault = Some(fault);
                return SYSTEM_MEMORY;
            }
            Err(EventFailure::Unsupported) => return UNSUPPORTED,
        };
        if let Some(before) = before {
            core.debug_candidate |= crate::x86::protection::operands::iret(
                unsafe { &(*core.state.get()).debug.registers },
                &before,
                &core.context,
                operation,
                input_sp,
            );
        }
        unsafe {
            let state = &mut *core.state.get();
            state.vector_scratch[..8].copy_from_slice(&outcome.pc.to_le_bytes());
            state.vector_scratch[8..].copy_from_slice(&outcome.sp.to_le_bytes());
            state.flags = outcome.flags;
            if operation.kind == SoftwareEventKind::Int1 {
                state.debug.registers.enter();
                state.debug.continuation = super::super::layout::debug::Continuation::default();
            }
        }
        if outcome.context_changed {
            core.image.retire_sources();
            core.context_version = core.context_version.saturating_add(1);
        }
        0
    })
}
