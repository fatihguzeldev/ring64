use super::*;
use serde_json::{Value, json};

#[test]
fn snapshot_default_has_visible_and_hidden_state_without_tables() {
    let value = ExecutionContext::default().to_json();
    assert_eq!(value["cpl"], json!(0));
    assert_eq!(value["segments"]["cs"]["selector"], json!(8));
    assert_eq!(value["segments"]["cs"]["long"], json!(true));
    assert_eq!(value["segments"]["ss"]["selector"], json!(16));
    assert_eq!(value["segments"]["fs"]["base"], json!("0x0"));
    assert_eq!(value["gdtr"], json!({"base":"0x0","limit":0}));
    assert_eq!(
        value["ldtr"],
        json!({"selector":0,"valid":false,"base":"0x0","limit":0,"attributes":0})
    );
}

#[test]
fn snapshot_raw_hidden_state_and_unloaded_system_roots_roundtrip() {
    let mut value = ExecutionContext::default().to_json();
    value["cpl"] = json!(2);
    value["gdtr"] = json!({"base":"0x800000000000","limit":65535});
    value["idtr"] = json!({"base":"0xffffffffffffffff","limit":9});
    value["ldtr"] = json!({"selector":65535,"valid":true,"base":"0x100000000","limit":0x12345678,"attributes":4095});
    value["segments"]["ss"] = json!({"selector":2,"base":"0x0","limit":0,"default32":false,"usable":false,"type":"read-only","dpl":0,"present":false,"conforming":false,"accessed":false,"long":false,"granularity":false,"available":false});
    value["segments"]["ds"]["base"] = json!("0x123456789abcdef0");
    value["segments"]["ds"]["limit"] = json!(0x12345678);
    value["segments"]["ds"]["conforming"] = json!(true);
    value["segments"]["ds"]["available"] = json!(true);
    let context = ExecutionContext::from_json(&value).unwrap();
    assert_eq!(context.to_json(), value);
    assert_eq!(context.stack_width(), Width::W64);
    assert_eq!(context.segment_base(Segment::Ds), 0);
    assert_eq!(context.gdtr().base, 0x800000000000);
    assert_eq!(context.ldtr().attributes, 0xfff);
    // No memory owner is supplied: importing loaded state cannot consult tables.
    assert_eq!(ExecutionContext::from_json(&context.to_json()), Ok(context));
}

#[test]
fn snapshot_partial_fields_and_legacy_aliases_never_select_shorthand_fallback() {
    for key in ["cpl", "gdtr", "idtr", "ldtr"] {
        let mut value = ExecutionContext::default().to_json();
        value.as_object_mut().unwrap().remove(key);
        assert!(
            ExecutionContext::from_json(&value).is_err(),
            "missing {key}"
        );
        let mut legacy = json!({"mode":"long64","fsBase":"0x0","gsBase":"0x0"});
        legacy[key] = Value::Null;
        assert!(
            ExecutionContext::from_json(&legacy).is_err(),
            "partial {key}"
        );
    }
    for key in ["fsBase", "gsBase"] {
        let mut value = ExecutionContext::default().to_json();
        value[key] = Value::Null;
        assert!(ExecutionContext::from_json(&value).is_err());
    }
    for key in [
        "selector",
        "dpl",
        "present",
        "conforming",
        "accessed",
        "long",
        "granularity",
        "available",
    ] {
        let mut value = protected().to_json();
        value["segments"]["ds"].as_object_mut().unwrap().remove(key);
        assert!(
            ExecutionContext::from_json(&value).is_err(),
            "missing {key}"
        );
        for root in ["cpl", "gdtr", "idtr", "ldtr"] {
            value.as_object_mut().unwrap().remove(root);
        }
        assert!(
            ExecutionContext::from_json(&value).is_err(),
            "partial {key}"
        );
    }
}

#[test]
fn snapshot_domains_distinguish_compatibility_system_bases_from_data_bases() {
    for root in ["gdtr", "idtr", "ldtr"] {
        let mut value = protected().to_json();
        value[root]["base"] = json!("0x100000000");
        assert!(ExecutionContext::from_json(&value).is_err());
        value["mode"] = json!("compatibility");
        let context = ExecutionContext::from_json(&value).unwrap();
        assert_eq!(context.to_json(), value);
        value["segments"]["ds"]["base"] = json!("0x100000000");
        assert!(ExecutionContext::from_json(&value).is_err());
    }
    for (object, key, invalid) in [
        ("gdtr", "limit", json!(65536)),
        ("idtr", "base", json!("0x10000000000000000")),
        ("ldtr", "selector", json!(65536)),
        ("ldtr", "attributes", json!(4096)),
        ("ldtr", "limit", json!(0x100000000u64)),
        ("ldtr", "valid", json!(1)),
    ] {
        let mut value = ExecutionContext::default().to_json();
        value[object][key] = invalid;
        assert!(
            ExecutionContext::from_json(&value).is_err(),
            "{object}.{key}"
        );
    }
    for (key, invalid) in [
        ("selector", json!(65536)),
        ("dpl", json!(4)),
        ("present", json!(1)),
        ("long", json!(1)),
    ] {
        let mut value = ExecutionContext::default().to_json();
        value["segments"]["ds"][key] = invalid;
        assert!(ExecutionContext::from_json(&value).is_err(), "{key}");
    }
}

#[test]
fn snapshot_all_fourteen_legacy_profiles_keep_cache_facts_and_normalize_metadata() {
    let mut count = 1;
    for mode in ["real", "protected", "compatibility", "virtual8086"] {
        for code32 in [false, true] {
            for stack32 in [false, true] {
                if mode == "virtual8086" && (code32 || stack32) {
                    continue;
                }
                let mut segments = serde_json::Map::new();
                for segment in Segment::ALL {
                    let vm = mode == "virtual8086";
                    let default32 = if vm {
                        false
                    } else if segment == Segment::Cs {
                        code32
                    } else if segment == Segment::Ss {
                        stack32
                    } else {
                        true
                    };
                    segments.insert(segment.name().into(), json!({
                        "base":"0x0","limit":if vm {0xffff} else {u32::MAX},
                        "default32":default32,"usable":true,
                        "type":if !vm && segment == Segment::Cs {"readable-code"} else {"read-write"},
                    }));
                }
                let value = json!({"mode":mode,"segments":segments});
                let context = ExecutionContext::from_json(&value).unwrap();
                assert_eq!(context.cpl(), if mode == "virtual8086" { 3 } else { 0 });
                for segment in Segment::ALL {
                    let expected = if mode == "real" || mode == "virtual8086" {
                        0
                    } else if segment == Segment::Cs {
                        8
                    } else if segment == Segment::Ss {
                        16
                    } else {
                        24
                    };
                    assert_eq!(context.selector(segment), expected);
                    let attrs = context.attributes(segment);
                    assert!(attrs.present && attrs.accessed);
                    assert_eq!(attrs.granularity, mode != "virtual8086");
                    assert!(!attrs.long && !attrs.available && !attrs.conforming);
                }
                assert_eq!(context.gdtr(), TableRegister::default());
                assert_eq!(context.ldtr(), LdtRegister::default());
                assert_eq!(ExecutionContext::from_json(&context.to_json()), Ok(context));
                count += 1;
            }
        }
    }
    assert_eq!(count, 14);
}

#[test]
fn prepared_context_updates_report_changes_without_reloading_other_caches() {
    let mut context = protected();
    let ds = context.segment(Segment::Ds);
    let attrs = context.attributes(Segment::Ds);
    let table = TableRegister {
        base: 0x7000,
        limit: 0xffff,
    };
    assert!(context.set_gdtr(table));
    assert!(!context.set_gdtr(table));
    assert!(context.set_idtr(table));
    assert!(!context.set_idtr(table));
    let ldt = LdtRegister {
        selector: 8,
        valid: true,
        base: 0x8000,
        limit: 0x1234,
        attributes: 0x82,
    };
    assert!(context.set_ldtr(ldt));
    assert!(!context.set_ldtr(ldt));
    assert_eq!(context.segment(Segment::Ds), ds);
    assert!(!context.set_segment(Segment::Ds, 24, ds, attrs));
    assert!(context.set_segment(Segment::Ds, 32, ds, attrs));
    assert_eq!(context.selector(Segment::Ds), 32);
    assert_eq!(context.gdtr(), table);
}

#[test]
fn clflush_changes_only_the_execute_only_segment_read_rule() {
    for segment in [Segment::Cs, Segment::Ds] {
        let mut context = protected();
        context.segments[segment as usize].kind = SegmentType::Code;
        context.segments[segment as usize].base = 0x2000;
        context.segments[segment as usize].limit = 0xfff;
        let before = context.clone();
        assert_eq!(context.translate_clflush(0xfff, segment), Ok(0x2fff));
        assert_eq!(
            context.translate(0xfff, 1, segment, Access::Read, false),
            Err(AccessFailure::Segment(SegmentFault {
                segment,
                offset: 0xfff,
                width: 1,
                access: Access::Read,
                cause: SegmentCause::Type,
                failing: 0xfff
            }))
        );
        assert_eq!(
            context.translate_clflush(0x1000, segment),
            Err(AccessFailure::Segment(SegmentFault {
                segment,
                offset: 0x1000,
                width: 1,
                access: Access::Read,
                cause: SegmentCause::Limit,
                failing: 0x1000
            }))
        );
        assert_eq!(context, before);
    }
}

#[test]
fn clflush_preserves_unusable_expand_down_and_linear_geometry_checks() {
    let mut context = protected();
    let ds = &mut context.segments[Segment::Ds as usize];
    ds.kind = SegmentType::ExpandDownReadOnly;
    ds.default32 = false;
    ds.limit = 0xff00;
    ds.base = 0x1000;
    assert_eq!(context.translate_clflush(0xffff, Segment::Ds), Ok(0x10fff));
    for offset in [0xff00, 0x10000] {
        let Err(AccessFailure::Segment(fault)) = context.translate_clflush(offset, Segment::Ds)
        else {
            panic!()
        };
        assert_eq!(
            (fault.cause, fault.width, fault.access),
            (SegmentCause::Limit, 1, Access::Read)
        );
    }
    context.segments[Segment::Ds as usize].usable = false;
    let Err(AccessFailure::Segment(fault)) = context.translate_clflush(0, Segment::Ds) else {
        panic!()
    };
    assert_eq!(fault.cause, SegmentCause::Unusable);

    let context = ExecutionContext::from_json(&json!({
        "mode":"long64", "fsBase":"0x1000", "gsBase":"0x0"
    }))
    .unwrap();
    assert_eq!(
        context.translate_clflush(u64::MAX, Segment::Cs),
        Ok(u64::MAX)
    );
    assert_eq!(context.translate_clflush(u64::MAX, Segment::Fs), Ok(0xfff));
    assert_eq!(
        context.translate_clflush(0x8000_0000_0000, Segment::Ds),
        Err(AccessFailure::Linear(Fault {
            address: 0x8000_0000_0000,
            width: 1,
            access: Access::Read,
            cause: Cause::Noncanonical,
            failing: 0x8000_0000_0000
        }))
    );
}

fn protected() -> ExecutionContext {
    let segment =
        json!({"base":"0x0","limit":u32::MAX,"default32":true,"usable":true,"type":"read-write"});
    let mut value = json!({"mode":"protected","segments":{"cs":segment,"ss":segment,"ds":segment,"es":segment,"fs":segment,"gs":segment}});
    value["segments"]["cs"]["type"] = json!("readable-code");
    ExecutionContext::from_json(&value).unwrap()
}

#[test]
fn context_input_is_normalized_and_profiles_keep_loaded_facts() {
    let context = protected();
    assert_eq!(
        ExecutionContext::from_json(&context.to_json()),
        Ok(context.clone())
    );
    let mut real = context.to_json();
    real["mode"] = json!("real");
    real["segments"]["cs"]["base"] = json!("0xffff0000");
    real["segments"]["cs"]["type"] = json!("read-write");
    let real = ExecutionContext::from_json(&real).unwrap();
    assert_eq!(real.segment_base(Segment::Cs), 0xffff0000);
    assert!(real.code32());
    assert_eq!(
        ExecutionContext::from_json(
            &json!({"mode":"long64","fsBase":"0x800000000000","gsBase":"0x0"})
        ),
        Err("invalid execution context")
    );
}

#[test]
fn virtual8086_has_synthetic_writable_cs_and_fixed_normalized_caches() {
    let mut value = protected().to_json();
    value["mode"] = json!("virtual8086");
    value["cpl"] = json!(3);
    for segment in Segment::ALL {
        let s = &mut value["segments"][segment.name()];
        s["type"] = json!("read-write");
        s["limit"] = json!(0xffff);
        s["default32"] = json!(false);
        s["selector"] = json!(0);
        s["dpl"] = json!(3);
        s["granularity"] = json!(false);
    }
    let context = ExecutionContext::from_json(&value).unwrap();
    assert_eq!(
        context.translate(0x1000, 1, Segment::Cs, Access::Execute, false),
        Ok(0x1000)
    );
    value["segments"]["cs"]["default32"] = json!(true);
    assert!(ExecutionContext::from_json(&value).is_err());
}

#[test]
fn segment_offset_width_and_linear_domain_are_distinct() {
    let mut c = protected();
    c.segments[Segment::Ds as usize].base = 0x10000;
    assert_eq!(
        c.translate(0xffff, 4, Segment::Ds, Access::Read, false),
        Ok(0x1ffff)
    );
    c.segments[Segment::Ds as usize].limit = 0xffff;
    let Err(AccessFailure::Segment(f)) = c.translate(0xffff, 4, Segment::Ds, Access::Read, false)
    else {
        panic!()
    };
    assert_eq!(
        (f.offset, f.width, f.cause, f.failing),
        (0xffff, 4, SegmentCause::Limit, 0x10000)
    );
    c.segments[Segment::Ds as usize].limit = u32::MAX;
    c.segments[Segment::Ds as usize].base = 0xfffffff0;
    assert_eq!(
        c.translate(0x20, 4, Segment::Ds, Access::Read, false),
        Ok(0x10)
    );
    c.segments[Segment::Ds as usize].base = 0xfffffffe;
    assert_eq!(
        c.translate(0, 4, Segment::Ds, Access::Read, false),
        Err(AccessFailure::Linear(Fault {
            address: 0xfffffffe,
            width: 4,
            access: Access::Read,
            cause: Cause::AddressRange,
            failing: 1u128 << 32
        }))
    );
}

#[test]
fn unusable_type_and_bounds_fail_before_any_linear_lookup() {
    let mut c = protected();
    let ds = &mut c.segments[Segment::Ds as usize];
    ds.usable = false;
    ds.kind = SegmentType::ReadOnly;
    ds.limit = 0;
    let Err(AccessFailure::Segment(f)) = c.translate(10, 4, Segment::Ds, Access::Write, true)
    else {
        panic!()
    };
    assert_eq!(f.cause, SegmentCause::Unusable);
    c.segments[Segment::Ds as usize].usable = true;
    let Err(AccessFailure::Segment(f)) = c.translate(10, 4, Segment::Ds, Access::Write, true)
    else {
        panic!()
    };
    assert_eq!(f.cause, SegmentCause::Type);
    assert_eq!(f.access, Access::Write);
    c.segments[Segment::Ds as usize].kind = SegmentType::ReadWrite;
    let Err(AccessFailure::Segment(f)) = c.translate(10, 4, Segment::Ds, Access::Write, true)
    else {
        panic!()
    };
    assert_eq!(f.cause, SegmentCause::Limit);
}

#[test]
fn expand_down_uses_its_loaded_upper_bound_and_can_be_empty() {
    let mut c = protected();
    let ds = &mut c.segments[Segment::Ds as usize];
    ds.kind = SegmentType::ExpandDownReadWrite;
    ds.default32 = false;
    ds.limit = 0xff00;
    assert_eq!(
        c.translate(0xff01, 2, Segment::Ds, Access::Read, false),
        Ok(0xff01)
    );
    let Err(AccessFailure::Segment(f)) = c.translate(0xffff, 2, Segment::Ds, Access::Read, false)
    else {
        panic!()
    };
    assert_eq!(f.failing, 0x10000);
    c.segments[Segment::Ds as usize].limit = 0xffff;
    assert!(
        c.translate(0xffff, 1, Segment::Ds, Access::Read, false)
            .is_err()
    );
    assert_eq!(ExecutionContext::from_json(&c.to_json()), Ok(c));
}

#[test]
fn real_code_writes_differ_from_read_only_data_and_unreadable_code_reads() {
    let mut c = protected();
    c.mode = Mode::Real;
    c.segments[Segment::Ds as usize].kind = SegmentType::Code;
    assert_eq!(c.translate(4, 1, Segment::Ds, Access::Write, false), Ok(4));
    assert!(matches!(
        c.translate(4, 1, Segment::Ds, Access::Read, false),
        Err(AccessFailure::Segment(_))
    ));
    assert!(matches!(
        c.translate(4, 1, Segment::Ds, Access::Write, true),
        Err(AccessFailure::Segment(_))
    ));
    c.segments[Segment::Ds as usize].kind = SegmentType::ReadOnly;
    assert!(matches!(
        c.translate(4, 1, Segment::Ds, Access::Write, false),
        Err(AccessFailure::Segment(_))
    ));
}

#[test]
fn long64_base_addition_wraps_before_canonical_span_validation() {
    let c = ExecutionContext::from_json(
        &json!({"mode":"long64","fsBase":"0xfffffffffffff000","gsBase":"0x100000000"}),
    )
    .unwrap();
    assert_eq!(
        c.translate(0x1000, 1, Segment::Fs, Access::Read, false),
        Ok(0)
    );
    assert_eq!(
        c.translate(0x1008, 4, Segment::Gs, Access::Read, false),
        Ok(0x100001008)
    );
    assert_eq!(
        c.translate(0x1000, 1, Segment::Ds, Access::Read, false),
        Ok(0x1000)
    );
}

#[test]
fn target_limit_is_a_point_check_and_raw_offsets_are_not_truncated() {
    let mut c = protected();
    c.segments[Segment::Cs as usize].limit = 0x10ff;
    assert_eq!(c.check_target(0x10ff), Ok(()));
    let Err(AccessFailure::Segment(f)) = c.check_target(0x1100) else {
        panic!()
    };
    assert_eq!(
        (f.segment, f.offset, f.width, f.access, f.failing),
        (Segment::Cs, 0x1100, 1, Access::Execute, 0x1100)
    );
    assert!(
        c.translate(0x100000000, 1, Segment::Cs, Access::Execute, false)
            .is_err()
    );
}
