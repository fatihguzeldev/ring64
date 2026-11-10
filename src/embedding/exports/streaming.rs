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
            core.image.check_write(address, width)
        } else {
            let bytes = unsafe { (*core.state.get()).vector_scratch };
            let selection = masked::select(mask_bits as u16, width);
            core.image
                .write_fields(address, width, selection.fields(), &bytes)
        };
        if let Err(fault) = result {
            core.fault = Some(fault);
            return DATA;
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
    let Some(segment) = Segment::ALL.get(segment as usize).copied() else {
        return -1;
    };
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        core.fault = None;
        core.segment_fault = None;
        core.alignment_fault = None;
        core.simd_exception = None;
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
        match core.image.check_read(address, 1) {
            Ok(()) => 0,
            Err(fault) => {
                core.fault = Some(fault);
                DATA
            }
        }
    })
}
