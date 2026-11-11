use super::*;
use crate::embedding::layout::{ALIGNMENT, X87_EXCEPTION};
use crate::x86::context::Mode;
use crate::x86::mmx::{self, Op};

#[unsafe(no_mangle)]
pub extern "C" fn core_mmx(operation: u32, operand: u64, segment: u32) -> i32 {
    core_mmx_impl::<false, false>(operation, operand, segment)
}

#[unsafe(no_mangle)]
pub extern "C" fn core_mmx_observed(operation: u32, operand: u64, segment: u32) -> i32 {
    core_mmx_impl::<true, false>(operation, operand, segment)
}

fn core_mmx_impl<const OBSERVED: bool, const PAGED: bool>(
    operation: u32,
    operand: u64,
    segment: u32,
) -> i32 {
    let Some(operation) = Op::try_decode(operation) else {
        return -1;
    };
    let Some(segment) = Segment::ALL.get(segment as usize).copied() else {
        return -1;
    };
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        core.fault = None;
        core.segment_fault = None;
        core.alignment_fault = None;
        core.simd_exception = None;
        core.numeric_fault = None;
        core.general_protection = None;
        core.protection_fault = None;
        core.system_memory_fault = None;
        core.divide_failed = false;
        let (before, mxcsr) = unsafe {
            let state = &mut *core.state.get();
            state.target = 0;
            state.fault_segment = Segment::Cs as u32;
            (state.x87, state.mxcsr)
        };
        if operation.checks_pending() && before.pending() != 0 {
            return X87_EXCEPTION;
        }
        let width = operation.memory_bytes();
        let mut address = None;
        let input = if width != 0 {
            let access = if operation.is_store() {
                Access::Write
            } else {
                Access::Read
            };
            let alignment = if width == 16 { 16 } else { 1 };
            let Some(linear) =
                core.vector_address(operand, width, segment as u32, alignment, access)
            else {
                return if core.alignment_fault.is_some() {
                    ALIGNMENT
                } else if core.segment_fault.is_some() {
                    SEGMENT
                } else {
                    DATA
                };
            };
            address = Some(linear);
            if operation.is_store() {
                if let Err(fault) = guest_access!(core, PAGED, check_write(linear, width)) {
                    core.access_failure(fault);
                    return core.memory_failure_reason();
                }
                0
            } else {
                match guest_access!(core, PAGED, read_vector(linear, width)) {
                    Ok(bytes) => u128::from_le_bytes(bytes),
                    Err(fault) => {
                        core.access_failure(fault);
                        return core.memory_failure_reason();
                    }
                }
            }
        } else if let Some(index) = operation.source_xmm() {
            unsafe { u128::from_le_bytes((*core.state.get()).xmm[usize::from(index)]) }
        } else {
            u128::from(operand)
        };
        let old_xmm = operation.destination_xmm().map_or(0, |index| unsafe {
            u128::from_le_bytes((*core.state.get()).xmm[usize::from(index)])
        });
        let mut candidate = before;
        let outcome = mmx::eval(&mut candidate, operation, input, old_xmm, mxcsr);
        if let Some(stage) = outcome.stage {
            unsafe {
                (*core.state.get()).mxcsr = outcome.mxcsr;
            }
            return core.simd_failure(
                numeric::SimdException {
                    stage,
                    raised: outcome.raised,
                    before: mxcsr,
                    after: outcome.mxcsr,
                },
                crate::x86::numeric_controls::Family::Bridge,
            );
        }
        if operation.is_store()
            && let Err(fault) = guest_access!(
                core,
                PAGED,
                write_bytes(
                    address.unwrap(),
                    &outcome.value.to_le_bytes()[..width as usize],
                )
            )
        {
            core.access_failure(fault);
            return core.memory_failure_reason();
        }
        unsafe {
            let state = &mut *core.state.get();
            state.x87 = candidate;
            state.mxcsr = outcome.mxcsr;
            if let Some(index) = operation.destination_xmm() {
                state.xmm[usize::from(index)] = outcome.value.to_le_bytes();
            }
            if let Some(index) = operation.destination_gpr() {
                state.registers[usize::from(index)] = if operation.wide {
                    outcome.value as u64
                } else if core.context.mode() == Mode::Long64 {
                    outcome.value as u32 as u64
                } else {
                    (operand & !0xffff_ffff) | u64::from(outcome.value as u32)
                };
            }
        }
        if OBSERVED && let Some(address) = address {
            if !operation.is_store() {
                core.debug_operand(address, width, Access::Read);
            }
            if operation.is_store() {
                core.debug_operand(address, width, Access::Write);
            }
        }
        if operation.is_store() && core.image.active_changed() {
            2
        } else {
            0
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_paged_mmx(operation: u32, operand: u64, segment: u32) -> i32 {
    core_mmx_impl::<false, true>(operation, operand, segment)
}

#[unsafe(no_mangle)]
pub extern "C" fn core_paged_mmx_observed(operation: u32, operand: u64, segment: u32) -> i32 {
    core_mmx_impl::<true, true>(operation, operand, segment)
}
