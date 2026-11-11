use super::*;
use crate::embedding::layout::X87_EXCEPTION;
use crate::x86::masked;

#[unsafe(no_mangle)]
pub extern "C" fn core_masked_store(
    offset: u64,
    width: u32,
    data_ptr: u32,
    mask_bits: u32,
    segment: u32,
) -> i32 {
    core_masked_store_impl::<false, false>(offset, width, data_ptr, mask_bits, segment)
}

#[unsafe(no_mangle)]
pub extern "C" fn core_masked_store_observed(
    offset: u64,
    width: u32,
    data_ptr: u32,
    mask_bits: u32,
    segment: u32,
) -> i32 {
    core_masked_store_impl::<true, false>(offset, width, data_ptr, mask_bits, segment)
}

fn core_masked_store_impl<const OBSERVED: bool, const PAGED: bool>(
    offset: u64,
    width: u32,
    data_ptr: u32,
    mask_bits: u32,
    segment: u32,
) -> i32 {
    if !matches!(width, 8 | 16) || mask_bits >> width != 0 {
        return -1;
    }
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
        unsafe {
            let state = &mut *core.state.get();
            state.target = 0;
            state.fault_segment = segment as u32;
            if width == 8 && state.x87.pending() != 0 {
                return X87_EXCEPTION;
            }
        }
        unsafe {
            let state = &*core.state.get();
            assert_eq!(
                data_ptr,
                state.vector_scratch.as_ptr() as u32,
                "invalid masked scratch pointer"
            );
        }
        let Some(address) = core.segment_address(offset, width, segment, Access::Write, false)
        else {
            return if core.segment_fault.is_some() {
                SEGMENT
            } else {
                DATA
            };
        };
        let result = if mask_bits == 0 {
            guest_access!(core, PAGED, check_write(address, width))
        } else {
            let bytes = unsafe { (*core.state.get()).vector_scratch };
            let selection = masked::select(mask_bits as u16, width);
            guest_access!(
                core,
                PAGED,
                write_fields(address, width, selection.fields(), &bytes)
            )
        };
        if let Err(fault) = result {
            core.access_failure(fault);
            return core.memory_failure_reason();
        }
        if OBSERVED {
            for index in 0..width {
                if mask_bits & (1 << index) != 0 {
                    core.debug_operand(address + u64::from(index), 1, Access::Write);
                }
            }
        }
        if width == 8 {
            unsafe {
                let state = &mut *core.state.get();
                state.x87.status_word &= !0x3800;
                state.x87.tag_word = 0;
            }
        }
        if core.image.active_changed() { 2 } else { 0 }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_clflush(offset: u64, segment: u32) -> i32 {
    core_clflush_impl::<false>(offset, segment)
}

#[unsafe(no_mangle)]
pub extern "C" fn core_paged_clflush(offset: u64, segment: u32) -> i32 {
    core_clflush_impl::<true>(offset, segment)
}

fn core_clflush_impl<const PAGED: bool>(offset: u64, segment: u32) -> i32 {
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
        unsafe {
            let state = &mut *core.state.get();
            state.target = 0;
            state.fault_segment = segment as u32;
        }
        let address = match core.context.translate_clflush(offset, segment) {
            Ok(address) => address,
            Err(failure) => {
                core.access_failure(failure);
                return if core.segment_fault.is_some() {
                    SEGMENT
                } else {
                    DATA
                };
            }
        };
        match guest_access!(core, PAGED, check_read(address, 1)) {
            Ok(()) => 0,
            Err(fault) => {
                core.access_failure(fault);
                core.memory_failure_reason()
            }
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_paged_masked_store(
    offset: u64,
    width: u32,
    data_ptr: u32,
    mask_bits: u32,
    segment: u32,
) -> i32 {
    core_masked_store_impl::<false, true>(offset, width, data_ptr, mask_bits, segment)
}

#[unsafe(no_mangle)]
pub extern "C" fn core_paged_masked_store_observed(
    offset: u64,
    width: u32,
    data_ptr: u32,
    mask_bits: u32,
    segment: u32,
) -> i32 {
    core_masked_store_impl::<true, true>(offset, width, data_ptr, mask_bits, segment)
}
