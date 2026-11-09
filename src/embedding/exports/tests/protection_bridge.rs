use super::*;
use crate::x86::instruction::{ProtectionDescriptor, ProtectionKind, Width};

#[test]
fn malformed_protection_helpers_leave_memory_context_and_diagnostics_unchanged() {
    initialize(0x1000, &[0x90]);
    core_load(0x7000, 8);
    let prior = metadata(DATA);
    let before = BRIDGE.with_borrow(|bridge| {
        let core = bridge.core.as_ref().unwrap();
        (
            core.context.to_json(),
            core.context_version,
            core.image.read_bytes(0x4000, 16).unwrap(),
        )
    });
    let valid = ProtectionDescriptor {
        kind: ProtectionKind::ReadSegment(Segment::Ds),
        width: Width::W16,
        memory: false,
    }
    .encode();
    for (descriptor, segment) in [
        (u32::MAX, 0),
        (valid | 0x100, 0),
        (valid, 6),
        (valid, u32::MAX),
    ] {
        assert_eq!(
            protection::core_protection(descriptor, u64::MAX, u64::MAX, segment),
            -1
        );
        assert_eq!(metadata(DATA), prior);
        BRIDGE.with_borrow(|bridge| {
            let core = bridge.core.as_ref().unwrap();
            assert_eq!(
                (
                    core.context.to_json(),
                    core.context_version,
                    core.image.read_bytes(0x4000, 16).unwrap()
                ),
                before
            );
        });
    }
}

#[test]
fn mode_invalid_private_helpers_do_not_clear_prior_faults() {
    initialize(0x1000, &[0x90]);
    BRIDGE.with_borrow_mut(|bridge| {
        bridge.core.as_mut().unwrap().context = ExecutionContext::from_json(&serde_json::json!({
            "mode":"real", "segments": {
                "cs":{"base":"0x0","limit":65535,"default32":false,"usable":true,"type":"readable-code"},
                "ss":{"base":"0x0","limit":65535,"default32":false,"usable":true,"type":"read-write"},
                "ds":{"base":"0x0","limit":65535,"default32":false,"usable":true,"type":"read-write"},
                "es":{"base":"0x0","limit":65535,"default32":false,"usable":true,"type":"read-write"},
                "fs":{"base":"0x0","limit":65535,"default32":false,"usable":true,"type":"read-write"},
                "gs":{"base":"0x0","limit":65535,"default32":false,"usable":true,"type":"read-write"}
            }
        })).unwrap();
    });
    core_load(0x7000, 8);
    let before = metadata(DATA);
    for kind in [
        ProtectionKind::ReadLdt,
        ProtectionKind::LoadLdt,
        ProtectionKind::Lar,
        ProtectionKind::Lsl,
        ProtectionKind::Verr,
        ProtectionKind::Verw,
    ] {
        let descriptor = ProtectionDescriptor {
            kind,
            width: Width::W16,
            memory: false,
        }
        .encode();
        assert_eq!(
            protection::core_protection(descriptor, 0, 8, Segment::Ds as u32),
            -1
        );
        assert_eq!(metadata(DATA), before);
    }
}

#[test]
fn valid_repairs_clear_all_descriptor_diagnostics_even_for_equal_context() {
    use crate::embedding::layout::{PROTECTION, SYSTEM_MEMORY};
    let query = ProtectionDescriptor {
        kind: ProtectionKind::Lar,
        width: Width::W32,
        memory: false,
    }
    .encode();
    for repair in ["clear", "state", "context", "x87", "xmm", "mxcsr", "probe"] {
        initialize(0x1000, &[0x90]);
        BRIDGE.with_borrow_mut(|bridge| {
            bridge
                .core
                .as_mut()
                .unwrap()
                .context
                .set_gdtr(crate::x86::context::TableRegister {
                    base: 0x7000,
                    limit: 15,
                });
        });
        assert_eq!(
            protection::core_protection(query, 0, 8, Segment::Ds as u32),
            SYSTEM_MEMORY
        );
        assert_ne!(metadata(SYSTEM_MEMORY), serde_json::Value::Null);
        BRIDGE.with_borrow_mut(|bridge| {
            let core = bridge.core.as_mut().unwrap();
            core.protection_fault = Some(crate::x86::protection::ProtectionFault {
                vector: 13,
                error_code: 8,
                phase: crate::x86::protection::ProtectionPhase::Selector,
                selector: Some(8),
            });
        });
        match repair {
            "clear" => core_clear_fault(),
            "state" => {
                BRIDGE.with_borrow_mut(|bridge| {
                    bridge.input = vec![0; SCALAR_STATE_SIZE];
                    bridge.input[128..136].copy_from_slice(&2u64.to_le_bytes());
                });
                assert_eq!(core_import_state(), 0);
            }
            "context" => {
                BRIDGE.with_borrow_mut(|bridge| {
                    bridge.input =
                        serde_json::to_vec(&bridge.core.as_ref().unwrap().context.to_json())
                            .unwrap()
                });
                assert_eq!(context::core_set_context(), 0);
            }
            "x87" => {
                BRIDGE.with_borrow_mut(|bridge| bridge.input = vec![0; 104]);
                assert_eq!(crate::embedding::exports::x87_state::core_import_x87(), 0);
            }
            "xmm" => {
                BRIDGE.with_borrow_mut(|bridge| bridge.input = vec![0; 256]);
                assert_eq!(vector::core_import_xmm(), 0);
            }
            "mxcsr" => {
                BRIDGE.with_borrow_mut(|bridge| bridge.input = 0x1f80u32.to_le_bytes().to_vec());
                assert_eq!(numeric::core_import_mxcsr(), 0);
            }
            _ => assert_eq!(core_probe(0x1000), 0),
        }
        assert_eq!(metadata(PROTECTION), serde_json::Value::Null, "{repair}");
        assert_eq!(metadata(SYSTEM_MEMORY), serde_json::Value::Null, "{repair}");
    }
}
