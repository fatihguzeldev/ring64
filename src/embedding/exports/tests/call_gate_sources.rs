use super::super::exception_delivery::{core_configure_delivery, core_stage_exception};
use super::*;
use crate::embedding::layout::SYSTEM_MEMORY;
use crate::x86::context::TableRegister;
use crate::x86::exception::EventState;
use crate::x86::instruction::{FarDescriptor, FarKind, Width};

fn setup(kind: FarKind, width: Width) -> u32 {
    initialize(0x1000, &[0x90]);
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        core.context.set_gdtr(TableRegister {
            base: 0x7fff_ffff_fff0,
            limit: 0xffff,
        });
        let size = width.bytes() as usize;
        let mut pointer = [0_u8; 16];
        pointer[size] = 0x10;
        core.image.write_bytes(0x4000, &pointer).unwrap();
    });
    FarDescriptor {
        kind,
        width,
        memory: kind != FarKind::Return,
    }
    .encode()
}

fn invoke(descriptor: u32, kind: FarKind) -> i32 {
    far_control::core_far_control(
        descriptor,
        if kind == FarKind::Return { 0 } else { 0x4000 },
        0,
        0x4000,
        0x1003,
        if kind == FarKind::Return {
            Segment::Ss
        } else {
            Segment::Ds
        } as u32,
    )
}

fn pending_error() -> u16 {
    assert_eq!(core_configure_delivery(1), 0);
    assert_eq!(core_stage_exception(SYSTEM_MEMORY), 1);
    BRIDGE.with_borrow(|bridge| {
        let state = unsafe { &*bridge.core.as_ref().unwrap().state.get() };
        let EventState::Pending(event) = state.event.decode().unwrap() else {
            panic!("pending canonical source")
        };
        assert_eq!(event.vector, 13);
        event.error_code.unwrap()
    })
}

#[test]
fn forward_descriptor_canonical_sources_keep_selector_and_system_metadata() {
    for kind in [FarKind::Call, FarKind::Jump] {
        for width in [Width::W16, Width::W32, Width::W64] {
            let descriptor = setup(kind, width);
            assert_eq!(invoke(descriptor, kind), SYSTEM_MEMORY);
            let report = metadata(SYSTEM_MEMORY);
            assert_eq!(
                report,
                serde_json::json!({
                    "address":"0x800000000000", "width":8, "access":"read",
                    "cause":"noncanonical", "failingAddress":"0x800000000000",
                    "table":"gdt", "phase":"descriptor-read", "selector":16,
                })
            );
            assert_eq!(pending_error(), 0x10, "{kind:?} {width:?}");
        }
    }
}

#[test]
fn return_descriptor_canonical_source_keeps_existing_zero_code() {
    let descriptor = setup(FarKind::Return, Width::W64);
    assert_eq!(invoke(descriptor, FarKind::Return), SYSTEM_MEMORY);
    assert_eq!(pending_error(), 0);
}

#[test]
fn a_new_private_descriptor_refusal_cannot_reuse_a_canonical_source() {
    let descriptor = setup(FarKind::Call, Width::W64);
    assert_eq!(invoke(descriptor, FarKind::Call), SYSTEM_MEMORY);
    BRIDGE.with_borrow_mut(|bridge| {
        bridge
            .core
            .as_mut()
            .unwrap()
            .context
            .set_gdtr(TableRegister {
                base: 0x8000,
                limit: 0xffff,
            });
    });
    assert_eq!(invoke(descriptor, FarKind::Call), SYSTEM_MEMORY);
    assert_eq!(metadata(SYSTEM_MEMORY)["cause"], "unmapped");
    assert_eq!(core_configure_delivery(1), 0);
    assert_eq!(core_stage_exception(SYSTEM_MEMORY), 0);
}

#[test]
fn pending_canonical_source_outlives_transient_diagnostic_clear() {
    let descriptor = setup(FarKind::Jump, Width::W64);
    assert_eq!(invoke(descriptor, FarKind::Jump), SYSTEM_MEMORY);
    assert_eq!(pending_error(), 0x10);
    core_clear_fault();
    BRIDGE.with_borrow(|bridge| {
        let core = bridge.core.as_ref().unwrap();
        assert!(core.system_memory_fault.is_none());
        assert!(core.protection_fault.is_none());
        let state = unsafe { &*core.state.get() };
        let EventState::Pending(event) = state.event.decode().unwrap() else {
            panic!("captured source")
        };
        assert_eq!((event.vector, event.error_code), (13, Some(0x10)));
    });
}

#[test]
fn unrelated_task_load_clears_forward_canonical_provenance() {
    use crate::x86::instruction::{ProtectionDescriptor, ProtectionKind};
    let descriptor = setup(FarKind::Call, Width::W64);
    assert_eq!(invoke(descriptor, FarKind::Call), SYSTEM_MEMORY);
    let task = ProtectionDescriptor {
        kind: ProtectionKind::LoadTask,
        width: Width::W16,
        memory: false,
    }
    .encode();
    assert_eq!(
        protection::core_protection(task, 0, 0x10, Segment::Ds as u32),
        SYSTEM_MEMORY
    );
    assert_eq!(pending_error(), 0);
}
