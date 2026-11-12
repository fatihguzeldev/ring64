use super::*;
use crate::embedding::layout::X87_EXCEPTION;
use crate::x86::context::Mode;
use crate::x86::x87::{self, Op};

fn saved_pointer(context: &ExecutionContext, offset: u64, segment: Segment) -> u64 {
    match context.mode() {
        Mode::Long64 => offset,
        Mode::Real | Mode::Virtual8086 => {
            context.segment_base(segment).wrapping_add(offset) as u32 as u64
        }
        Mode::Protected | Mode::Compatibility => offset as u32 as u64,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn core_x87(
    operation: u32,
    offset: u64,
    segment: u32,
    instruction_pc: u64,
    flags: u64,
    rax: u64,
) -> i32 {
    core_x87_impl::<false, false>(operation, offset, segment, instruction_pc, flags, rax)
}

#[unsafe(no_mangle)]
pub extern "C" fn core_x87_observed(
    operation: u32,
    offset: u64,
    segment: u32,
    instruction_pc: u64,
    flags: u64,
    rax: u64,
) -> i32 {
    core_x87_impl::<true, false>(operation, offset, segment, instruction_pc, flags, rax)
}

fn core_x87_impl<const OBSERVED: bool, const PAGED: bool>(
    operation: u32,
    offset: u64,
    segment: u32,
    instruction_pc: u64,
    flags: u64,
    rax: u64,
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
        let pending = unsafe {
            let state = &mut *core.state.get();
            state.target = 0;
            state.fault_segment = Segment::Cs as u32;
            state.x87.pending()
        };
        if operation.is_waiting() && pending != 0 {
            return core.pending_x87_reason();
        }
        let width = operation.memory_bytes();
        let mut address = None;
        let source = if width == 0 {
            0
        } else {
            let access = if operation.is_store() {
                Access::Write
            } else {
                Access::Read
            };
            let Some(linear) = core.segment_address(offset, width, segment, access, false) else {
                return if core.segment_fault.is_some() {
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
        };
        // Operand admission cannot mutate x87; snapshot it only after those checks.
        let mut candidate = unsafe { (*core.state.get()).x87 };
        let effect = x87::eval(&mut candidate, operation, source, flags);
        if operation.updates_environment() {
            candidate.instruction_pointer =
                saved_pointer(&core.context, instruction_pc, Segment::Cs);
            if address.is_some() {
                candidate.data_pointer = saved_pointer(&core.context, offset, segment);
            }
            if candidate.pending() != 0 {
                candidate.opcode = operation.encoding;
            }
        }
        if effect.store {
            let linear = address.expect("x87 memory store address");
            if let Err(fault) = guest_access!(
                core,
                PAGED,
                write_bytes(linear, &effect.value.to_le_bytes()[..width as usize])
            ) {
                core.access_failure(fault);
                return core.memory_failure_reason();
            }
        }
        unsafe {
            let state = &mut *core.state.get();
            state.x87 = candidate;
            if operation.writes_flags() {
                state.flags = effect.flags;
            }
            if effect.ax {
                state.registers[0] = (rax & !0xffff) | (effect.value as u64 & 0xffff);
            }
        }
        if OBSERVED && let Some(address) = address {
            if !operation.is_store() {
                core.debug_operand(address, width, Access::Read);
            }
            if effect.store {
                core.debug_operand(address, width, Access::Write);
            }
        }
        if address.is_some() && core.image.active_changed() {
            2
        } else {
            0
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_paged_x87(
    operation: u32,
    offset: u64,
    segment: u32,
    instruction_pc: u64,
    flags: u64,
    rax: u64,
) -> i32 {
    core_x87_impl::<false, true>(operation, offset, segment, instruction_pc, flags, rax)
}

#[unsafe(no_mangle)]
pub extern "C" fn core_paged_x87_observed(
    operation: u32,
    offset: u64,
    segment: u32,
    instruction_pc: u64,
    flags: u64,
    rax: u64,
) -> i32 {
    core_x87_impl::<true, true>(operation, offset, segment, instruction_pc, flags, rax)
}

impl Core {
    pub(super) fn pending_x87_reason(&self) -> i32 {
        if self.paging.is_some_and(|bank| bank.cr0 & 0x20 == 0) {
            UNSUPPORTED
        } else {
            X87_EXCEPTION
        }
    }
}
