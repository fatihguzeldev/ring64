use super::*;

fn fixture(epoch: u64) {
    let mut bytes = vec![0; 0xa000];
    for (at, word) in [
        (0x1000, 0x3001u64),
        (0x3000, 0x4027),
        (0x4008, 0x9067),
        (0x5000, 0x6027),
        (0x6008, 0x9067),
    ] {
        bytes[at..at + 8].copy_from_slice(&word.to_le_bytes());
    }
    bytes[0x9000] = 0x90;
    bytes[0x9001] = 0x82;
    let mut context = ExecutionContext::default().to_json();
    context["mode"] = serde_json::json!("protected");
    context["segments"]["cs"]["default32"] = serde_json::json!(true);
    context["segments"]["cs"]["long"] = serde_json::json!(false);
    let config = serde_json::json!({
        "memoryModel":"physical","context":context,
        "paging":{"cr0":"0x80000033","cr2":"0x0","cr3":"0x1000","cr4":"0x628","efer":"0x0","pdpte":["0x3001","0x0","0x0","0x0"]},
        "memoryLimits":{"maxBackingBytes":40960,"maxBackings":1,"maxMappings":1},"backings":[{"id":"ram","length":40960}],
        "mappings":[{"base":"0x0","backing":"ram","offset":0,"length":40960,"permissions":{"read":true,"write":true,"execute":true}}]
    });
    let length = mapped_input(config, &bytes);
    assert_eq!(mapped::core_init_mapped(0x1000, length), 0);
    BRIDGE.with_borrow_mut(|bridge| bridge.core.as_mut().unwrap().context_version = epoch);
}
fn compile() -> u64 {
    assert_eq!(core_compile(0x1000, 8, 128, 65536), 0);
    BRIDGE.with_borrow(|bridge| {
        let value: serde_json::Value = serde_json::from_slice(&bridge.info).unwrap();
        u64::from_str_radix(
            value["owner"].as_str().unwrap().trim_start_matches("0x"),
            16,
        )
        .unwrap()
    })
}
fn bank(root: &str) {
    mapped_input(
        serde_json::json!({"cr0":"0x80000033","cr2":"0x0","cr3":"0x1000","cr4":"0x628","efer":"0x0","pdpte":[root,"0x0","0x0","0x0"]}),
        &[],
    );
    assert_eq!(paging::core_import_paging(), 0);
}
#[test]
fn quartet_changes_and_same_cr3_reload_retire_primed_pending_and_aba_owners_at_epoch_max() {
    for epoch in [0, u64::MAX] {
        fixture(epoch);
        let installed = compile();
        assert_eq!(mapped::core_publish(installed), 1);
        assert_eq!(mapped::core_activate(installed), 1);
        let pending = compile();
        bank("0x5001");
        assert_eq!(mapped::core_validity(installed), 0);
        assert_eq!(mapped::core_validity(pending), 0);
        bank("0x3001");
        assert_eq!(mapped::core_publish(pending), 0);
        assert_eq!(mapped::core_activate(installed), 0);
        let fresh = compile();
        assert!(fresh > pending);
        assert_eq!(mapped::core_publish(fresh), 1);
        assert_eq!(mapped::core_activate(fresh), 1);
        assert_eq!(paging::core_paging_control(1, 3, 0x1000, 0x1000, 2, 0), 0);
        assert_eq!(
            mapped::core_activate(fresh),
            0,
            "same-value guest reload is a destructive fence"
        );
        assert_eq!(
            BRIDGE.with_borrow(|bridge| bridge.core.as_ref().unwrap().context_version),
            epoch.saturating_add(3)
        );
    }
}
