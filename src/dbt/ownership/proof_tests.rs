use super::*;
use crate::x86::context::Segment;
use std::cell::Cell;

#[test]
fn context_proof_requires_full_match_and_successful_source_admission() {
    let context = ExecutionContext::default();
    let mut other = context.clone();
    let mut cache = other.segment(Segment::Fs);
    cache.base = 0x10000;
    other.set_segment(Segment::Fs, 0, cache, other.attributes(Segment::Fs));
    let mut owners = Owners::default();
    assert!(owners.register(1, &context, false, 0));
    assert!(!owners.records[&1].context_proven);
    let called = Cell::new(0);
    let source = || {
        called.set(called.get() + 1);
        true
    };
    assert!(!owners.admit(1, &context, false, source));
    assert_eq!(called.get(), 0);
    assert!(owners.publish(1, &context, false, 0));
    assert!(!owners.records[&1].context_proven);
    assert!(!owners.admit(1, &other, false, source));
    assert_eq!(called.get(), 0);
    assert!(!owners.admit(1, &context, false, || false));
    assert!(!owners.records[&1].context_proven);
    assert!(owners.admit(1, &context, false, source));
    assert!(owners.records[&1].context_proven);
    assert!(owners.admit(1, &context, false, source));
    assert_eq!(called.get(), 2);
    assert!(!owners.admit(1, &context, true, source));
    assert_eq!(called.get(), 2);
    assert!(owners.records[&1].context_proven);
    assert!(owners.admit(1, &context, false, source));
    assert!(!owners.admit(1, &context, false, || false));
    owners.release(1);
    assert!(!owners.admit(1, &context, false, source));
}

#[test]
fn context_proof_is_cleared_for_published_owners_and_pending_aba_is_cancelled() {
    for epoch in [0, u64::MAX] {
        let context = ExecutionContext::default();
        let mut other = context.clone();
        other.set_mode_and_cpl(crate::x86::context::Mode::Long64, 3);
        let mut owners = Owners::default();
        assert!(owners.register(1, &context, false, epoch));
        assert!(owners.publish(1, &context, false, epoch));
        assert!(owners.admit(1, &context, false, || true));
        assert!(owners.records[&1].context_proven);
        assert!(owners.register(2, &context, false, epoch));
        let mut released = Vec::new();
        owners.cancel_pending(|owner| released.push(owner));
        assert_eq!(released, [2]);
        assert!(
            !owners.records[&1].context_proven,
            "prime before notification at {epoch}"
        );
        assert!(!owners.admit(1, &other, false, || panic!(
            "wrong context must not activate"
        )));
        owners.cancel_pending(|_| panic!("published owner retained"));
        assert!(owners.admit(1, &context, false, || true));
        assert!(!owners.publish(2, &context, false, epoch));
        owners.clear();
        assert!(!owners.admit(1, &context, false, || true));
    }
}
