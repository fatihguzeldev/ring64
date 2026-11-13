use super::*;
use crate::embedding::layout::PAGE_FAULT;
use crate::x86::context::Mode;
use crate::x86::instruction::{ProtectionDescriptor, ProtectionKind, Width};

const AC: u64 = 1 << 18;
const SMEP: u64 = 1 << 20;
const SMAP: u64 = 1 << 21;

fn fixture(cpl: u8, bits: u64, code_user: bool, epoch: u64) {
    let mut bytes = vec![0; 0xc000];
    for (at, word) in [
        (0x1000, 0x2007u32),
        (0x2004, 0x3003 | if code_user { 4 } else { 0 }),
        (0x2010, 0x5007),
        (0x2018, 0x7003),
        (0x2020, 0x9003),
    ] {
        bytes[at..at + 4].copy_from_slice(&word.to_le_bytes());
    }
    bytes[0x3000..0x3003].copy_from_slice(&[0x90; 3]);
    bytes[0x5000..0x5004].copy_from_slice(&0x44332211u32.to_le_bytes());
    bytes[0x5008..0x5010].copy_from_slice(&0x00cff3000000ffffu64.to_le_bytes());
    let mut context = ExecutionContext::default().to_json();
    context["mode"] = serde_json::json!("protected");
    context["cpl"] = serde_json::json!(cpl);
    for segment in ["cs", "ss", "ds", "es", "fs", "gs"] {
        context["segments"][segment]["dpl"] = serde_json::json!(cpl);
        let selector = context["segments"][segment]["selector"].as_u64().unwrap();
        context["segments"][segment]["selector"] = serde_json::json!(selector | u64::from(cpl));
    }
    context["segments"]["cs"]["default32"] = serde_json::json!(true);
    context["segments"]["cs"]["long"] = serde_json::json!(false);
    context["segments"]["ss"]["default32"] = serde_json::json!(true);
    context["gdtr"] = serde_json::json!({"base":"0x4000","limit":15});
    let config = serde_json::json!({
        "memoryModel":"physical","context":context,
        "paging":{"cr0":"0x80000033","cr2":"0xabc","cr3":"0x1000","cr4":format!("0x{:x}",0x608|bits),"efer":"0x0"},
        "memoryLimits":{"maxBackingBytes":49152,"maxBackings":1,"maxMappings":1},
        "backings":[{"id":"ram","length":49152}],
        "mappings":[{"base":"0x0","backing":"ram","offset":0,"length":49152,"permissions":{"read":true,"write":true,"execute":true}}]
    });
    let length = mapped_input(config, &bytes);
    assert_eq!(mapped::core_init_mapped(0x1000, length), 0);
    BRIDGE.with_borrow_mut(|bridge| {
        let core = bridge.core.as_mut().unwrap();
        assert_eq!(core.context.mode(), Mode::Protected);
        core.context_version = epoch;
    });
}

fn set_flags(flags: u64) {
    BRIDGE.with_borrow_mut(|bridge| unsafe {
        (*bridge.core.as_mut().unwrap().state.get()).flags = flags;
    });
}

fn compile() -> u64 {
    assert_eq!(core_compile(0x1000, 1, 16, 65536), 0);
    BRIDGE.with_borrow(|bridge| {
        let value: serde_json::Value = serde_json::from_slice(&bridge.info).unwrap();
        u64::from_str_radix(
            value["owner"].as_str().unwrap().trim_start_matches("0x"),
            16,
        )
        .unwrap()
    })
}

fn import_bits(bits: u64) {
    mapped_input(
        serde_json::json!({"cr0":"0x80000033","cr2":"0xabc","cr3":"0x1000","cr4":format!("0x{:x}",0x608|bits),"efer":"0x0"}),
        &[],
    );
    assert_eq!(paging::core_import_paging(), 0);
}

#[test]
fn supervisor_bridge_reads_current_canonical_ac_and_preserves_denied_store_payload() {
    fixture(0, SMAP, false, 0);
    for flags in [2, 2 | AC, 2] {
        core_clear_fault();
        set_flags(flags);
        let value = core_paged_load(0x4000, 4);
        if flags & AC == 0 {
            assert_eq!(value, 0);
            assert_eq!(paging::core_paged_access_reason(), PAGE_FAULT);
            assert_eq!(metadata(PAGE_FAULT)["errorCode"], 1);
        } else {
            assert_eq!(value, 0x44332211);
            assert_eq!(paging::core_paged_access_failed(), 0);
        }
    }
    core_clear_fault();
    assert_eq!(core_paged_store(0x4000, 4, 0xdeadbeef), 0);
    assert_eq!(paging::core_paged_access_reason(), PAGE_FAULT);
    assert_eq!(metadata(PAGE_FAULT)["errorCode"], 3);
    BRIDGE.with_borrow(|bridge| {
        let core = bridge.core.as_ref().unwrap();
        assert_eq!(core.image.physical_read(0x5000, 4).unwrap(), 0x44332211);
        assert_eq!(core.image.physical_read(0x2010, 4).unwrap(), 0x5027);
        assert_eq!(unsafe { (*core.state.get()).time.tsc }, 0);
    });
}

#[test]
fn supervisor_bridge_metadata_is_implicit_even_for_ac_and_user_origin() {
    let load_ds = ProtectionDescriptor {
        kind: ProtectionKind::LoadSegment(Segment::Ds),
        width: Width::W16,
        memory: false,
    }
    .encode();
    for cpl in [0, 3] {
        fixture(cpl, SMAP, cpl == 3, 0);
        set_flags(2 | AC);
        assert_eq!(
            protection::core_paged_protection(load_ds, 0, 0xb, Segment::Ds as u32),
            PAGE_FAULT
        );
        let fault = metadata(PAGE_FAULT);
        assert_eq!(fault["address"], "0x4008");
        assert_eq!(fault["access"], "read");
        assert_eq!(fault["errorCode"], 1);
        assert_eq!(fault["table"], "gdt");
        assert_eq!(core_paged_load(0x4000, 4), 0x44332211);
    }
    fixture(0, 0, false, 0);
    set_flags(2);
    assert_eq!(
        protection::core_paged_protection(load_ds, 0, 0xb, Segment::Ds as u32),
        2
    );
}

#[test]
fn supervisor_control_fences_cancel_pending_and_aba_owners_at_epoch_saturation() {
    for epoch in [0, u64::MAX - 1, u64::MAX] {
        for bits in [SMEP, SMAP] {
            fixture(0, 0, false, epoch);
            let installed = compile();
            assert_eq!(mapped::core_publish(installed), 1);
            assert_eq!(mapped::core_activate(installed), 1);
            let pending = compile();
            set_flags(2 | AC);
            assert_eq!(mapped::core_validity(installed), 1);
            assert_eq!(mapped::core_validity(pending), 1);
            assert_eq!(
                paging::core_paging_control(1, 4, 0x608, 0x1000, 2 | AC, 0),
                0
            );
            assert_eq!(mapped::core_validity(installed), 1);
            import_bits(bits);
            assert_eq!(mapped::core_validity(installed), 0);
            assert_eq!(mapped::core_validity(pending), 0);
            import_bits(0);
            assert_eq!(mapped::core_publish(pending), 0);
            assert_eq!(mapped::core_activate(installed), 0);
            let fresh = compile();
            assert!(fresh > pending);
            assert_eq!(mapped::core_publish(fresh), 1);
            assert_eq!(
                paging::core_paging_control(1, 4, 0x608 | bits, 0x1000, 2 | AC, 0),
                0
            );
            assert_eq!(mapped::core_validity(fresh), 0);
            BRIDGE.with_borrow(|bridge| {
                let core = bridge.core.as_ref().unwrap();
                assert_eq!(core.context_version, epoch.saturating_add(3));
                assert_eq!(unsafe { (*core.state.get()).flags & AC }, AC);
                assert_eq!(unsafe { (*core.state.get()).time.tsc }, 0);
            });
        }
    }
}

#[test]
fn supervisor_source_probe_checks_smep_after_warm_owner_retirement() {
    fixture(0, 0, true, 0);
    let installed = compile();
    assert_eq!(mapped::core_publish(installed), 1);
    assert_eq!(mapped::core_activate(installed), 1);
    import_bits(SMEP);
    set_flags(2 | AC);
    assert_eq!(mapped::core_validity(installed), 0);
    assert_eq!(core_probe(0x1000), PAGE_FAULT);
    let fault = metadata(PAGE_FAULT);
    assert_eq!(fault["address"], "0x1000");
    assert_eq!(fault["access"], "execute");
    assert_eq!(fault["errorCode"], 0x11);
    BRIDGE.with_borrow(|bridge| {
        let core = bridge.core.as_ref().unwrap();
        assert_eq!(core.paging.unwrap().cr2, 0x1000);
        assert_eq!(core.image.physical_read(0x2004, 4).unwrap(), 0x3027);
        assert_eq!(unsafe { (*core.state.get()).time.tsc }, 0);
    });
}
