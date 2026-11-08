use super::*;

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
    for segment in Segment::ALL {
        let s = &mut value["segments"][segment.name()];
        s["type"] = json!("read-write");
        s["limit"] = json!(0xffff);
        s["default32"] = json!(false);
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
