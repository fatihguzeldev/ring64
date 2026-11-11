use super::*;
use crate::x86::context::{Mode, Segment, SegmentType};

#[test]
fn context_reuse_assumptions_distinguish_every_normalized_context_field() {
    let original = ExecutionContext::default();
    let mut owners = Owners::default();
    assert!(owners.register(1, &original, false, 17));
    assert!(!owners.eligible(1, &original, false));
    assert!(owners.publish(1, &original, false, 17));
    assert!(owners.eligible(1, &original, false));
    assert!(!owners.eligible(1, &original, true));
    for mode in [
        Mode::Real,
        Mode::Protected,
        Mode::Compatibility,
        Mode::Virtual8086,
    ] {
        let mut changed = original.clone();
        changed.set_mode_and_cpl(mode, 0);
        assert!(!owners.eligible(1, &changed, false), "{mode:?}");
    }
    for cpl in [1, 2, 3] {
        let mut changed = original.clone();
        changed.set_mode_and_cpl(Mode::Long64, cpl);
        assert!(!owners.eligible(1, &changed, false), "CPL{cpl}");
    }
    for segment in Segment::ALL {
        for field in 0..14 {
            let mut changed = original.clone();
            let mut selector = changed.selector(segment);
            let mut cache = changed.segment(segment);
            let mut attributes = changed.attributes(segment);
            match field {
                0 => selector ^= 4,
                1 => cache.base = 0xffff800000000001,
                2 => cache.limit ^= 1,
                3 => cache.default32 = !cache.default32,
                4 => cache.usable = !cache.usable,
                5 => cache.kind = SegmentType::ExpandDownReadOnly,
                6 => attributes.dpl ^= 1,
                7 => attributes.present = !attributes.present,
                8 => attributes.conforming = !attributes.conforming,
                9 => attributes.accessed = !attributes.accessed,
                10 => attributes.long = !attributes.long,
                11 => attributes.granularity = !attributes.granularity,
                12 => attributes.available = !attributes.available,
                _ => cache.base = 0xffff800000000002,
            }
            changed.set_segment(segment, selector, cache, attributes);
            assert!(
                !owners.eligible(1, &changed, false),
                "{segment:?} field{field}"
            );
            assert!(
                owners.eligible(1, &original, false),
                "captured context is detached"
            );
        }
    }
    for idt in [false, true] {
        for base in [false, true] {
            let mut changed = original.clone();
            let mut table = if idt { changed.idtr() } else { changed.gdtr() };
            if base {
                table.base = 0xffff800000000000;
            } else {
                table.limit ^= 1;
            }
            if idt {
                changed.set_idtr(table);
            } else {
                changed.set_gdtr(table);
            }
            assert!(!owners.eligible(1, &changed, false));
        }
    }
    for task in [false, true] {
        for field in 0..5 {
            let mut changed = original.clone();
            if task {
                let mut table = changed.tr();
                match field {
                    0 => table.selector = 8,
                    1 => table.valid = !table.valid,
                    2 => table.base = 0xffff800000001000,
                    3 => table.limit ^= 1,
                    _ => table.attributes ^= 1,
                }
                changed.set_tr(table);
            } else {
                let mut table = changed.ldtr();
                match field {
                    0 => table.selector = 8,
                    1 => table.valid = !table.valid,
                    2 => table.base = 0xffff800000001000,
                    3 => table.limit ^= 1,
                    _ => table.attributes ^= 1,
                }
                changed.set_ldtr(table);
            }
            assert!(
                !owners.eligible(1, &changed, false),
                "task{task} field{field}"
            );
        }
    }
}

#[test]
fn context_reuse_publication_is_stricter_than_installed_eligibility() {
    let context = ExecutionContext::default();
    let mut owners = Owners::default();
    assert!(owners.register(1, &context, false, 8));
    assert!(
        !owners.publish(1, &context, false, 9),
        "pending epoch cannot change"
    );
    assert!(!owners.publish(1, &context, true, 8));
    assert!(!owners.eligible(1, &context, false));
    assert!(owners.publish(1, &context, false, 8));
    assert!(owners.eligible(1, &context, false));
    assert!(
        owners.publish(1, &context, false, u64::MAX),
        "published identity ignores epoch"
    );
    assert!(owners.register(2, &context, false, 8));
    let mut released = Vec::new();
    owners.cancel_pending(|id| released.push(id));
    assert_eq!(released, [2]);
    assert!(owners.contains(1));
    assert!(!owners.contains(2));
    assert!(!owners.publish(2, &context, false, 8));
    owners.release(1);
    assert!(!owners.eligible(1, &context, false));
    assert!(!owners.publish(1, &context, false, 8));
    owners.clear();
    assert!(owners.records.is_empty());
}
