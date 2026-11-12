use super::*;
use crate::x86::processor;

#[unsafe(no_mangle)]
pub extern "C" fn core_processor(kind: u32, eax: u32, ecx: u32, retired: u64) -> i32 {
    if kind > 2 {
        return -1;
    }
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        if kind != 0 {
            if let Err(fault) = processor::admit_timestamp(&core.context, core.paging) {
                core.protection_fault = Some(fault);
                return super::super::layout::PROTECTION;
            }
        }
        let raw = unsafe { &mut *core.state.get() };
        if kind == 0 {
            for (slot, value) in raw
                .vector_scratch
                .chunks_exact_mut(4)
                .zip(processor::cpuid(eax, ecx))
            {
                slot.copy_from_slice(&value.to_le_bytes());
            }
        } else {
            raw.vector_scratch[..8].copy_from_slice(&raw.time.sample(retired).to_le_bytes());
            raw.vector_scratch[8..12].copy_from_slice(&raw.time.tsc_aux.to_le_bytes());
        }
        0
    })
}
