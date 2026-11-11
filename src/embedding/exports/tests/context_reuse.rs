use super::*;

fn compile_and_publish() -> u64 {
    assert_eq!(core_compile(0x1000, 8, 128, 65536), 0);
    let owner = BRIDGE.with_borrow(|bridge| {
        let info: serde_json::Value = serde_json::from_slice(&bridge.info).unwrap();
        u64::from_str_radix(info["owner"].as_str().unwrap().trim_start_matches("0x"), 16).unwrap()
    });
    assert_eq!(mapped::core_publish(owner), 1);
    owner
}

fn import_context(value: serde_json::Value) {
    BRIDGE.with_borrow_mut(|bridge| bridge.input = serde_json::to_vec(&value).unwrap());
    assert_eq!(context::core_set_context(), 0);
}

#[test]
fn context_reuse_keeps_a_published_owner_alive_but_refuses_the_wrong_context() {
    initialize(0x1000, &[0x90]);
    let owner = compile_and_publish();
    let first = BRIDGE.with_borrow(|bridge| bridge.core.as_ref().unwrap().context.to_json());
    let mut second = first.clone();
    second["segments"]["fs"]["base"] = serde_json::json!("0x10000");
    import_context(second);
    assert_eq!(
        mapped::core_validity(owner),
        1,
        "context mismatch is dormancy, not death"
    );
    assert_eq!(
        mapped::core_activate(owner),
        0,
        "dormant native code cannot run"
    );
    import_context(first);
    assert_eq!(mapped::core_validity(owner), 1);
    assert_eq!(
        mapped::core_activate(owner),
        1,
        "semantic A/B/A reuse ignores the publication epoch"
    );
}

#[test]
fn context_reuse_activation_checks_the_captured_context_not_only_memory_and_profile() {
    initialize(0x1000, &[0x90]);
    let owner = compile_and_publish();
    BRIDGE.with_borrow_mut(|bridge| {
        let context = &mut bridge.core.as_mut().unwrap().context;
        let mut fs = context.segment(Segment::Fs);
        fs.base = 0xffff800000001000;
        context.set_segment(
            Segment::Fs,
            context.selector(Segment::Fs),
            fs,
            context.attributes(Segment::Fs),
        );
    });
    assert_eq!(mapped::core_validity(owner), 1);
    assert_eq!(
        mapped::core_activate(owner),
        0,
        "unchanged bytes cannot validate an embedded old base"
    );
}

fn compile_pending() -> u64 {
    assert_eq!(core_compile(0x1000, 8, 128, 65536), 0);
    BRIDGE.with_borrow(|bridge| {
        let info: serde_json::Value = serde_json::from_slice(&bridge.info).unwrap();
        u64::from_str_radix(info["owner"].as_str().unwrap().trim_start_matches("0x"), 16).unwrap()
    })
}

#[test]
fn context_reuse_pending_aba_is_cancelled_even_when_epoch_saturates() {
    for epoch in [0, u64::MAX - 1, u64::MAX] {
        initialize(0x1000, &[0x90]);
        BRIDGE.with_borrow_mut(|bridge| bridge.core.as_mut().unwrap().context_version = epoch);
        let installed = compile_and_publish();
        let pending = compile_pending();
        assert_eq!(
            mapped::core_activate(pending),
            0,
            "publication precedes native admission"
        );
        let first = BRIDGE.with_borrow(|bridge| bridge.core.as_ref().unwrap().context.to_json());
        let mut second = first.clone();
        second["segments"]["gs"]["base"] = serde_json::json!("0xffff800000001000");
        import_context(second);
        assert_eq!(mapped::core_validity(installed), 1);
        assert_eq!(mapped::core_validity(pending), 0);
        import_context(first);
        assert_eq!(
            mapped::core_publish(pending),
            0,
            "pending ABA cannot adopt current facts"
        );
        assert_eq!(
            mapped::core_activate(installed),
            1,
            "published dormant owner ignores epoch"
        );
        let fresh = compile_pending();
        assert_eq!(
            mapped::core_publish(fresh),
            1,
            "saturation does not block fresh work"
        );
        assert_eq!(mapped::core_activate(fresh), 1);
        mapped::core_release(fresh);
        mapped::core_release(fresh);
        assert_eq!(mapped::core_validity(fresh), 0);
        BRIDGE.with_borrow(|bridge| {
            assert!(
                !bridge
                    .core
                    .as_ref()
                    .unwrap()
                    .translation_owners
                    .contains(fresh)
            );
        });
    }
}

#[test]
fn context_reuse_publication_refuses_late_context_profile_and_invalid_sources() {
    for change in ["context", "profile", "source", "epoch"] {
        initialize(0x1000, &[0x90]);
        let owner = compile_pending();
        BRIDGE.with_borrow_mut(|bridge| {
            let core = bridge.core.as_mut().unwrap();
            match change {
                "context" => {
                    core.context.set_idtr(crate::x86::context::TableRegister {
                        base: 0x8000,
                        limit: 0x123,
                    });
                }
                "profile" => unsafe { (*core.state.get()).flags = 0x102 },
                "source" => core.image.release(owner),
                _ => core.context_version += 1,
            }
        });
        assert_eq!(mapped::core_publish(owner), 0, "{change}");
        assert_eq!(
            mapped::core_activate(owner),
            0,
            "unpublished {change} owner cannot run"
        );
        mapped::core_release(owner);
        BRIDGE.with_borrow(|bridge| {
            assert!(
                !bridge
                    .core
                    .as_ref()
                    .unwrap()
                    .translation_owners
                    .contains(owner)
            )
        });
    }
}

#[test]
fn context_reuse_dormant_alias_writes_are_permanent_death_not_mismatch() {
    let config = mapped_configuration();
    let length = mapped_input(config, &[0x90, 0x82, 0xa5, 0xa5, 0xa5, 0xa5, 0xa5, 0xa5]);
    assert_eq!(mapped::core_init_mapped(0x1000, length), 0);
    let owner = compile_and_publish();
    let first = BRIDGE.with_borrow(|bridge| bridge.core.as_ref().unwrap().context.to_json());
    let mut second = first.clone();
    second["segments"]["fs"]["base"] = serde_json::json!("0x10000");
    import_context(second);
    assert_eq!(mapped::core_validity(owner), 1);
    assert_eq!(
        core_store(0x4000, 1, 0x90),
        1,
        "identity write through alias still invalidates dormant code"
    );
    assert_eq!(mapped::core_validity(owner), 0);
    import_context(first);
    assert_eq!(mapped::core_activate(owner), 0);
    assert_eq!(mapped::core_publish(owner), 0);
}

fn paged_fixture() {
    let mut bytes = vec![0; 0xa000];
    for (offset, word) in [
        (0x1000, 0x2027u64),
        (0x2000, 0x3027),
        (0x3010, 0x4027),
        (0x4000, 0x9067),
    ] {
        bytes[offset..offset + 8].copy_from_slice(&word.to_le_bytes());
    }
    bytes[0x9000] = 0x90;
    bytes[0x9001] = 0x82;
    let config = serde_json::json!({
        "memoryModel":"ia32e-paged", "paging":{"cr0":"0x80000033","cr2":"0xdead","cr3":"0x1000","cr4":"0x628","efer":"0x500"},
        "memoryLimits":{"maxBackingBytes":40960,"maxBackings":1,"maxMappings":1},
        "backings":[{"id":"ram","length":40960}],
        "mappings":[{"base":"0x0","backing":"ram","offset":0,"length":40960,"permissions":{"read":true,"write":true,"execute":true}}]
    });
    let length = mapped_input(config, &bytes);
    assert_eq!(mapped::core_init_mapped(0x400000, length), 0);
}

fn paged_owner() -> u64 {
    assert_eq!(core_compile(0x400000, 8, 128, 65536), 0);
    let owner = BRIDGE.with_borrow(|bridge| {
        let info: serde_json::Value = serde_json::from_slice(&bridge.info).unwrap();
        u64::from_str_radix(info["owner"].as_str().unwrap().trim_start_matches("0x"), 16).unwrap()
    });
    assert_eq!(mapped::core_publish(owner), 1);
    owner
}

#[test]
fn context_reuse_keeps_exact_paging_fences_and_dynamic_nonfences() {
    use super::super::paging::{core_import_paging, core_paging_control};
    for (kind, register, value, destructive) in [
        (1, 3, 0x1000, true),
        (1, 3, 0x5000, true),
        (1, 0, 0x80010033, true),
        (3, 0xc0000080, 0xd00, true),
        (4, Segment::Ds as u32, 0x400000, true),
        (4, Segment::Ds as u32, 0x800000000000, false),
        (1, 0, 0x80000033, false),
        (1, 4, 0x628, false),
        (1, 2, 0xffffffffffffffff, false),
        (3, 0xc0000080, 0x500, false),
        (3, 0xc0000080, 0x501, false),
    ] {
        paged_fixture();
        let owner = paged_owner();
        assert_eq!(core_paging_control(kind, register, value, 0x400000, 2), 0);
        assert_eq!(
            mapped::core_validity(owner),
            i32::from(!destructive),
            "kind{kind} register{register:x} value{value:x}"
        );
        if !destructive {
            assert_eq!(mapped::core_activate(owner), 1);
        }
        // Restoring the root/control values never resurrects a destructively retired owner.
        BRIDGE.with_borrow_mut(|bridge| {
            bridge.input = br#"{"cr0":"0x80000033","cr2":"0xdead","cr3":"0x1000","cr4":"0x628","efer":"0x500"}"#.to_vec();
        });
        assert_eq!(core_import_paging(), 0);
        assert_eq!(mapped::core_validity(owner), i32::from(!destructive));
    }
}
