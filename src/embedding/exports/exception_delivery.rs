use super::*;
use crate::embedding::layout::{
    ALIGNMENT, DEBUG_EXCEPTION, DISPATCH, DIVIDE_ERROR, GENERAL_PROTECTION, INVALID, PROTECTION,
    SHUTDOWN, SIMD_EXCEPTION, SYSTEM_MEMORY, X87_EXCEPTION,
};
use crate::x86::exception::{EventState, ExceptionEvent};
use crate::x86::flags;
use crate::x86::protection::event::{self, EventFailure};

#[unsafe(no_mangle)]
pub extern "C" fn core_configure_delivery(enabled: i32) -> i32 {
    if !matches!(enabled, 0 | 1) {
        return -1;
    }
    BRIDGE.with_borrow_mut(|bridge| {
        unsafe { (*bridge.core.as_mut().unwrap().state.get()).delivery_enabled = enabled as u32 };
        0
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_stage_exception(reason: i32) -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        let state = unsafe { &mut *core.state.get() };
        let enabled = state.delivery_enabled != 0;
        if state.event.kind != 0 {
            return if enabled { -1 } else { 0 };
        }
        let pc = state.rip;
        let event = match reason {
            DIVIDE_ERROR => ExceptionEvent::fault(0, pc, state.flags, &core.context, None),
            DEBUG_EXCEPTION => {
                let Some(debug) = core.debug_exception.as_ref() else {
                    return -1;
                };
                ExceptionEvent {
                    debug: debug.source,
                    vector: 1,
                    instruction_pc: debug.instruction_pc,
                    return_pc: debug.resume_pc,
                    saved_flags: debug.resume_flags,
                    error_code: None,
                }
            }
            PROTECTION => {
                let Some(fault) = core.protection_fault else {
                    return -1;
                };
                ExceptionEvent::fault(
                    fault.vector,
                    pc,
                    state.flags,
                    &core.context,
                    Some(fault.error_code),
                )
            }
            GENERAL_PROTECTION if core.general_protection.is_some() => {
                ExceptionEvent::fault(13, pc, state.flags, &core.context, Some(0))
            }
            SIMD_EXCEPTION if core.simd_exception.is_some() => {
                ExceptionEvent::fault(19, pc, state.flags, &core.context, None)
            }
            X87_EXCEPTION => ExceptionEvent::fault(16, pc, state.flags, &core.context, None),
            UNSUPPORTED | INVALID if core.decode_fault.is_some() => {
                let (vector, code) = core.decode_fault.unwrap().vector_and_code();
                if enabled {
                    state.flags &= !flags::RF;
                }
                ExceptionEvent::fault(vector, pc, state.flags, &core.context, code)
            }
            DATA | FETCH | SEGMENT | TARGET | ALIGNMENT | SYSTEM_MEMORY => {
                let selected = match reason {
                    DATA | FETCH => core.fault.and_then(|fault| {
                        crate::x86::protection::access_fault(
                            &core.context,
                            Segment::from_id(state.fault_segment),
                            AccessFailure::Linear(fault),
                        )
                    }),
                    SEGMENT => core.protection_fault.or_else(|| {
                        core.segment_fault.and_then(|fault| {
                            crate::x86::protection::access_fault(
                                &core.context,
                                fault.segment,
                                AccessFailure::Segment(fault),
                            )
                        })
                    }),
                    TARGET => core
                        .context
                        .check_target(state.target)
                        .err()
                        .and_then(|failure| {
                            crate::x86::protection::access_fault(
                                &core.context,
                                Segment::Cs,
                                failure,
                            )
                        }),
                    ALIGNMENT => core
                        .alignment_fault
                        .as_ref()
                        .map(|_| crate::x86::protection::alignment_fault()),
                    SYSTEM_MEMORY => core.system_memory_fault.and_then(|fault| {
                        crate::x86::protection::system_fault(&core.context, fault)
                    }),
                    _ => unreachable!(),
                };
                let Some(fault) = selected else {
                    return 0;
                };
                ExceptionEvent::fault(
                    fault.vector,
                    pc,
                    state.flags,
                    &core.context,
                    Some(fault.error_code),
                )
            }
            _ => return 0,
        };
        if reason != DEBUG_EXCEPTION || event.debug.is_some_and(crate::x86::debug::Source::fault) {
            state.debug.continuation = super::super::layout::debug::Continuation::default();
            core.debug_candidate = 0;
        }
        if !enabled {
            return 0;
        }
        if event
            .validate(state.rip, state.flags, &core.context)
            .is_err()
        {
            return -1;
        }
        state.set_event(EventState::Pending(event));
        1
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_deliver_exception() -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        let (event, sp, flags) = unsafe {
            let state = &*core.state.get();
            let event = match state.event_state() {
                Ok(event @ (EventState::Pending(_) | EventState::PendingInterrupt(_))) => event,
                _ => return -1,
            };
            (event, state.registers[4], state.flags)
        };
        core.fault = None;
        core.segment_fault = None;
        core.alignment_fault = None;
        core.simd_exception = None;
        core.general_protection = None;
        core.protection_fault = None;
        core.system_memory_fault = None;
        core.debug_exception = None;
        core.divide_failed = false;
        core.decode_fault = None;
        let outcome = match event {
            EventState::Pending(event) => {
                event::enter_exception(&mut core.context, &mut core.image, event, sp, flags)
            }
            EventState::PendingInterrupt(event) => {
                event::enter_interrupt(&mut core.context, &mut core.image, event, sp, flags)
            }
            _ => unreachable!("pending entry source"),
        }
        .map_err(|failure| {
            failure
                .architectural(&core.context)
                .map_or(failure, EventFailure::Protection)
        });
        match outcome {
            Ok(outcome) => {
                unsafe {
                    let state = &mut *core.state.get();
                    state.rip = outcome.pc;
                    state.registers[4] = outcome.sp;
                    state.flags = outcome.flags;
                    state.interruptibility = 0;
                    state.set_event(EventState::Ready);
                    if matches!(event,EventState::Pending(e) if e.vector==1) {
                        state.debug.registers.enter();
                    }
                }
                if outcome.context_changed {
                    core.image.retire_sources();
                    core.context_version = core.context_version.saturating_add(1);
                }
                DISPATCH
            }
            Err(EventFailure::Protection(fault))
            | Err(EventFailure::StackLimit {
                protection: fault, ..
            }) => {
                let next = match event {
                    EventState::Pending(event) => event.escalate(fault.vector, fault.error_code),
                    EventState::PendingInterrupt(event) => {
                        event.escalate(fault.vector, fault.error_code)
                    }
                    _ => unreachable!("pending entry source"),
                };
                unsafe { (*core.state.get()).set_event(next) };
                if next == EventState::Shutdown {
                    SHUTDOWN
                } else {
                    DISPATCH
                }
            }
            Err(EventFailure::Operand { segment, failure }) => {
                unsafe { (*core.state.get()).fault_segment = segment as u32 };
                core.access_failure(failure);
                if core.segment_fault.is_some() {
                    SEGMENT
                } else {
                    DATA
                }
            }
            Err(EventFailure::SystemMemory(fault)) => {
                core.system_memory_fault = Some(fault);
                SYSTEM_MEMORY
            }
            Err(EventFailure::Unsupported) => UNSUPPORTED,
        }
    })
}
