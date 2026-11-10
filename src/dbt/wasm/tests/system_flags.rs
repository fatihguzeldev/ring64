use super::*;
use crate::embedding::layout::{BUDGET, DEBUG_EXCEPTION, DISPATCH, PROTECTION, X87_EXCEPTION};
use crate::x86::context::{ExecutionContext, Mode, Segment};
use crate::x86::instruction::{ProtectionDescriptor, ProtectionKind};

fn artifact(code: &[u8], context: &ExecutionContext, observed: bool) -> crate::dbt::Artifact {
    let image = crate::memory::Image::new(0x1000, code.to_vec(), 0x8000, vec![0; 8]).unwrap();
    crate::dbt::compile_with_context_observed(
        &image,
        context,
        0x1000,
        crate::dbt::Limits {
            max_instructions: 64,
            max_source_bytes: 256,
            max_artifact_bytes: 65536,
        },
        observed,
    )
    .unwrap()
}

fn packet(code: &[u8], flags: u64, observed: bool, budget: u64, outcome: Outcome<'_>) -> Value {
    let a = artifact(code, &ExecutionContext::default(), observed);
    execution_case(&a.bytes, &a.entries, &[], flags, 0x1000, budget, outcome)
}

#[test]
fn inherited_rebuilders_and_partial_writers_preserve_unrelated_system_flags() {
    let system = 0x3c7200;
    let mut cases = vec![];
    for (code, input, expected, flags) in [
        (vec![0x04, 1], vec![(0, 0x7f)], vec![(0, 0x80)], 0xc92),
        (vec![0x31, 0xc0], vec![], vec![(0, 0)], 0x446),
        (vec![0x39, 0xc8], vec![(0, 0), (1, 1)], vec![], 0x497),
        (
            vec![0x66, 0xff, 0xc8],
            vec![(0, 0x8000)],
            vec![(0, 0x7fff)],
            0xc17,
        ),
        (vec![0xf6, 0xd8], vec![(0, 0x80)], vec![(0, 0x80)], 0xc83),
        (vec![0x9e], vec![(0, 0)], vec![], 0xc02),
        (vec![0xc0, 0xe0, 0], vec![(0, 0x88)], vec![(0, 0x88)], 0xcd7),
    ] {
        let a = compiled_fixture(0x1000, &code, 0x1000);
        cases.push(execution_case(
            &a.bytes,
            &a.entries,
            &input,
            system | 0xcd7,
            0x1000,
            1,
            (&expected, system | flags, 0x1000 + code.len() as u64, 1, 0),
        ));
    }
    run_cases(cases);
}

#[test]
fn active_entry_guards_and_completed_traps_preserve_budget_stop_and_branch_target_priority() {
    let mut cases = vec![];
    for (code, next) in [(&[0x90][..], 0x1001), (&[0xeb, 5][..], 0x1007)] {
        for budget in [1, 3] {
            let mut p = packet(
                code,
                0x102,
                true,
                budget,
                (&[], 0x102, next, DEBUG_EXCEPTION as u32, budget - 1),
            );
            p["stop"] = json!(format!("{next:x}"));
            p["accesses"] = json!([{ "kind":"debug_step", "args":["1000",format!("{next:x}"),1,"102"],"result":DEBUG_EXCEPTION }]);
            cases.push(p);
        }
    }
    for (observed, flags) in [(false, 0x102), (true, 2)] {
        cases.push(packet(
            &[0x90],
            flags,
            observed,
            3,
            (&[], flags, 0x1000, DISPATCH as u32, 3),
        ));
    }
    for (budget, stop, reason) in [
        (0, None, BUDGET),
        (3, Some("1000"), crate::embedding::layout::STOP),
    ] {
        let mut p = packet(
            &[0x90],
            0x10102,
            true,
            budget,
            (&[], 0x10102, 0x1000, reason as u32, budget),
        );
        if let Some(stop) = stop {
            p["stop"] = json!(stop);
        }
        cases.push(p);
    }
    run_cases(cases);
}

#[test]
fn resume_clears_after_early_pending_check_but_before_ordinary_faults() {
    let mut cases = vec![];
    let mut waiting = packet(
        &[0x9b],
        0x10002,
        true,
        2,
        (&[], 0x10002, 0x1000, X87_EXCEPTION as u32, 2),
    );
    waiting["x87"] = json!({"registers":vec!["0";8], "controlWord":0x37e,"statusWord":0x8081,"tagWord":0xffff,"opcode":0,"instructionPointer":"0","dataPointer":"0"});
    waiting["expected"]["x87"] = waiting["x87"].clone();
    cases.push(waiting);
    let mut failed = packet(
        &[0x8b, 0x03],
        0x10002,
        true,
        2,
        (&[], 2, 0x1000, crate::embedding::layout::DATA as u32, 2),
    );
    failed["accesses"] = json!([
        {"kind":"load","args":["1122334400000003",4],"result":"0"},
        {"kind":"access_failed","args":[],"result":1}
    ]);
    cases.push(failed);
    cases.push(packet(
        &[0x90],
        0x10002,
        true,
        2,
        (&[], 2, 0x1001, DISPATCH as u32, 1),
    ));
    run_cases(cases);
}

#[test]
fn flag_stack_transfers_use_live_full_flags_and_commit_only_successful_results() {
    let mut cases = vec![];
    let a = artifact(&[0x9c], &ExecutionContext::default(), false);
    let mut push = execution_case(
        &a.bytes,
        &a.entries,
        &[(4, 0x4010)],
        0x3c7202,
        0x1000,
        1,
        (&[(4, 0x4008)], 0x3c7202, 0x1001, BUDGET as u32, 0),
    );
    push["accesses"] = json!([
        {"kind":"flags","args":[8,"3c7202","0"],"result":{"reason":0,"value":"3c7202"}},
        {"kind":"store","args":["4008",8,"3c7202"],"result":1}
    ]);
    cases.push(push);
    let a = artifact(&[0x9d, 0x90], &ExecutionContext::default(), false);
    let mut pop = execution_case(
        &a.bytes,
        &a.entries,
        &[(4, 0x4000)],
        2,
        0x1000,
        2,
        (&[(4, 0x4008)], 0x302, 0x1001, DISPATCH as u32, 1),
    );
    pop["accesses"] = json!([
        {"kind":"load","args":["4000",8],"result":"302"},
        {"kind":"access_failed","args":[],"result":0},
        {"kind":"flags","args":[9,"2","302"],"result":{"reason":0,"value":"302"}}
    ]);
    cases.push(pop);
    let mut denied = packet(
        &[0xfa],
        0x202,
        false,
        2,
        (&[], 0x202, 0x1000, PROTECTION as u32, 2),
    );
    denied["accesses"] =
        json!([{ "kind":"flags","args":[2,"202","0"],"result":{"reason":PROTECTION} }]);
    cases.push(denied);
    run_cases(cases);
}

#[test]
fn sampled_tf_and_incoming_shadows_are_independent_of_successful_flag_changes() {
    let mut cases = vec![];
    let a = artifact(&[0x9d, 0x90], &ExecutionContext::default(), true);
    let mut pop = execution_case(
        &a.bytes,
        &a.entries,
        &[(4, 0x4000)],
        0x102,
        0x1000,
        2,
        (&[(4, 0x4008)], 2, 0x1001, DEBUG_EXCEPTION as u32, 1),
    );
    pop["accesses"] = json!([
        {"kind":"load","args":["4000",8],"result":"2"},
        {"kind":"access_failed","args":[],"result":0},
        {"kind":"flags","args":[9,"102","2"],"result":{"reason":0,"value":"2"}},
        {"kind":"debug_step","args":["1000","1001",1,"2"],"result":DEBUG_EXCEPTION}
    ]);
    cases.push(pop);
    for (flags, observed, reason, result_flags, shadow) in [
        (2, false, DISPATCH, 0x202, 1),
        (0x102, true, DEBUG_EXCEPTION, 0x302, 0),
        (0x302, true, DEBUG_EXCEPTION, 0x302, 0),
    ] {
        let mut p = packet(
            &[0xfb, 0x90],
            flags,
            observed,
            2,
            (&[], result_flags, 0x1001, reason as u32, 1),
        );
        p["interruptibility"] = json!(0);
        p["expected"]["interruptibility"] = json!(shadow);
        let mut accesses = vec![
            json!({"kind":"flags","args":[3,format!("{flags:x}"),"0"],"result":{"reason":0,"value":format!("{result_flags:x}")}}),
        ];
        if reason == DEBUG_EXCEPTION {
            accesses.push(json!({"kind":"debug_step","args":["1000","1001",1,format!("{result_flags:x}")],"result":DEBUG_EXCEPTION}));
        }
        p["accesses"] = json!(accesses);
        cases.push(p);
    }
    for flags in [2, 0x102] {
        let reason = if flags == 2 {
            DISPATCH
        } else {
            DEBUG_EXCEPTION
        };
        let mut p = packet(
            &[0x90],
            flags,
            true,
            2,
            (&[], flags, 0x1001, reason as u32, 1),
        );
        p["interruptibility"] = json!(2);
        p["expected"]["interruptibility"] = json!(0);
        if flags != 2 {
            p["accesses"] = json!([{"kind":"debug_step","args":["1000","1001",1,"102"],"result":DEBUG_EXCEPTION}]);
        }
        cases.push(p);
    }
    run_cases(cases);
}

#[test]
fn ss_producers_commit_old_stack_pointer_and_keep_history_even_when_helper_context_is_equal() {
    let descriptor = ProtectionDescriptor {
        kind: ProtectionKind::LoadSegment(Segment::Ss),
        width: Width::W16,
        memory: false,
    }
    .encode();
    let mut cases = vec![];
    for (incoming, helper_reason) in [(0, 0), (2, 0), (2, PROTECTION)] {
        let success = helper_reason == 0;
        let reason = if !success {
            PROTECTION
        } else if incoming == 2 {
            DEBUG_EXCEPTION
        } else {
            DISPATCH
        };
        let mut p = packet(
            &[0x8e, 0xd0],
            0x102,
            true,
            2,
            (
                &[],
                0x102,
                if success { 0x1002 } else { 0x1000 },
                reason as u32,
                if success { 1 } else { 2 },
            ),
        );
        p["interruptibility"] = json!(incoming);
        p["expected"]["interruptibility"] = json!(if !success {
            incoming
        } else if incoming == 2 {
            0
        } else {
            2
        });
        let mut accesses = vec![
            json!({"kind":"protection","args":[descriptor,"0","0",Segment::Ds as u32],"result":{"reason":helper_reason}}),
        ];
        if reason == DEBUG_EXCEPTION {
            accesses.push(json!({"kind":"debug_step","args":["1000","1002",1,"102"],"result":DEBUG_EXCEPTION}));
        }
        p["accesses"] = json!(accesses);
        cases.push(p);
    }
    let mut context = ExecutionContext::default();
    context.set_mode_and_cpl(Mode::Protected, 0);
    let mut cs = context.segment(Segment::Cs);
    cs.default32 = true;
    let mut attr = context.attributes(Segment::Cs);
    attr.long = false;
    context.set_segment(Segment::Cs, 8, cs, attr);
    let mut ss = context.segment(Segment::Ss);
    ss.default32 = false;
    context.set_segment(Segment::Ss, 16, ss, context.attributes(Segment::Ss));
    let a = artifact(&[0x17], &context, false);
    let mut pop = execution_case(
        &a.bytes,
        &a.entries,
        &[(4, 0x112233445566fffc)],
        2,
        0x1000,
        2,
        (&[(4, 0x1122334455660000)], 2, 0x1001, DISPATCH as u32, 1),
    );
    pop["interruptibility"] = json!(0);
    pop["expected"]["interruptibility"] = json!(2);
    pop["accesses"] = json!([
        {"kind":"segmented_load","args":["fffc",4,Segment::Ss as u32],"result":"dead0018"},
        {"kind":"segmented_access_failed","args":[],"result":0},
        {"kind":"protection","args":[descriptor,"0","18",Segment::Ss as u32],"result":{"reason":0}}
    ]);
    cases.push(pop);
    run_cases(cases);
}

#[test]
fn repeated_step_publishes_elements_and_comparison_flags_without_retiring_unfinished_work() {
    let mut cases = vec![];
    let a = artifact(&[0xf3, 0xa4], &ExecutionContext::default(), true);
    for (count, flags, allowance, incoming, reason, completed, result_flags) in [
        (3, 0x102, 3, 2, DEBUG_EXCEPTION, false, 0x102),
        (1, 0x102, 3, 0, DEBUG_EXCEPTION, true, 0x102),
        (
            3,
            0x10002,
            0,
            2,
            crate::embedding::layout::REPEAT_BUDGET,
            false,
            0x10002,
        ),
        (
            3,
            0x10002,
            1,
            2,
            crate::embedding::layout::REPEAT_BUDGET,
            false,
            2,
        ),
        (0, 0x10102, 3, 0, DEBUG_EXCEPTION, true, 0x102),
    ] {
        let work = count != 0 && allowance != 0;
        let next = if completed { 0x1002 } else { 0x1000 };
        let mut expected = vec![];
        if work {
            expected.extend([(1, count - 1), (6, 0x4001), (7, 0x5001)]);
        }
        let mut p = execution_case(
            &a.bytes,
            &a.entries,
            &[(1, count), (6, 0x4000), (7, 0x5000)],
            flags,
            0x1000,
            1,
            (
                &expected,
                result_flags,
                next,
                reason as u32,
                if completed { 0 } else { 1 },
            ),
        );
        p["repeatBudget"] = json!(allowance);
        p["expected"]["repeatRemaining"] = json!((allowance - u64::from(work)).to_string());
        p["interruptibility"] = json!(incoming);
        p["expected"]["interruptibility"] = json!(if reason == DEBUG_EXCEPTION {
            0
        } else {
            incoming
        });
        let mut accesses = vec![];
        if work {
            accesses.extend([
                json!({"kind":"load","args":["4000",1],"result":"7b"}),
                json!({"kind":"access_failed","args":[],"result":0}),
                json!({"kind":"store","args":["5000",1,"7b"],"result":1}),
            ]);
        }
        if reason == DEBUG_EXCEPTION {
            accesses.push(json!({"kind":"debug_step","args":["1000",format!("{next:x}"),u32::from(completed),format!("{result_flags:x}")],"result":DEBUG_EXCEPTION}));
        }
        p["accesses"] = json!(accesses);
        cases.push(p);
    }
    let a = artifact(&[0xf3, 0xa6], &ExecutionContext::default(), true);
    for (source, destination, flags) in [(5, 5, 0x146), (5, 6, 0x197)] {
        let completed = source != destination;
        let next = if completed { 0x1002 } else { 0x1000 };
        let mut p = execution_case(
            &a.bytes,
            &a.entries,
            &[(1, 3), (6, 0x4000), (7, 0x5000)],
            0x102,
            0x1000,
            1,
            (
                &[(1, 2), (6, 0x4001), (7, 0x5001)],
                flags,
                next,
                DEBUG_EXCEPTION as u32,
                if completed { 0 } else { 1 },
            ),
        );
        p["repeatBudget"] = json!(1);
        p["expected"]["repeatRemaining"] = json!("0");
        p["accesses"] = json!([
            {"kind":"load","args":["4000",1],"result":format!("{source:x}")},
            {"kind":"access_failed","args":[],"result":0},
            {"kind":"load","args":["5000",1],"result":format!("{destination:x}")},
            {"kind":"access_failed","args":[],"result":0},
            {"kind":"debug_step","args":["1000",format!("{next:x}"),u32::from(completed),format!("{flags:x}")],"result":DEBUG_EXCEPTION}
        ]);
        cases.push(p);
    }
    run_cases(cases);
}

#[test]
fn observed_retained_entries_publish_only_live_selected_vector_banks() {
    let a = artifact(
        &[0x04, 1, 0x66, 0x0f, 0xef, 0xc0],
        &ExecutionContext::default(),
        true,
    );
    let mut cases = vec![];
    for entry in [0x1000, 0x1002] {
        let initial_flags = 0x3c7302;
        let (input, expected, next, flags) = if entry == 0x1000 {
            (vec![(0, 0x7f)], vec![(0, 0x80)], 0x1002, 0x3c7b92)
        } else {
            (vec![(0, 0x80)], vec![], 0x1006, initial_flags)
        };
        let mut p = execution_case(
            &a.bytes,
            &a.entries,
            &input,
            initial_flags,
            entry,
            1,
            (&expected, flags, next, DEBUG_EXCEPTION as u32, 0),
        );
        let xmm = (0u128..16)
            .map(|i| format!("{:x}", 0x112233445566778899aabbccddeeff00u128 + i))
            .collect::<Vec<_>>();
        p["xmm"] = json!(xmm);
        p["expected"]["xmm"] = p["xmm"].clone();
        if entry == 0x1002 {
            p["expected"]["xmm"][0] = json!("0");
        }
        p["mxcsr"] = json!(0x5f80);
        p["expected"]["mxcsr"] = json!(0x5f80);
        p["accesses"] = json!([{"kind":"debug_step","args":[format!("{entry:x}"),format!("{next:x}"),1,format!("{flags:x}")],"result":DEBUG_EXCEPTION}]);
        cases.push(p);
    }
    run_cases(cases);
}

#[test]
fn observation_is_an_artifact_profile_with_no_default_instruction_helper_or_vector_banks() {
    for observed in [false, true] {
        let a = artifact(
            &[0x04, 1, 0x90, 0xf9],
            &ExecutionContext::default(),
            observed,
        );
        let mut imports = vec![];
        let mut calls = 0;
        for payload in wasmparser::Parser::new(0).parse_all(&a.bytes) {
            match payload.unwrap() {
                wasmparser::Payload::ImportSection(reader) => {
                    for import in reader.into_imports() {
                        imports.push(import.unwrap().name.to_owned());
                    }
                }
                wasmparser::Payload::CodeSectionEntry(body) => {
                    for local in body.get_locals_reader().unwrap() {
                        assert_ne!(local.unwrap().1, wasmparser::ValType::V128);
                    }
                    for operator in body.get_operators_reader().unwrap() {
                        if matches!(operator.unwrap(), wasmparser::Operator::Call { .. }) {
                            calls += 1;
                        }
                    }
                }
                _ => {}
            }
        }
        assert_eq!(imports.iter().any(|name| name == "debug_step"), observed);
        assert!(!imports.iter().any(|name| name == "flags"));
        assert_eq!(imports.iter().any(|name| name == "external_step"), observed);
        assert_eq!(calls, if observed { 6 } else { 0 });
    }
}
