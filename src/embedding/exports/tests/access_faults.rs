use super::super::exception_delivery::{core_configure_delivery, core_stage_exception};
use super::*;
use crate::x86::exception::EventState;

#[test]
fn reached_decode_faults_preserve_report_frontiers_and_select_distinct_fault_images() {
    let mut overlong = vec![0x66; 15];
    overlong.push(0x90);
    for (bytes, reason, selected) in [
        (vec![0xf0, 0x90], INVALID, Some((6, None))),
        (overlong, INVALID, Some((13, Some(0)))),
        (vec![0x0f, 0x0b], UNSUPPORTED, Some((6, None))),
        (vec![0xf0, 0xf4], INVALID, Some((6, None))),
        (vec![0x82], UNSUPPORTED, None),
        (vec![0x0f, 0xa2], UNSUPPORTED, None),
        (vec![0xf0, 0xf0], UNSUPPORTED, None),
        (vec![0x66; 14], FETCH, None),
    ] {
        initialize(0x1000, &bytes);
        BRIDGE.with_borrow_mut(|b| unsafe {
            (*b.core.as_mut().unwrap().state.get()).flags = 0x10002
        });
        assert_eq!(core_probe(0x1000), reason);
        assert_eq!(core_stage_exception(reason), 0);
        BRIDGE.with_borrow(|b| {
            assert_eq!(
                unsafe { (*b.core.as_ref().unwrap().state.get()).flags },
                0x10002
            )
        });
        assert_eq!(core_configure_delivery(1), 0);
        assert_eq!(
            core_stage_exception(reason),
            i32::from(selected.is_some()),
            "{bytes:x?}"
        );
        BRIDGE.with_borrow(|b| {
            let s = unsafe { &*b.core.as_ref().unwrap().state.get() };
            if let Some((vector, error_code)) = selected {
                let EventState::Pending(event) = s.event.decode().unwrap() else {
                    panic!("pending source")
                };
                assert_eq!(
                    (
                        event.vector,
                        event.error_code,
                        event.return_pc,
                        event.saved_flags
                    ),
                    (vector, error_code, 0x1000, 0x10002)
                );
                assert_eq!(s.flags, 2);
            } else {
                assert_eq!(s.flags, 0x10002);
                assert_eq!(s.event.kind, 0);
            }
        });
    }
}

#[test]
fn scalar_failure_segment_is_classified_after_generated_provenance_publication() {
    for (segment, vector) in [(Segment::Ss, 12), (Segment::Ds, 13), (Segment::Fs, 13)] {
        initialize(0x1000, &[0x90]);
        assert_eq!(core_configure_delivery(1), 0);
        assert_eq!(core_load(0x8000_0000_0000, 8), 0);
        BRIDGE.with_borrow_mut(|b| unsafe {
            (*b.core.as_mut().unwrap().state.get()).fault_segment = segment as u32
        });
        assert_eq!(core_stage_exception(DATA), 1);
        BRIDGE.with_borrow(|b| {
            let s = unsafe { &*b.core.as_ref().unwrap().state.get() };
            let EventState::Pending(event) = s.event.decode().unwrap() else {
                panic!("pending source")
            };
            assert_eq!((event.vector, event.error_code), (vector, Some(0)));
        });
    }
}
