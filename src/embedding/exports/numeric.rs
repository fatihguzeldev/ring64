use super::*;
use crate::embedding::layout::{GENERAL_PROTECTION, SIMD_EXCEPTION};
use crate::x86::float::{self, Op, Stage};

pub(super) struct SimdException {
    pub(super) stage: Stage,
    pub(super) raised: u32,
    pub(super) before: u32,
    pub(super) after: u32,
}
impl SimdException {
    pub(super) fn json(&self) -> serde_json::Value {
        serde_json::json!({
            "vector":19,
            "stage":match self.stage {Stage::PreComputation=>"pre-computation",Stage::PostComputation=>"post-computation"},
            "raised":self.raised,
            "unmasked":self.raised & !(self.before >> 7) & 0x3f,
            "mxcsrBefore":self.before,
            "mxcsrAfter":self.after,
        })
    }
}

pub(super) struct GeneralProtectionFault {
    pub(super) loaded: u32,
}
impl GeneralProtectionFault {
    pub(super) fn json(&self) -> serde_json::Value {
        serde_json::json!({"vector":13,"errorCode":0,"cause":"mxcsr-reserved-bits","loadedValue":self.loaded})
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn core_import_mxcsr() -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        let Ok(bytes) = <[u8; 4]>::try_from(bridge.input.as_slice()) else {
            return bridge.error("MXCSR input length differs");
        };
        let value = u32::from_le_bytes(bytes);
        if value > 0xffff {
            return bridge.error("MXCSR contains reserved bits");
        }
        let core = bridge.core.as_mut().unwrap();
        unsafe {
            (*core.state.get()).mxcsr = value;
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
            (*core.state.get()).fault_segment = Segment::Cs as u32;
        }
        0
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_float(
    operation: u32,
    left_low: u64,
    left_high: u64,
    right_low: u64,
    right_high: u64,
) -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        core.simd_exception = None;
        core.general_protection = None;
        core.protection_fault = None;
        core.system_memory_fault = None;
        let before = unsafe { (*core.state.get()).mxcsr };
        let outcome = float::eval(
            Op::decode(operation),
            u128::from(left_low) | (u128::from(left_high) << 64),
            u128::from(right_low) | (u128::from(right_high) << 64),
            before,
        );
        unsafe {
            let state = &mut *core.state.get();
            state.mxcsr = outcome.mxcsr;
            state.vector_scratch = outcome.value.to_le_bytes();
        }
        if let Some(stage) = outcome.stage {
            core.simd_exception = Some(SimdException {
                stage,
                raised: outcome.raised,
                before,
                after: outcome.mxcsr,
            });
            SIMD_EXCEPTION
        } else {
            0
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_load_mxcsr(offset: u64, segment: u32) -> i32 {
    core_load_mxcsr_impl::<false, false>(offset, segment)
}

#[unsafe(no_mangle)]
pub extern "C" fn core_load_mxcsr_observed(offset: u64, segment: u32) -> i32 {
    core_load_mxcsr_impl::<true, false>(offset, segment)
}

fn core_load_mxcsr_impl<const OBSERVED: bool, const PAGED: bool>(offset: u64, segment: u32) -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        core.simd_exception = None;
        core.general_protection = None;
        core.protection_fault = None;
        core.system_memory_fault = None;
        core.alignment_fault = None;
        let Some(address) =
            core.segment_address(offset, 4, Segment::from_id(segment), Access::Read, false)
        else {
            return if core.segment_fault.is_some() {
                SEGMENT
            } else {
                DATA
            };
        };
        let value = match guest_access!(core, PAGED, read(address, 4)) {
            Ok(value) => value as u32,
            Err(fault) => {
                core.access_failure(fault);
                return core.memory_failure_reason();
            }
        };
        if value > 0xffff {
            core.general_protection = Some(GeneralProtectionFault { loaded: value });
            GENERAL_PROTECTION
        } else {
            unsafe {
                (*core.state.get()).mxcsr = value;
            }
            if OBSERVED {
                core.debug_operand(address, 4, Access::Read);
            }
            0
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_store_mxcsr(offset: u64, segment: u32) -> i32 {
    core_store_mxcsr_impl::<false, false>(offset, segment)
}

#[unsafe(no_mangle)]
pub extern "C" fn core_store_mxcsr_observed(offset: u64, segment: u32) -> i32 {
    core_store_mxcsr_impl::<true, false>(offset, segment)
}

fn core_store_mxcsr_impl<const OBSERVED: bool, const PAGED: bool>(
    offset: u64,
    segment: u32,
) -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        let value = unsafe { (*core.state.get()).mxcsr.to_le_bytes() };
        core.simd_exception = None;
        core.general_protection = None;
        core.protection_fault = None;
        core.system_memory_fault = None;
        core.alignment_fault = None;
        let Some(address) =
            core.segment_address(offset, 4, Segment::from_id(segment), Access::Write, false)
        else {
            return 0;
        };
        match guest_access!(core, PAGED, write_bytes(address, &value)) {
            Ok(()) => {
                if OBSERVED {
                    core.debug_operand(address, 4, Access::Write);
                }
                if core.image.active_changed() { 2 } else { 1 }
            }
            Err(fault) => {
                core.access_failure(fault);
                0
            }
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_paged_load_mxcsr(offset: u64, segment: u32) -> i32 {
    core_load_mxcsr_impl::<false, true>(offset, segment)
}

#[unsafe(no_mangle)]
pub extern "C" fn core_paged_load_mxcsr_observed(offset: u64, segment: u32) -> i32 {
    core_load_mxcsr_impl::<true, true>(offset, segment)
}

#[unsafe(no_mangle)]
pub extern "C" fn core_paged_store_mxcsr(offset: u64, segment: u32) -> i32 {
    core_store_mxcsr_impl::<false, true>(offset, segment)
}

#[unsafe(no_mangle)]
pub extern "C" fn core_paged_store_mxcsr_observed(offset: u64, segment: u32) -> i32 {
    core_store_mxcsr_impl::<true, true>(offset, segment)
}
