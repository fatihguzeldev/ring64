use super::*;

impl Core {
    fn reset(&mut self) {
        // Retire proofs before replacing architectural banks. Keep Image and its
        // monotonic owner allocator: old pending handles can never name new code.
        self.retire_translations();
        self.context = ExecutionContext::reset();
        self.paging = Some(crate::x86::paging::State::reset());
        self.fast_system = Default::default();
        unsafe { *self.state.get() = RunState::reset() };
        self.io_effect = false;
        self.paging_work.clear();
        self.paging_failure = None;
        self.pdpte_load_fault = None;
        self.paging_system = None;
        self.fault = None;
        self.divide_failed = false;
        self.decode_fault = None;
        self.segment_fault = None;
        self.alignment_fault = None;
        self.simd_exception = None;
        self.numeric_fault = None;
        self.numeric_form = None;
        self.general_protection = None;
        self.protection_fault = None;
        self.system_memory_fault = None;
        self.debug_exception = None;
        self.debug_candidate = 0;
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn core_reset() -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        let Some(core) = bridge.core.as_mut() else {
            return bridge.error("CPU is disposed");
        };
        if !core.physical_controls {
            return bridge.error("reset requires physical memory");
        }
        core.reset();
        0
    })
}
