use super::*;
use crate::embedding::layout::{PROTECTION, SYSTEM_MEMORY};
use crate::x86::instruction::{FarDescriptor, FarKind};
use crate::x86::protection::far::{self, FarFailure, FarOperands};

#[unsafe(no_mangle)]
pub extern "C" fn core_far_control(
    descriptor: u32,
    offset: u64,
    selector: u32,
    input_sp: u64,
    next_pc: u64,
    segment: u32,
) -> i32 {
    core_far_control_impl::<false, false>(descriptor, offset, selector, input_sp, next_pc, segment)
}

#[unsafe(no_mangle)]
pub extern "C" fn core_far_control_observed(
    descriptor: u32,
    offset: u64,
    selector: u32,
    input_sp: u64,
    next_pc: u64,
    segment: u32,
) -> i32 {
    core_far_control_impl::<true, false>(descriptor, offset, selector, input_sp, next_pc, segment)
}

fn core_far_control_impl<const OBSERVED: bool, const PAGED: bool>(
    descriptor: u32,
    offset: u64,
    selector: u32,
    input_sp: u64,
    next_pc: u64,
    segment: u32,
) -> i32 {
    let Some(descriptor) = FarDescriptor::try_decode(descriptor) else {
        return -1;
    };
    let Some(segment) = Segment::ALL.get(segment as usize).copied() else {
        return -1;
    };
    if selector > u16::MAX as u32
        || (descriptor.memory || descriptor.kind == FarKind::Return) && selector != 0
        || descriptor.kind == FarKind::Return
            && (offset > u64::from(u16::MAX) || segment != Segment::Ss)
        || !descriptor.memory
            && descriptor.kind != FarKind::Return
            && offset & !descriptor.width.mask() != 0
    {
        return -1;
    }
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        if !far::valid_in_mode(descriptor, &core.context) {
            return -1;
        }
        core.fault = None;
        core.segment_fault = None;
        core.alignment_fault = None;
        core.simd_exception = None;
        core.general_protection = None;
        core.protection_fault = None;
        core.system_memory_fault = None;
        core.divide_failed = false;
        unsafe {
            (*core.state.get()).target = 0;
            (*core.state.get()).fault_segment = segment as u32;
        }
        let before = OBSERVED.then(|| core.context.clone());
        let outcome = match guest_semantics!(
            core,
            PAGED,
            far::execute,
            descriptor,
            FarOperands {
                offset,
                selector: selector as u16,
                input_sp,
                next_pc,
                segment,
            },
        ) {
            Err(FarFailure::SystemPaging(fault)) => return core.system_paging_failure(fault),
            Ok(outcome) => outcome,
            Err(FarFailure::Operand { segment, failure }) => {
                unsafe {
                    (*core.state.get()).fault_segment = segment as u32;
                }
                core.access_failure(failure);
                return if core.segment_fault.is_some() {
                    SEGMENT
                } else {
                    core.memory_failure_reason()
                };
            }
            Err(FarFailure::Protection(fault)) => {
                core.protection_fault = Some(fault);
                return PROTECTION;
            }
            Err(FarFailure::SystemMemory(fault)) => {
                core.system_memory_fault = Some(fault);
                return SYSTEM_MEMORY;
            }
            Err(FarFailure::Unsupported) => return UNSUPPORTED,
        };
        if let Some(before) = before {
            core.debug_candidate |= crate::x86::protection::operands::far(
                unsafe { &(*core.state.get()).debug.registers },
                &before,
                &core.context,
                descriptor,
                offset,
                input_sp,
                segment,
            );
        }
        unsafe {
            let scratch = &mut (*core.state.get()).vector_scratch;
            scratch[..8].copy_from_slice(&outcome.pc.to_le_bytes());
            scratch[8..].copy_from_slice(&outcome.sp.to_le_bytes());
        }
        if outcome.context_changed {
            core.image.retire_sources();
            core.context_version = core.context_version.saturating_add(1);
        }
        0
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_paged_far_control(
    descriptor: u32,
    offset: u64,
    selector: u32,
    input_sp: u64,
    next_pc: u64,
    segment: u32,
) -> i32 {
    core_far_control_impl::<false, true>(descriptor, offset, selector, input_sp, next_pc, segment)
}

#[unsafe(no_mangle)]
pub extern "C" fn core_paged_far_control_observed(
    descriptor: u32,
    offset: u64,
    selector: u32,
    input_sp: u64,
    next_pc: u64,
    segment: u32,
) -> i32 {
    core_far_control_impl::<true, true>(descriptor, offset, selector, input_sp, next_pc, segment)
}
