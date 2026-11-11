use super::*;
use crate::embedding::layout::{DEVICE_NOT_AVAILABLE, SIMD_EXCEPTION};
use crate::x86::numeric_controls::{self, Family, Fault};

impl Core {
    pub(super) fn numeric_admission(
        &mut self,
        operation: crate::x86::instruction::Operation,
        pc: u64,
    ) -> i32 {
        self.numeric_fault = None;
        self.numeric_form = numeric_controls::family(operation).map(|family| (family, pc));
        let Some(bank) = self.paging else {
            return 0;
        };
        let Some(fault) = numeric_controls::admission(operation, bank.numeric_controls(), pc)
        else {
            return 0;
        };
        self.numeric_fault = Some(fault);
        if fault.kind == 1 {
            DEVICE_NOT_AVAILABLE
        } else {
            INVALID
        }
    }

    pub(super) fn simd_failure(
        &mut self,
        exception: numeric::SimdException,
        family: Family,
    ) -> i32 {
        if let Some(bank) = self.paging
            && bank.cr4 & (1 << 10) == 0
        {
            let pc = self
                .numeric_form
                .map_or_else(|| unsafe { (*self.state.get()).rip }, |(_, pc)| pc);
            self.numeric_fault = Some(Fault {
                kind: 4,
                family,
                controls: bank.numeric_controls(),
                instruction_pc: pc,
                stage: if exception.stage == crate::x86::float::Stage::PreComputation {
                    1
                } else {
                    2
                },
                raised: exception.raised,
                before: exception.before,
                after: exception.after,
            });
            self.simd_exception = None;
            INVALID
        } else {
            self.simd_exception = Some(exception);
            SIMD_EXCEPTION
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn core_numeric_fault_info() {
    BRIDGE.with_borrow_mut(|bridge| {
        bridge.info =
            serde_json::to_vec(&bridge.core.as_ref().unwrap().numeric_fault.map(Fault::json))
                .unwrap();
    });
}
