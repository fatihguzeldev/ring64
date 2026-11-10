use super::*;
use crate::x86::{context::ExecutionContext, exception::ExceptionEvent};

#[test]
fn execute_and_general_detect_are_distinct_saved_images_and_secondary_drops_debug() {
    let c = ExecutionContext::default();
    let mut e = ExceptionEvent::fault(1, 0x1000, 2, &c, None);
    e.saved_flags = 2;
    e.debug = Some(Source::Execute(1));
    assert!(e.validate(0x1000, 2, &c).is_ok());
    e.saved_flags = 0x10002;
    assert!(e.validate(0x1000, 2, &c).is_err());
    e.debug = Some(Source::GeneralDetect);
    assert!(e.validate(0x1000, 2, &c).is_ok());
    let crate::x86::exception::EventState::Pending(next) = e.escalate(13, 0) else {
        panic!("secondary")
    };
    assert_eq!(
        (next.vector, next.saved_flags, next.debug),
        (13, 0x10002, None)
    );
}
