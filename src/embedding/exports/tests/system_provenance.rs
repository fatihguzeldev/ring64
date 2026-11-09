use super::super::protection::system_fault_json;
use crate::memory::{Access, Cause};
use crate::x86::protection::{SystemMemoryFault, SystemPhase, SystemReference, Table};
use serde_json::json;

#[test]
fn system_memory_records_preserve_selector_and_vector_provenance_without_aliasing() {
    for (table, phase, reference, expected) in [
        (
            Table::Gdt,
            SystemPhase::DescriptorRead,
            SystemReference::Selector(24),
            json!({"table":"gdt","phase":"descriptor-read","selector":24}),
        ),
        (
            Table::Ldt,
            SystemPhase::AccessedWrite,
            SystemReference::Selector(12),
            json!({"table":"ldt","phase":"descriptor-accessed-write","selector":12}),
        ),
        (
            Table::Gdt,
            SystemPhase::BusyWrite,
            SystemReference::Selector(40),
            json!({"table":"gdt","phase":"descriptor-busy-write","selector":40}),
        ),
        (
            Table::Ivt,
            SystemPhase::GateRead,
            SystemReference::Vector(128),
            json!({"table":"ivt","phase":"gate-read","vector":128}),
        ),
        (
            Table::Idt,
            SystemPhase::GateRead,
            SystemReference::Vector(255),
            json!({"table":"idt","phase":"gate-read","vector":255}),
        ),
        (
            Table::Tss,
            SystemPhase::TssRead,
            SystemReference::Selector(24),
            json!({"table":"tss","phase":"tss-read","selector":24}),
        ),
    ] {
        let fault = SystemMemoryFault {
            address: 0x1_0000_0000_0000_0000,
            width: 8,
            access: Access::Read,
            cause: Cause::AddressRange,
            failing_address: 0x1_0000_0000_0000_0004,
            table,
            phase,
            reference,
        };
        let mut expected = expected.as_object().unwrap().clone();
        for (key, value) in json!({"address":"0x10000000000000000","width":8,
            "access":"read","cause":"address-range","failingAddress":"0x10000000000000004"})
        .as_object()
        .unwrap()
        {
            expected.insert(key.clone(), value.clone());
        }
        assert_eq!(
            system_fault_json(&fault),
            serde_json::Value::Object(expected)
        );
    }
}
