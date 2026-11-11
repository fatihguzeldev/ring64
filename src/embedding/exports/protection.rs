use super::*;
use crate::embedding::layout::{PROTECTION, SYSTEM_MEMORY};
use crate::x86::instruction::ProtectionDescriptor;
use crate::x86::protection::{self as semantics, Failure, ProtectionFault, SystemMemoryFault};

pub(super) fn fault_json(fault: &ProtectionFault) -> serde_json::Value {
    let mut value = serde_json::json!({
        "vector":fault.vector, "errorCode":fault.error_code, "phase":fault.phase.as_str(),
    });
    if let Some(selector) = fault.selector {
        value["selector"] = serde_json::json!(selector);
    }
    value
}

pub(super) fn system_fault_json(fault: &SystemMemoryFault) -> serde_json::Value {
    let mut value = serde_json::json!({
        "address":format!("0x{:x}",fault.address), "width":fault.width,
        "access":match fault.access { Access::Read=>"read", Access::Write=>"write", Access::Execute=>"execute" },
        "cause":match fault.cause { Cause::AddressRange=>"address-range", Cause::Noncanonical=>"noncanonical", Cause::Unmapped=>"unmapped", Cause::Permission=>"permission" },
        "failingAddress":format!("0x{:x}",fault.failing_address),
        "phase":fault.phase.as_str(), "table":fault.table.as_str(),
    });
    let (key, reference) = match fault.reference {
        semantics::SystemReference::Selector(selector) => ("selector", selector),
        semantics::SystemReference::Vector(vector) => ("vector", u16::from(vector)),
    };
    value[key] = serde_json::json!(reference);
    value
}

#[unsafe(no_mangle)]
pub extern "C" fn core_protection(descriptor: u32, offset: u64, input: u64, segment: u32) -> i32 {
    core_protection_impl::<false, false>(descriptor, offset, input, segment)
}

#[unsafe(no_mangle)]
pub extern "C" fn core_protection_observed(
    descriptor: u32,
    offset: u64,
    input: u64,
    segment: u32,
) -> i32 {
    core_protection_impl::<true, false>(descriptor, offset, input, segment)
}

fn core_protection_impl<const OBSERVED: bool, const PAGED: bool>(
    descriptor: u32,
    offset: u64,
    input: u64,
    segment: u32,
) -> i32 {
    let Some(descriptor) = ProtectionDescriptor::try_decode(descriptor) else {
        return -1;
    };
    let Some(segment) = Segment::ALL.get(segment as usize).copied() else {
        return -1;
    };
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        if !semantics::valid_in_mode(descriptor, &core.context) {
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
            semantics::execute,
            descriptor,
            offset,
            input,
            segment,
        ) {
            Err(Failure::SystemPaging(fault)) => return core.system_paging_failure(fault),
            Ok(outcome) => outcome,
            Err(Failure::Operand(failure)) => {
                core.access_failure(failure);
                return if core.segment_fault.is_some() {
                    SEGMENT
                } else {
                    core.memory_failure_reason()
                };
            }
            Err(Failure::Protection(fault)) => {
                core.protection_fault = Some(fault);
                return PROTECTION;
            }
            Err(Failure::SystemMemory(fault)) => {
                core.system_memory_fault = Some(fault);
                return SYSTEM_MEMORY;
            }
        };
        if let Some(before) = before {
            core.debug_candidate |= crate::x86::protection::operands::protection(
                unsafe { &(*core.state.get()).debug.registers },
                &before,
                descriptor,
                offset,
                segment,
            );
        }
        unsafe {
            let scratch = &mut (*core.state.get()).vector_scratch;
            scratch[..8].copy_from_slice(&outcome.value.unwrap_or(0).to_le_bytes());
            scratch[8] =
                u8::from(outcome.value.is_some()) | (u8::from(outcome.zero == Some(true)) << 1);
        }
        if outcome.context_changed {
            core.context_changed();
        }
        if outcome.context_changed || core.image.active_changed() {
            2
        } else {
            0
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_paged_protection(
    descriptor: u32,
    offset: u64,
    input: u64,
    segment: u32,
) -> i32 {
    core_protection_impl::<false, true>(descriptor, offset, input, segment)
}

#[unsafe(no_mangle)]
pub extern "C" fn core_paged_protection_observed(
    descriptor: u32,
    offset: u64,
    input: u64,
    segment: u32,
) -> i32 {
    core_protection_impl::<true, true>(descriptor, offset, input, segment)
}
