use super::*;

impl Core {
    fn access_failure(&mut self, failure: AccessFailure) {
        match failure {
            AccessFailure::Linear(fault) => self.fault = Some(fault),
            AccessFailure::Segment(fault) => self.segment_fault = Some(fault),
        }
    }

    fn segment_address(
        &mut self,
        offset: u64,
        width: u32,
        segment: Segment,
        access: Access,
        rmw: bool,
    ) -> Option<u64> {
        self.fault = None;
        self.segment_fault = None;
        unsafe {
            (*self.state.get()).fault_segment = segment as u32;
        }
        match self.context.translate(offset, width, segment, access, rmw) {
            Ok(address) => Some(address),
            Err(failure) => {
                self.access_failure(failure);
                None
            }
        }
    }
}

pub(super) fn segment_fault_json(fault: &SegmentFault) -> serde_json::Value {
    serde_json::json!({
        "segment":fault.segment.name(),
        "offset":format!("0x{:x}",fault.offset),
        "width":fault.width,
        "access":match fault.access {Access::Read=>"read",Access::Write=>"write",Access::Execute=>"execute"},
        "cause":match fault.cause {SegmentCause::Unusable=>"unusable",SegmentCause::Type=>"type",SegmentCause::Limit=>"limit"},
        "failingOffset":format!("0x{:x}",fault.failing),
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_context_info() {
    BRIDGE.with_borrow_mut(|bridge| {
        bridge.info = serde_json::to_vec(&bridge.core.as_ref().unwrap().context.to_json()).unwrap();
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn core_context_version() -> u64 {
    BRIDGE.with_borrow(|bridge| bridge.core.as_ref().unwrap().context_version)
}

#[unsafe(no_mangle)]
pub extern "C" fn core_set_context() -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        let result = serde_json::from_slice(&bridge.input)
            .map_err(|_| "invalid execution context")
            .and_then(|value| ExecutionContext::from_json(&value));
        let context = match result {
            Ok(context) => context,
            Err(message) => return bridge.error(message),
        };
        let core = bridge.core.as_mut().unwrap();
        if core.context != context {
            core.image.retire_sources();
            core.context = context;
            core.context_version = core.context_version.saturating_add(1);
            core.fault = None;
            core.segment_fault = None;
            core.divide_failed = false;
        }
        0
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_segmented_load(offset: u64, width: u32, segment: u32) -> u64 {
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        let Some(address) = core.segment_address(
            offset,
            width,
            Segment::from_id(segment),
            Access::Read,
            false,
        ) else {
            return 0;
        };
        match core.image.read(address, width) {
            Ok(value) => value,
            Err(fault) => {
                core.fault = Some(fault);
                0
            }
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_segmented_load_for_write(offset: u64, width: u32, segment: u32) -> u64 {
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        let Some(address) = core.segment_address(
            offset,
            width,
            Segment::from_id(segment),
            Access::Write,
            true,
        ) else {
            return 0;
        };
        match core.image.read_for_write(address, width) {
            Ok(value) => value,
            Err(fault) => {
                core.fault = Some(fault);
                0
            }
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_segmented_store(offset: u64, width: u32, value: u64, segment: u32) -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        let Some(address) = core.segment_address(
            offset,
            width,
            Segment::from_id(segment),
            Access::Write,
            false,
        ) else {
            return 0;
        };
        match core.image.write(address, width, value) {
            Ok(()) => {
                if core.image.active_changed() {
                    2
                } else {
                    1
                }
            }
            Err(fault) => {
                core.fault = Some(fault);
                0
            }
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_access_reason() -> i32 {
    BRIDGE.with_borrow(|bridge| {
        if bridge.core.as_ref().unwrap().segment_fault.is_some() {
            SEGMENT
        } else {
            DATA
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_target_check(target: u64) -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        core.fault = None;
        core.segment_fault = None;
        unsafe {
            (*core.state.get()).fault_segment = Segment::Cs as u32;
        }
        match core.context.check_target(target) {
            Ok(()) => 1,
            Err(failure) => {
                core.access_failure(failure);
                0
            }
        }
    })
}
