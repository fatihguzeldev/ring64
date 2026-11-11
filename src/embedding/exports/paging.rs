use super::*;
use crate::x86::paging::walk::Failure;

impl Core {
    pub(super) fn paging_failure_json(&self) -> Option<serde_json::Value> {
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

fn access_name(access: Access) -> &'static str {
    match access {
        Access::Read => "read",
        Access::Write => "write",
        Access::Execute => "execute",
    }
}
