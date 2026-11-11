use super::*;
use crate::embedding::layout::{
    ALIGNMENT, DEBUG_EXCEPTION, DEVICE_NOT_AVAILABLE, DISPATCH, DIVIDE_ERROR, GENERAL_PROTECTION,
    INVALID, PAGE_FAULT, PROTECTION, SHUTDOWN, SIMD_EXCEPTION, SYSTEM_MEMORY, X87_EXCEPTION,
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

fn finish_entry_paging(
    core: &mut Core,
    event: EventState,
    failure: crate::x86::paging::walk::Failure,
    reason: i32,
) -> i32 {
    let crate::x86::paging::walk::Failure::Page(fault) = failure else {
        return reason;
    };
    let next = match event {
        EventState::Pending(event) => {
            event.escalate_page_fault(fault.error_code as u16, fault.address)
        }
        EventState::PendingInterrupt(event) => {
            event.escalate_page_fault(fault.error_code as u16, fault.address)
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
            PAGE_FAULT => {
                let Some(crate::x86::paging::walk::Failure::Page(fault)) = core.paging_failure
                else {
                    return -1;
                };
                if core.paging.is_none() {
                    return -1;
                }
                ExceptionEvent::page_fault(
                    pc,
                    state.flags,
                    &core.context,
                    fault.error_code as u16,
                    fault.address,
                )
            }
            DEVICE_NOT_AVAILABLE | INVALID if core.numeric_fault.is_some() => {
                let source = core.numeric_fault.unwrap();
                ExceptionEvent {
                    numeric: Some(source),
                    ..ExceptionEvent::fault(source.vector(), pc, state.flags, &core.context, None)
                }
            }
            DIVIDE_ERROR => ExceptionEvent::fault(0, pc, state.flags, &core.context, None),
            DEBUG_EXCEPTION => {
                let Some(debug) = core.debug_exception.as_ref() else {
                    return -1;
                };
                ExceptionEvent {
                    numeric: None,
                    page_fault_address: None,
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
        core.numeric_fault = None;
        core.general_protection = None;
        core.protection_fault = None;
        core.system_memory_fault = None;
        core.debug_exception = None;
        core.divide_failed = false;
        core.decode_fault = None;
        core.paging_failure = None;
        core.paging_system = None;
        let outcome = if let Some(bank) = core.paging {
            core.paging_work.clear();
            let cpl = core.context.cpl();
            let mut memory = crate::x86::paging::access::Memory::new(
                &mut core.image,
                &bank,
                cpl,
                &mut core.paging_work,
            );
            let outcome = match event {
                EventState::Pending(event) => {
                    event::enter_exception(&mut core.context, &mut memory, event, sp, flags)
                }
                EventState::PendingInterrupt(event) => {
                    event::enter_interrupt(&mut core.context, &mut memory, event, sp, flags)
                }
                _ => unreachable!("pending entry source"),
            };
            core.paging_work.clear();
            outcome
        } else {
            match event {
                EventState::Pending(event) => {
                    event::enter_exception(&mut core.context, &mut core.image, event, sp, flags)
                }
                EventState::PendingInterrupt(event) => {
                    event::enter_interrupt(&mut core.context, &mut core.image, event, sp, flags)
                }
                _ => unreachable!("pending entry source"),
            }
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
                    core.context_changed();
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
                if let AccessFailure::Paging(failure) = failure {
                    let reason = core.paging_failure(failure);
                    return finish_entry_paging(core, event, failure, reason);
                }
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
            Err(EventFailure::SystemPaging(fault)) => {
                let failure = fault.failure;
                let reason = core.system_paging_failure(fault);
                finish_entry_paging(core, event, failure, reason)
            }
            Err(EventFailure::Unsupported) => UNSUPPORTED,
        }
    })
}

#[cfg(test)]
mod paging_tests {
    use super::*;
    use crate::embedding::layout::{PAGE_FAULT, PHYSICAL_MEMORY};
    use crate::x86::paging::walk::{Failure, PageFault, PhysicalFault, PhysicalPhase};

    fn initialize() {
        BRIDGE.with_borrow_mut(|bridge| {
            *bridge = Bridge::default();
            bridge.input = vec![0x90];
            bridge.input.extend_from_slice(&[0xa5; 16]);
        });
        assert_eq!(core_init(0x1000, 1, 0x4000, 16), 0);
        BRIDGE.with_borrow_mut(|bridge| {
            let core = bridge.core.as_mut().unwrap();
            core.paging = Some(crate::x86::paging::State::default());
            let state = unsafe { &mut *core.state.get() };
            state.flags = 0x202;
            state.interruptibility = 2;
            state.debug.continuation = crate::embedding::layout::debug::Continuation {
                slots: 1,
                reserved: 0,
                origin: 0xff0,
            };
            core.debug_candidate = 2;
        });
    }

    #[test]
    fn page_fault_staging_uses_frozen_detection_not_repaired_cr2_or_privilege() {
        for enabled in [0, 1] {
            initialize();
            assert_eq!(core_configure_delivery(enabled), 0);
            BRIDGE.with_borrow_mut(|bridge| {
                let core = bridge.core.as_mut().unwrap();
                assert_eq!(
                    core.paging_failure(Failure::Page(PageFault {
                        address: 0x501000,
                        access: Access::Write,
                        error_code: 6
                    })),
                    PAGE_FAULT
                );
                assert_eq!(core.paging.unwrap().cr2, 0x501000);
                core.paging.as_mut().unwrap().cr2 = 0xdead_beef;
                core.paging.as_mut().unwrap().efer = 0xd00;
            });
            assert_eq!(core_stage_exception(PAGE_FAULT), enabled);
            BRIDGE.with_borrow(|bridge| {
                let core = bridge.core.as_ref().unwrap();
                let state = unsafe { &*core.state.get() };
                assert_eq!(core.paging.unwrap().cr2, 0xdead_beef);
                assert_eq!(
                    state.debug.continuation,
                    crate::embedding::layout::debug::Continuation::default()
                );
                assert_eq!(core.debug_candidate, 0);
                if enabled == 0 {
                    assert_eq!(state.event_state(), Ok(EventState::Ready));
                } else {
                    let EventState::Pending(event) = state.event_state().unwrap() else {
                        panic!()
                    };
                    assert_eq!(
                        (
                            event.vector,
                            event.error_code,
                            event.page_fault_address,
                            event.saved_flags
                        ),
                        (14, Some(6), Some(0x501000), 0x10202)
                    );
                    assert!(event.validate(0x1000, 0x202, &core.context).is_ok());
                }
            });
        }
    }

    #[test]
    fn physical_refusal_cannot_stage_pf_or_cancel_deferred_debug() {
        initialize();
        assert_eq!(core_configure_delivery(1), 0);
        BRIDGE.with_borrow_mut(|bridge| {
            let core = bridge.core.as_mut().unwrap();
            assert_eq!(
                core.paging_failure(Failure::Physical(PhysicalFault {
                    linear: 0x500000,
                    access: Access::Read,
                    physical: Fault {
                        address: 0x9000,
                        width: 8,
                        access: Access::Write,
                        cause: Cause::Permission,
                        failing: 0x9000
                    },
                    phase: PhysicalPhase::AccessedWrite
                })),
                PHYSICAL_MEMORY
            );
        });
        assert_eq!(core_stage_exception(PAGE_FAULT), -1);
        assert_eq!(core_stage_exception(PHYSICAL_MEMORY), 0);
        BRIDGE.with_borrow(|bridge| {
            let core = bridge.core.as_ref().unwrap();
            let state = unsafe { &*core.state.get() };
            assert_eq!(core.paging.unwrap().cr2, 0);
            assert_eq!(state.event_state(), Ok(EventState::Ready));
            assert_eq!(state.debug.continuation.slots, 1);
            assert_eq!(core.debug_candidate, 2);
        });
    }

    fn entry_fixture(vector: u8, frame_present: bool, frame_backed: bool) -> EventState {
        initialize();
        let mut bytes = vec![0xa5; 0xa000];
        for page in [0x1000, 0x2000, 0x3000, 0x4000] {
            bytes[page..page + 0x1000].fill(0);
        }
        for (address, word) in [
            (0x1000, 0x2027u64),
            (0x2000, 0x3027),
            (0x3000, 0x4027),
            (0x4028, 0x5027),
            (0x4030, 0x6027),
        ] {
            bytes[address..address + 8].copy_from_slice(&word.to_le_bytes());
        }
        if frame_present {
            bytes[0x4040..0x4048].copy_from_slice(&0x8027u64.to_le_bytes());
        }
        bytes[0x5008..0x5010].copy_from_slice(&0x00af_9b00_0000_ffffu64.to_le_bytes());
        for v in [1usize, 8, 13, 14] {
            let offset = 0x6000 + v * 16;
            bytes[offset..offset + 8].copy_from_slice(&0x0000_8e00_0008_7000u64.to_le_bytes());
            bytes[offset + 8..offset + 16].fill(0);
        }
        BRIDGE.with_borrow_mut(|bridge| {
            let core = bridge.core.as_mut().unwrap();
            core.image = Image::physical_mapped(
                vec![("bytes".into(), bytes)],
                vec![crate::memory::MappingInput {
                    base: 0,
                    backing: "bytes".into(),
                    offset: 0,
                    length: if frame_backed { 0xa000 } else { 0x8000 },
                    permissions: crate::memory::Permissions {
                        read: true,
                        write: true,
                        execute: true,
                    },
                }],
                crate::memory::MemoryLimits {
                    max_backing_bytes: 0xa000,
                    max_backings: 1,
                    max_mappings: 1,
                },
            )
            .unwrap();
            core.paging = Some(crate::x86::paging::State {
                cr3: 0x1000,
                cr2: 0x501000,
                ..crate::x86::paging::State::default()
            });
            core.context.set_gdtr(crate::x86::context::TableRegister {
                base: 0x5000,
                limit: 15,
            });
            core.context.set_idtr(crate::x86::context::TableRegister {
                base: 0x6000,
                limit: 4095,
            });
            let event = if vector == 14 {
                ExceptionEvent::page_fault(0x400000, 0x202, &core.context, 6, 0x501000)
            } else {
                ExceptionEvent::fault(
                    vector,
                    0x400000,
                    0x202,
                    &core.context,
                    matches!(vector, 8 | 10..=13).then_some(0),
                )
            };
            let state = unsafe { &mut *core.state.get() };
            state.rip = 0x400000;
            state.registers[4] = 0x9000;
            state.interruptibility = 0;
            state.debug.continuation = crate::embedding::layout::debug::Continuation::default();
            state.set_event(EventState::Pending(event));
            EventState::Pending(event)
        })
    }

    #[test]
    fn automatic_frame_page_faults_apply_asymmetric_classes_without_publishing_slots() {
        for vector in [1, 13, 14, 8] {
            entry_fixture(vector, false, true);
            assert_eq!(
                core_deliver_exception(),
                if vector == 8 { SHUTDOWN } else { DISPATCH }
            );
            BRIDGE.with_borrow(|bridge| {
                let core = bridge.core.as_ref().unwrap();
                let state = unsafe { &*core.state.get() };
                assert_eq!(core.paging.unwrap().cr2, 0x8ff8);
                assert_eq!(
                    core.image.physical_read_bytes(0x8fd0, 48).unwrap(),
                    vec![0xa5; 48]
                );
                assert_eq!((state.rip, state.registers[4]), (0x400000, 0x9000));
                if vector == 8 {
                    assert_eq!(state.event_state(), Ok(EventState::Shutdown));
                } else {
                    let EventState::Pending(next) = state.event_state().unwrap() else {
                        panic!()
                    };
                    assert_eq!(
                        (next.vector, next.error_code, next.page_fault_address),
                        if vector == 14 {
                            (8, Some(0), None)
                        } else {
                            (14, Some(2), Some(0x8ff8))
                        }
                    );
                }
            });
        }
    }

    #[test]
    fn physical_entry_refusal_keeps_frozen_pf_and_repair_uses_live_cr2_without_replay() {
        let pending = entry_fixture(14, true, false);
        assert_eq!(core_deliver_exception(), PHYSICAL_MEMORY);
        BRIDGE.with_borrow_mut(|bridge| {
            let core = bridge.core.as_mut().unwrap();
            let state = unsafe { &*core.state.get() };
            assert_eq!(state.event_state(), Ok(pending));
            assert_eq!(core.paging.unwrap().cr2, 0x501000);
            core.paging.as_mut().unwrap().cr2 = 0x1234;
            core.image
                .set_mappings(vec![crate::memory::MappingInput {
                    base: 0,
                    backing: "bytes".into(),
                    offset: 0,
                    length: 0xa000,
                    permissions: crate::memory::Permissions {
                        read: true,
                        write: true,
                        execute: true,
                    },
                }])
                .unwrap();
        });
        assert_eq!(core_deliver_exception(), DISPATCH);
        BRIDGE.with_borrow(|bridge| {
            let core = bridge.core.as_ref().unwrap();
            let state = unsafe { &*core.state.get() };
            assert_eq!(state.event_state(), Ok(EventState::Ready));
            assert_eq!(core.paging.unwrap().cr2, 0x1234);
            assert_eq!((state.rip, state.registers[4]), (0x7000, 0x8fd0));
            assert_eq!(core.image.physical_read(0x8fd0, 8), Ok(6));
            assert_eq!(core.image.physical_read(0x8fd8, 8), Ok(0x400000));
            assert_eq!(core.image.physical_read(0x8fe8, 8), Ok(0x10202));
        });
    }

    #[test]
    fn system_entry_page_fault_keeps_supervisor_zero_code_and_gate_provenance() {
        entry_fixture(13, true, true);
        BRIDGE.with_borrow_mut(|bridge| {
            bridge
                .core
                .as_mut()
                .unwrap()
                .image
                .physical_write(0x4030, 8, 0)
                .unwrap();
        });
        assert_eq!(core_deliver_exception(), DISPATCH);
        BRIDGE.with_borrow(|bridge| {
            let core = bridge.core.as_ref().unwrap();
            let state = unsafe { &*core.state.get() };
            let EventState::Pending(next) = state.event_state().unwrap() else {
                panic!()
            };
            assert_eq!(
                (next.vector, next.error_code, next.page_fault_address),
                (14, Some(0), Some(0x60d0))
            );
            assert_eq!(core.paging.unwrap().cr2, 0x60d0);
            let provenance = core.paging_system.unwrap();
            assert_eq!(
                (provenance.table, provenance.reference, provenance.phase),
                (
                    crate::x86::protection::Table::Idt,
                    crate::x86::protection::SystemReference::Vector(13),
                    crate::x86::protection::SystemPhase::GateRead
                )
            );
            assert_eq!(
                core.image.physical_read_bytes(0x8fd0, 48).unwrap(),
                vec![0xa5; 48]
            );
        });
    }

    #[test]
    fn system_physical_refusal_keeps_original_source_and_reports_physical_gate_provenance() {
        let pending = entry_fixture(14, true, true);
        BRIDGE.with_borrow_mut(|bridge| {
            bridge
                .core
                .as_mut()
                .unwrap()
                .image
                .physical_write(0x4030, 8, 0xb027)
                .unwrap();
        });
        assert_eq!(core_deliver_exception(), PHYSICAL_MEMORY);
        BRIDGE.with_borrow(|bridge| {
            let core = bridge.core.as_ref().unwrap();
            assert_eq!(unsafe { &*core.state.get() }.event_state(), Ok(pending));
            assert_eq!(core.paging.unwrap().cr2, 0x501000);
            let provenance = core.paging_system.unwrap();
            assert_eq!(
                (provenance.table, provenance.reference, provenance.phase),
                (
                    crate::x86::protection::Table::Idt,
                    crate::x86::protection::SystemReference::Vector(14),
                    crate::x86::protection::SystemPhase::GateRead
                )
            );
            let Failure::Physical(fault) = provenance.failure else {
                panic!()
            };
            assert_eq!(
                (
                    fault.linear,
                    fault.access,
                    fault.physical.address,
                    fault.phase
                ),
                (0x60e0, Access::Read, 0xb0e0, PhysicalPhase::FinalAccess)
            );
        });
    }
}
