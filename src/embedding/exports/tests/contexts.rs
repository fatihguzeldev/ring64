use super::super::context::*;
use super::*;

fn protected() -> serde_json::Value {
    let segment = serde_json::json!({"base":"0x0","limit":u32::MAX,"default32":true,"usable":true,"type":"read-write"});
    let mut value = serde_json::json!({"mode":"protected","segments":{"cs":segment,"ss":segment,"ds":segment,"es":segment,"fs":segment,"gs":segment}});
    value["segments"]["cs"]["type"] = serde_json::json!("readable-code");
    value
}
fn set_context(value: serde_json::Value) -> i32 {
    BRIDGE.with_borrow_mut(|bridge| bridge.input = serde_json::to_vec(&value).unwrap());
    core_set_context()
}
fn info() -> serde_json::Value {
    BRIDGE.with_borrow(|bridge| serde_json::from_slice(&bridge.info).unwrap())
}

#[test]
fn context_import_is_atomic_preserves_raw_state_and_never_reuses_retired_owners() {
    initialize(0x1000, &[0xb8, 1, 0, 0, 0]);
    assert_eq!(core_compile(0x1000, 8, 128, 65536), 0);
    assert_eq!(info()["contextVersion"], "0x0");
    assert_eq!(mapped::core_validity(1), 1);
    core_context_info();
    let initial = info();
    assert_eq!(set_context(initial), 0);
    assert_eq!(core_context_version(), 0);
    assert_eq!(mapped::core_validity(1), 1);
    BRIDGE.with_borrow_mut(|bridge| {
        let state = unsafe { &mut *bridge.core.as_mut().unwrap().state.get() };
        state.registers = [u64::MAX; 16];
        state.flags = 0x8d7;
        state.rip = 0x123456789abcdef0;
    });
    let mut next = protected();
    next["segments"]["cs"]["base"] = serde_json::json!("0x10000");
    assert_eq!(set_context(next.clone()), 0);
    assert_eq!(core_context_version(), 1);
    assert_eq!(mapped::core_validity(1), 0);
    assert_eq!(core_load(0x4000, 1), 0xa5);
    BRIDGE.with_borrow(|bridge| {
        let state = unsafe { &*bridge.core.as_ref().unwrap().state.get() };
        assert_eq!(state.registers, [u64::MAX; 16]);
        assert_eq!(state.flags, 0x8d7);
        assert_eq!(state.rip, 0x123456789abcdef0);
    });
    next["segments"]["cs"]["type"] = serde_json::json!("read-only");
    assert_eq!(set_context(next), 1);
    assert_eq!(core_context_version(), 1);
    core_context_info();
    assert_eq!(info()["segments"]["cs"]["base"], "0x10000");
    assert_eq!(set_context(protected()), 0);
    assert_eq!(core_compile(0x1000, 8, 128, 65536), 0);
    assert_eq!(info()["owner"], "0x2");
    assert_eq!(mapped::core_validity(1), 0);
    assert_eq!(mapped::core_validity(2), 1);
}

#[test]
fn context_version_saturation_cannot_resurrect_an_old_source_token() {
    initialize(0x1000, &[0xb8, 1, 0, 0, 0]);
    assert_eq!(core_compile(0x1000, 8, 128, 65536), 0);
    BRIDGE.with_borrow_mut(|bridge| bridge.core.as_mut().unwrap().context_version = u64::MAX);
    assert_eq!(set_context(protected()), 0);
    assert_eq!(core_context_version(), u64::MAX);
    assert_eq!(mapped::core_validity(1), 0);
    assert_eq!(core_compile(0x1000, 8, 128, 65536), 0);
    assert_eq!(info()["owner"], "0x2");
    assert_eq!(mapped::core_validity(2), 1);
}

#[test]
fn segment_failures_precede_mapping_and_repair_does_not_keep_stale_faults() {
    initialize(0x1000, &[0xb8, 1, 0, 0, 0]);
    let mut ctx = protected();
    ctx["segments"]["ds"]["usable"] = serde_json::json!(false);
    ctx["segments"]["ds"]["limit"] = serde_json::json!(0);
    assert_eq!(set_context(ctx.clone()), 0);
    assert_eq!(
        core_segmented_load_for_write(0x7000, 4, Segment::Ds as u32),
        0
    );
    assert_eq!(core_segmented_access_failed(), 1);
    assert_eq!(core_access_reason(), SEGMENT);
    assert_eq!(
        metadata(SEGMENT),
        serde_json::json!({"segment":"ds","offset":"0x7000","width":4,"access":"write","cause":"unusable","failingOffset":"0x7000"})
    );
    assert_eq!(metadata(DATA), serde_json::Value::Null);
    ctx["segments"]["ds"]["usable"] = serde_json::json!(true);
    ctx["segments"]["ds"]["limit"] = serde_json::json!(u32::MAX);
    assert_eq!(set_context(ctx), 0);
    assert_eq!(core_segmented_load(0x7000, 4, Segment::Ds as u32), 0);
    assert_eq!(core_access_reason(), DATA);
    assert_eq!(metadata(SEGMENT), serde_json::Value::Null);
    assert_eq!(metadata(DATA)["segment"], "ds");
    assert_eq!(
        core_segmented_load(0x4000, 4, Segment::Ds as u32),
        0xa5a5a5a5
    );
    assert_eq!(core_segmented_access_failed(), 0);
    assert_eq!(metadata(SEGMENT), serde_json::Value::Null);
    assert_eq!(metadata(DATA), serde_json::Value::Null);
}

#[test]
fn raw_status_ignores_segment_failures_while_segmented_status_covers_both() {
    initialize(0x1000, &[0xf5]);
    let mut ctx = protected();
    ctx["segments"]["ds"]["usable"] = serde_json::json!(false);
    assert_eq!(set_context(ctx), 0);
    assert_eq!(core_segmented_load(0x7000, 4, Segment::Ds as u32), 0);
    assert_eq!(core_access_failed(), 0);
    assert_eq!(core_segmented_access_failed(), 1);

    core_clear_fault();
    assert_eq!(core_access_failed(), 0);
    assert_eq!(core_segmented_access_failed(), 0);
    assert_eq!(core_load(0x7000, 4), 0);
    assert_eq!(core_access_failed(), 1);
    assert_eq!(core_segmented_access_failed(), 1);
    assert_eq!(core_load(0x4000, 4), 0xa5a5a5a5);
    assert_eq!(core_access_failed(), 0);
    assert_eq!(core_segmented_access_failed(), 0);

    assert_eq!(set_context(protected()), 0);
    assert_eq!(core_segmented_load(0x7000, 4, Segment::Ds as u32), 0);
    assert_eq!(core_access_failed(), 1);
    assert_eq!(core_segmented_access_failed(), 1);
    assert_eq!(
        core_segmented_load(0x4000, 4, Segment::Ds as u32),
        0xa5a5a5a5
    );
    assert_eq!(core_access_failed(), 0);
    assert_eq!(core_segmented_access_failed(), 0);
}

#[test]
fn target_checks_are_points_without_fetching_a_target_or_touching_stack() {
    initialize(0x1000, &[0xb8, 1, 0, 0, 0]);
    let mut ctx = protected();
    ctx["segments"]["cs"]["limit"] = serde_json::json!(0x10ff);
    assert_eq!(set_context(ctx), 0);
    assert_eq!(core_target_check(0x10ff), 1);
    assert_eq!(core_access_failed(), 0);
    assert_eq!(core_target_check(0x1100), 0);
    assert_eq!(
        metadata(SEGMENT),
        serde_json::json!({"segment":"cs","offset":"0x1100","width":1,"access":"execute","cause":"limit","failingOffset":"0x1100"})
    );
    assert_eq!(core_load(0x4000, 8), 0xa5a5a5a5a5a5a5a5);
}
