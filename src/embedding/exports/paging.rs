use super::*;
use crate::x86::paging::{self, walk::Failure};

impl Core {
    pub(super) fn paged_decode(
        &mut self,
        pc: u64,
    ) -> Result<crate::x86::instruction::Instruction, DecodeError> {
        let paging = self.paging.expect("paged decode profile");
        let context = &self.context;
        let mut consumed = Vec::new();
        decode::decode_with_profile(pc, context, true, |offset| {
            let linear = context
                .translate(offset, 1, Segment::Cs, Access::Execute, false)
                .map_err(|failure| match failure {
                    AccessFailure::Linear(f) => DecodeError::Fetch(f),
                    AccessFailure::Segment(f) => DecodeError::Segment(f),
                    AccessFailure::Paging(f) => DecodeError::Paging(f),
                })?;
            let request = paging::walk::Request {
                linear,
                access: Access::Execute,
                user: context.cpl() == 3,
            };
            let translation =
                paging::walk::fetch_walk(&mut self.image, &paging, request, |image| {
                    encoding_current(image, &paging, &consumed, request.user)
                })
                .map_err(DecodeError::Paging)?
                .ok_or(DecodeError::PagingRestart)?;
            if !encoding_current(&self.image, &paging, &consumed, request.user)
                || !paging::walk::peek(&self.image, &paging, request)
                    .is_ok_and(|fresh| fresh.physical == translation.physical)
            {
                return Err(DecodeError::PagingRestart);
            }
            let byte = self
                .image
                .physical_fetch(translation.physical)
                .map_err(|fault| {
                    DecodeError::Paging(
                        request.physical_failure(fault, paging::walk::PhysicalPhase::FinalAccess),
                    )
                })?;
            consumed.push((linear, translation.physical, byte));
            Ok(byte)
        })
    }
    pub(super) fn paging_failure_json(&self) -> Option<serde_json::Value> {
        if let Some((control, slot, fault)) = self.pdpte_load_fault {
            return Some(serde_json::json!({
                "phase":"pdpte-load","control":format!("cr{control}"),"slot":slot,
                "physicalAddress":format!("0x{:x}",fault.address),"width":fault.width,
                "failingPhysicalAddress":format!("0x{:x}",fault.failing),"physicalAccess":"read",
                "cause":match fault.cause {Cause::Unmapped=>"unmapped",Cause::Permission=>"permission",Cause::AddressRange=>"address-range",Cause::Noncanonical=>unreachable!("physical address")}
            }));
        }
        let mut json = match self.paging_failure? {
            Failure::Page(fault) => {
                serde_json::json!({"vector":14,"address":format!("0x{:x}",fault.address),"access":access_name(fault.access),"errorCode":fault.error_code})
            }
            Failure::Physical(fault) => serde_json::json!({
                "address":format!("0x{:x}",fault.linear),"access":access_name(fault.access),
                "physicalAddress":format!("0x{:x}",fault.physical.address),"width":fault.physical.width,
                "failingPhysicalAddress":format!("0x{:x}",fault.physical.failing),
                "physicalAccess":access_name(fault.physical.access),"cause":match fault.physical.cause {
                    Cause::Unmapped=>"unmapped",Cause::Permission=>"permission",Cause::AddressRange=>"address-range",Cause::Noncanonical=>unreachable!("physical domain has no canonicality")
                },"phase":fault.phase.as_str(),
            }),
        };
        if let Some(system) = self.paging_system {
            json["table"] = serde_json::json!(system.table.as_str());
            json["systemPhase"] = serde_json::json!(system.phase.as_str());
            match system.reference {
                crate::x86::protection::SystemReference::Selector(selector) => {
                    json["selector"] = serde_json::json!(selector)
                }
                crate::x86::protection::SystemReference::Vector(vector) => {
                    json["referenceVector"] = serde_json::json!(vector)
                }
            }
        } else if matches!(self.paging_failure, Some(Failure::Physical(_))) {
            json["segment"] = serde_json::json!(
                Segment::from_id(unsafe { (*self.state.get()).fault_segment }).name()
            );
        }
        Some(json)
    }
    pub(super) fn memory_failure_reason(&self) -> i32 {
        match self.paging_failure {
            Some(Failure::Page(_)) => 24,
            Some(Failure::Physical(_)) => 25,
            None if self.segment_fault.is_some() => SEGMENT,
            None => DATA,
        }
    }

    pub(super) fn system_paging_failure(
        &mut self,
        fault: crate::x86::protection::SystemPagingFault,
    ) -> i32 {
        self.paging_system = Some(fault);
        self.paging_failure(fault.failure)
    }
    pub(super) fn paging_failure(&mut self, failure: Failure) -> i32 {
        self.paging_failure = Some(failure);
        match failure {
            Failure::Page(fault) => {
                self.paging
                    .as_mut()
                    .expect("page fault belongs to paged execution")
                    .cr2 = fault.address;
                24
            }
            Failure::Physical(_) => 25,
        }
    }
}

fn encoding_current(
    image: &Image,
    paging: &paging::State,
    bytes: &[(u64, u64, u8)],
    user: bool,
) -> bool {
    bytes.iter().all(|&(linear, physical, byte)| {
        paging::walk::peek(
            image,
            paging,
            paging::walk::Request {
                linear,
                access: Access::Execute,
                user,
            },
        )
        .is_ok_and(|translation| translation.physical == physical)
            && image.physical_fetch(physical) == Ok(byte)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_paged_access_failed() -> i32 {
    BRIDGE.with_borrow(|bridge| {
        let core = bridge.core.as_ref().unwrap();
        i32::from(
            core.paging_failure.is_some() || core.fault.is_some() || core.segment_fault.is_some(),
        )
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_paged_segmented_access_failed() -> i32 {
    core_paged_access_failed()
}

#[unsafe(no_mangle)]
pub extern "C" fn core_paged_access_reason() -> i32 {
    BRIDGE.with_borrow(|bridge| {
        let core = bridge.core.as_ref().unwrap();
        if core.alignment_fault.is_some() {
            super::super::layout::ALIGNMENT
        } else {
            core.memory_failure_reason()
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_paged_debug_begin(pc: u64, flags: u64, shadow: u32) -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        core.paging_work.clear();
        core.numeric_fault = None;
        core.numeric_form = None;
        core.paging_failure = None;
        core.pdpte_load_fault = None;
        core.paging_system = None;
        core.debug_candidate = 0;
        unsafe {
            (*core.state.get()).fault_segment = Segment::Cs as u32;
        }
        let debug = core.debug_execute(pc, flags, shadow);
        if debug != 0 {
            return debug;
        }
        match core.paged_decode(pc) {
            Ok(instruction) if !core.image.active_changed() => {
                core.instruction_admission(instruction.operation, pc, true)
            }
            Ok(_) | Err(DecodeError::PagingRestart) => 26,
            Err(DecodeError::Paging(failure)) => core.paging_failure(failure),
            Err(DecodeError::Fetch(fault)) => {
                core.fault = Some(fault);
                FETCH
            }
            Err(DecodeError::Segment(fault)) => {
                core.segment_fault = Some(fault);
                SEGMENT
            }
            Err(error) => {
                core.decode_fault = error.architectural_fault();
                if matches!(error, DecodeError::Unsupported | DecodeError::Undefined) {
                    UNSUPPORTED
                } else {
                    INVALID
                }
            }
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_paged_debug_finish(
    pc: u64,
    resume: u64,
    completed: u32,
    flags: u64,
    decision: u32,
) -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        let reason = core.finish_debug(pc, resume, completed != 0, flags, decision);
        if reason == 0 || reason == super::super::layout::debug::CONTINUE_ACTIVE {
            if core.image.active_changed() {
                0
            } else {
                super::super::layout::debug::CONTINUE_ACTIVE
            }
        } else {
            reason
        }
    })
}

fn access_name(access: Access) -> &'static str {
    match access {
        Access::Read => "read",
        Access::Write => "write",
        Access::Execute => "execute",
    }
}

pub(super) fn parse_bank(value: &serde_json::Value) -> Result<paging::State, &'static str> {
    let word = |name| {
        value[name]
            .as_str()
            .and_then(|v| v.strip_prefix("0x"))
            .and_then(|v| u64::from_str_radix(v, 16).ok())
            .ok_or("paging fields must be unsigned64 hexadecimal words")
    };
    let state = paging::State {
        cr0: word("cr0")?,
        cr2: word("cr2")?,
        cr3: word("cr3")?,
        cr4: word("cr4")?,
        efer: word("efer")?,
        pdpte: value
            .get("pdpte")
            .map(|entries| {
                let entries = entries
                    .as_array()
                    .filter(|entries| entries.len() == 4)
                    .ok_or("captured PDPTEs require four words")?;
                let mut result = [0; 4];
                for (index, entry) in entries.iter().enumerate() {
                    result[index] = entry
                        .as_str()
                        .and_then(|v| v.strip_prefix("0x"))
                        .and_then(|v| u64::from_str_radix(v, 16).ok())
                        .ok_or("invalid captured PDPTE word")?;
                }
                Ok(result)
            })
            .transpose()?,
    };
    Ok(state)
}

#[unsafe(no_mangle)]
pub extern "C" fn core_paging_state() -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        let Some(state) = bridge.core.as_ref().unwrap().paging else { return bridge.error("paging state requires a paged CPU"); };
        let mut json = serde_json::json!({
            "cr0":format!("0x{:x}",state.cr0),"cr2":format!("0x{:x}",state.cr2),
            "cr3":format!("0x{:x}",state.cr3),"cr4":format!("0x{:x}",state.cr4),"efer":format!("0x{:x}",state.efer),
        });
        if let Some(entries) = state.pdpte { json["pdpte"] = serde_json::json!(entries.map(|entry| format!("0x{entry:x}"))); }
        bridge.info = serde_json::to_vec(&json).unwrap();
        0
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_import_paging() -> i32 {
    BRIDGE.with_borrow_mut(|bridge| {
        let candidate = match serde_json::from_slice(&bridge.input)
            .map_err(|_| "invalid paging input")
            .and_then(|value| parse_bank(&value))
        {
            Ok(bank) => bank,
            Err(message) => return bridge.error(message),
        };
        let core = bridge.core.as_mut().unwrap();
        let Some(previous) = core.paging else {
            return bridge.error("paging state requires a paged CPU");
        };
        let validation = if core.physical_controls {
            candidate.validate_physical_context(&core.context)
        } else {
            candidate.validate()
        };
        if let Err(message) = validation {
            return bridge.error(message);
        }
        if previous.translation_changed(candidate) {
            core.retire_translations();
        }
        if previous.numeric_controls() != candidate.numeric_controls() {
            core.context_changed();
        }
        core.paging = Some(candidate);
        core.paging_work.clear();
        0
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn core_paging_control(
    kind: u32,
    register: u32,
    value: u64,
    _pc: u64,
    _flags: u64,
) -> i32 {
    use crate::x86::protection::{ProtectionFault, ProtectionPhase};
    use paging::ControlFailure;
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        let Some(state) = core.paging else {
            return UNSUPPORTED;
        };
        if core.context.cpl() != 0 {
            core.protection_fault = Some(ProtectionFault {
                vector: 13,
                error_code: 0,
                phase: ProtectionPhase::Privilege,
                selector: None,
            });
            return super::super::layout::PROTECTION;
        }
        let operation = match kind {
            0 => state.read_cr(register as u8).map(|v| (state, Some(v))),
            1 => {
                let value = if core.context.is_long64() {
                    value
                } else {
                    u64::from(value as u32)
                };
                if core.physical_controls {
                    state.prepare_physical_cr_write_in_context(register as u8, value, &core.context)
                } else {
                    state.prepare_cr_write(register as u8, value, core.context.mode())
                }
                .map(|s| (s, None))
            }
            2 => if register == paging::EFER_MSR {
                state.read_msr(register)
            } else {
                core.fast_system
                    .read_msr_profile(register, &core.context, core.physical_controls)
            }
            .map(|v| (state, Some(v))),
            3 if register == paging::EFER_MSR => if core.physical_controls {
                state.prepare_physical_efer_write(value)
            } else {
                state.prepare_msr_write(register, value)
            }
            .map(|s| (s, None)),
            3 => core
                .fast_system
                .prepare_msr_write_profile(register, value, &core.context, core.physical_controls)
                .map(|(bank, context)| {
                    if core.context != context {
                        core.context = context;
                        core.context_changed();
                    }
                    core.fast_system = bank;
                    (state, None)
                }),
            4 => {
                let Some(segment) = Segment::ALL.get(register as usize).copied() else {
                    return -1;
                };
                // INVLPG forms an address; it does not require canonicality or memory access.
                if !core.context.is_long64() {
                    if let Err(failure) =
                        core.context
                            .translate(value, 0, segment, Access::Read, false)
                    {
                        core.access_failure(failure);
                        return SEGMENT;
                    }
                } else {
                    let base = if matches!(segment, Segment::Fs | Segment::Gs) {
                        core.context.segment(segment).base
                    } else {
                        0
                    };
                    if !crate::memory::canonical48(value.wrapping_add(base)) {
                        return 0;
                    }
                }
                Ok((state, None))
            }
            5 => Ok((
                paging::State {
                    cr0: state.cr0 & !8,
                    ..state
                },
                None,
            )),
            _ => return -1,
        };
        match operation {
            Ok((mut candidate, result)) => {
                let context = if core.physical_controls {
                    match state.transition_context(candidate, &core.context) {
                        Ok(context) => context,
                        Err(_) => {
                            core.protection_fault = Some(ProtectionFault {
                                vector: 13,
                                error_code: 0,
                                phase: ProtectionPhase::Target,
                                selector: None,
                            });
                            return super::super::layout::PROTECTION;
                        }
                    }
                } else {
                    core.context.clone()
                };
                if core.physical_controls
                    && kind == 1
                    && state.needs_pdpte_reload(candidate, register as u8)
                {
                    match candidate.load_pdpte(&core.image) {
                        Ok(entries) => candidate.pdpte = Some(entries),
                        Err(paging::PdpteFailure::Physical { slot, fault }) => {
                            core.pdpte_load_fault = Some((register as u8, slot, fault));
                            return 25;
                        }
                        Err(paging::PdpteFailure::Reserved) => {
                            core.protection_fault = Some(ProtectionFault {
                                vector: 13,
                                error_code: 0,
                                phase: ProtectionPhase::Target,
                                selector: None,
                            });
                            return super::super::layout::PROTECTION;
                        }
                    }
                }
                let context_changed = core.context != context;
                core.context = context;
                if kind == 4 || kind == 1 && register == 3 || state.translation_changed(candidate) {
                    core.retire_translations();
                } else if context_changed
                    || state.numeric_controls() != candidate.numeric_controls()
                {
                    core.context_changed();
                }
                core.paging = Some(candidate);
                if let Some(value) = result {
                    unsafe {
                        (&mut (*core.state.get()).vector_scratch)[..8]
                            .copy_from_slice(&value.to_le_bytes());
                    }
                }
                0
            }
            Err(ControlFailure::GeneralProtection) => {
                core.protection_fault = Some(ProtectionFault {
                    vector: 13,
                    error_code: 0,
                    phase: ProtectionPhase::Target,
                    selector: None,
                });
                super::super::layout::PROTECTION
            }
            Err(ControlFailure::Unsupported) => UNSUPPORTED,
            Err(ControlFailure::Undefined) => {
                core.decode_fault = Some(decode::DecodeFault::UndefinedOpcode);
                INVALID
            }
        }
    })
}
