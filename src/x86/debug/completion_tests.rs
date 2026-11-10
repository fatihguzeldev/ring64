use super::*;

fn boundary() -> Completion {
    Completion {
        pc: 0x1000,
        resume: 0x1002,
        completed: true,
        flags: 0x202,
        single_step: false,
        incoming_ss: false,
        ss_producer: false,
    }
}
#[test]
fn suppression_captures_oldest_origin_and_partial_tf_consumes_history_once() {
    let mut deferred = None;
    assert_eq!(
        complete(
            1,
            &mut deferred,
            Completion {
                ss_producer: true,
                single_step: true,
                ..boundary()
            }
        ),
        None
    );
    assert_eq!(
        deferred,
        Some(Deferred {
            slots: 1,
            origin: 0x1000
        })
    );
    assert_eq!(
        complete(
            2,
            &mut deferred,
            Completion {
                pc: 0x1002,
                resume: 0x1002,
                completed: false,
                incoming_ss: true,
                ..boundary()
            }
        ),
        None
    );
    let selection = complete(
        4,
        &mut deferred,
        Completion {
            pc: 0x1002,
            resume: 0x1002,
            completed: false,
            incoming_ss: true,
            single_step: true,
            flags: 0x302,
            ..boundary()
        },
    )
    .unwrap();
    assert_eq!(
        selection.source,
        Some(Source::Data {
            slots: 7,
            single_step: true,
            completed: false,
            origin: Some(0x1000)
        })
    );
    assert_eq!(selection.resume_flags, 0x10302);
    assert_eq!(deferred, None);
    assert_eq!(complete(0, &mut deferred, boundary()), None);
}
#[test]
fn selected_source_owns_resume_policy_and_current_status() {
    let execute = Selection::new(0x1000, 0x1000, false, 0x202, Some(Source::Execute(1)));
    let gd = Selection::new(0x1000, 0x1000, false, 0x202, Some(Source::GeneralDetect));
    let completed = Selection::new(
        0x1000,
        0x1000,
        true,
        0x10202,
        Some(Source::Data {
            slots: 2,
            single_step: false,
            completed: true,
            origin: None,
        }),
    );
    assert_eq!(
        (
            execute.resume_flags,
            gd.resume_flags,
            completed.resume_flags
        ),
        (0x202, 0x10202, 0x10202)
    );
    let mut bank = State {
        dr6: 0xffffefff,
        ..State::default()
    };
    bank.select_source(execute.source);
    assert_eq!(bank.dr6, 0xffffeff1);
    bank.select_source(gd.source);
    assert_eq!(bank.dr6, 0xffffeff0);
    bank.select_source(None);
    assert_eq!(bank.dr6, 0xffffeff0);
}
