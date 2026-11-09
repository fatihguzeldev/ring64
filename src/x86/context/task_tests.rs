use super::*;
use serde_json::json;

#[test]
fn old_full_context_omission_gets_a_fresh_invalid_task_cache() {
    let mut source = ExecutionContext::default().to_json();
    source.as_object_mut().unwrap().remove("tr");
    let parsed = ExecutionContext::from_json(&source).unwrap();
    assert_eq!(parsed.tr(), TaskRegister::default());
    assert_eq!(
        parsed.to_json()["tr"],
        json!({"selector":0,"valid":false,"base":"0x0","limit":0,"attributes":0})
    );
}

#[test]
fn task_snapshot_keeps_bounded_raw_fields_even_for_unusable_imports() {
    let mut source = ExecutionContext::default().to_json();
    source["tr"] = json!({"selector":65535,"valid":true,"base":"0xffffffffffffffff",
        "limit":4294967295u64,"attributes":4095});
    let context = ExecutionContext::from_json(&source).unwrap();
    assert_eq!(
        context.tr(),
        TaskRegister {
            selector: u16::MAX,
            valid: true,
            base: u64::MAX,
            limit: u32::MAX,
            attributes: 0xfff,
        }
    );
    assert_eq!(context.to_json()["tr"], source["tr"]);
    assert_eq!(
        ExecutionContext::from_json(&context.to_json()).unwrap(),
        context
    );
}

#[test]
fn malformed_task_cache_fields_are_not_an_omitted_cache() {
    let source = ExecutionContext::default().to_json();
    for value in [json!(null), json!(false), json!([]), json!({})] {
        let mut malformed = source.clone();
        malformed["tr"] = value;
        assert!(ExecutionContext::from_json(&malformed).is_err());
    }
    for (key, value) in [
        ("selector", json!(65536)),
        ("selector", json!(-1)),
        ("valid", json!(1)),
        ("base", json!(0)),
        ("base", json!("0x10000000000000000")),
        ("limit", json!(4294967296u64)),
        ("attributes", json!(4096)),
    ] {
        let mut malformed = source.clone();
        malformed["tr"][key] = value;
        assert!(ExecutionContext::from_json(&malformed).is_err(), "{key}");
    }
}

#[test]
fn task_presence_requires_the_complete_snapshot_and_legacy_bases_fit_u32() {
    let partial = json!({"mode":"long64","fsBase":"0x0","gsBase":"0x0",
        "tr":{"selector":0,"valid":false,"base":"0x0","limit":0,"attributes":0}});
    assert!(ExecutionContext::from_json(&partial).is_err());
    let mut source = ExecutionContext::default().to_json();
    source["mode"] = json!("protected");
    source["tr"] = json!({"selector":24,"valid":false,"base":"0xffffffff",
        "limit":65535,"attributes":139});
    assert_eq!(
        ExecutionContext::from_json(&source).unwrap().tr().base,
        0xffffffff
    );
    source["tr"]["base"] = json!("0x100000000");
    assert!(ExecutionContext::from_json(&source).is_err());
    source["mode"] = json!("compatibility");
    assert_eq!(
        ExecutionContext::from_json(&source).unwrap().tr().base,
        0x100000000
    );
}

#[test]
fn task_replacement_reports_only_actual_cached_fact_changes() {
    let mut context = ExecutionContext::default();
    let task = TaskRegister {
        selector: 24,
        valid: true,
        base: 0x9000,
        limit: 103,
        attributes: 0x8b,
    };
    assert!(context.set_tr(task));
    assert!(!context.set_tr(task));
    assert!(context.set_tr(TaskRegister::default()));
}
