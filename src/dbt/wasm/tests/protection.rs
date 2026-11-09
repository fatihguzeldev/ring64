use super::*;
use crate::x86::instruction::{Location, ProtectionInstruction, ProtectionKind};

#[test]
fn protection_helper_is_imported_only_for_selected_instructions_without_xmm_locals() {
    for selected in [false, true] {
        let instruction = Instruction {
            pc: 0x1000,
            next_pc: 0x1003,
            operation: if selected {
                Operation::Protection(ProtectionInstruction {
                    kind: ProtectionKind::Lar,
                    operand: Location::Register(RegisterView::low(9)),
                    register: 8,
                    width: Width::W64,
                })
            } else {
                Operation::Nop
            },
        };
        let bytes = emit(&unit(vec![instruction]));
        let mut names = vec![];
        for payload in wasmparser::Parser::new(0).parse_all(&bytes) {
            match payload.unwrap() {
                wasmparser::Payload::ImportSection(reader) => {
                    for import in reader.into_imports() {
                        names.push(import.unwrap().name.to_owned());
                    }
                }
                wasmparser::Payload::CodeSectionEntry(body) => {
                    for local in body.get_locals_reader().unwrap() {
                        assert_ne!(local.unwrap().1, wasmparser::ValType::V128);
                    }
                }
                _ => {}
            }
        }
        assert_eq!(names.iter().any(|n| n == "protection"), selected);
        wasmparser::Validator::new().validate_all(&bytes).unwrap();
    }
}

use crate::embedding::layout::{BUDGET, DATA, DISPATCH, STOP};

fn packet(
    code: &[u8],
    input: &[(usize, u64)],
    flags: u64,
    entry: u64,
    budget: u64,
    outcome: Outcome<'_>,
) -> Value {
    let artifact = compiled_fixture(0x1000, code, 0x1000);
    let mut p = execution_case(
        &artifact.bytes,
        &artifact.entries,
        input,
        flags,
        entry,
        budget,
        outcome,
    );
    p["repeatBudget"] = json!(31);
    p["expected"]["repeatRemaining"] = json!("31");
    p
}

#[test]
fn protection_queries_use_live_sources_preserve_failed_destinations_and_only_change_zf() {
    let code = [
        0x49, 0xb8, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11, 0x31, 0xc0, 0x66, 0x45, 0x0f,
        0x02, 0xc0,
    ];
    let mut cases = vec![];
    for success in [false, true] {
        let value = if success {
            0x1122334455669300
        } else {
            0x1122334455667788
        };
        let mut p = packet(
            &code,
            &[],
            0xcd7,
            0x1000,
            3,
            (
                &[(0, 0), (8, value)],
                if success { 0x446 } else { 0x406 },
                0x1011,
                BUDGET as u32,
                0,
            ),
        );
        p["accesses"] = json!([{"kind":"protection","args":[24,"0","7788",2],"result":{"reason":0,"value":"9300","control":if success {3} else {0}}}]);
        cases.push(p);
    }
    let mut middle = packet(
        &code,
        &[(8, 0xfedcba9876543210)],
        0xcd7,
        0x100c,
        1,
        (&[(8, 0xfedcba9876549300)], 0xcd7, 0x1011, BUDGET as u32, 0),
    );
    middle["accesses"] = json!([{"kind":"protection","args":[24,"0","3210",2],"result":{"reason":0,"value":"9300","control":3}}]);
    cases.push(middle);
    for width in [Width::W32, Width::W64] {
        let mut u = unit(vec![Instruction {
            pc: 0x1000,
            next_pc: 0x1003,
            operation: Operation::Protection(ProtectionInstruction {
                kind: ProtectionKind::Lsl,
                operand: Location::Register(RegisterView::low(8)),
                register: 8,
                width,
            }),
        }]);
        for nonlong in [false, true] {
            if nonlong && width == Width::W64 {
                continue;
            }
            if nonlong {
                u.instructions[0].operation = Operation::Protection(ProtectionInstruction {
                    kind: ProtectionKind::Lsl,
                    operand: Location::Register(RegisterView::low(0)),
                    register: 0,
                    width,
                });
                let mut segments = serde_json::Map::new();
                for name in ["cs", "ss", "ds", "es", "fs", "gs"] {
                    segments.insert(name.into(),json!({"base":"0x0","limit":u32::MAX,"default32":true,"usable":true,"type":if name=="cs" {"readable-code"} else {"read-write"}}));
                }
                u.context = crate::x86::context::ExecutionContext::from_json(
                    &json!({"mode":"protected","segments":segments}),
                )
                .unwrap();
            }
            for success in [false, true] {
                let old = 0xfedcba9876543210;
                let bank = if nonlong { 0 } else { 8 };
                let result = if !success {
                    old
                } else if nonlong {
                    0xfedcba9889abcdef
                } else {
                    0x89abcdef
                };
                let mut p = execution_case(
                    &emit(&u),
                    &[0x1000],
                    &[(bank, old)],
                    0xcd7,
                    0x1000,
                    1,
                    (
                        &[(bank, result)],
                        if success { 0xcd7 } else { 0xc97 },
                        0x1003,
                        BUDGET as u32,
                        0,
                    ),
                );
                p["accesses"] = json!([{"kind":"protection","args":[25+if width==Width::W64 {64} else {32},"0","3210",2],"result":{"reason":0,"value":"89abcdef","control":if success {3} else {0}}}]);
                cases.push(p);
            }
        }
    }
    run_cases(cases);
}

#[test]
fn protection_lss_old_live_address_and_partial_destination_commit_once_before_redispatch() {
    let code = [
        0x48, 0xbc, 0x10, 0x32, 0x54, 0x76, 0x34, 0x12, 0, 0, 0x66, 0x0f, 0xb2, 0x64, 0x24, 0x04,
        0x90,
    ];
    let mut cases = vec![];
    for (status, budget, stop, pc, reason, remaining) in [
        (DATA, 3, None, 0x100a, DATA, 2),
        (2, 2, Some(0x1010), 0x1010, BUDGET, 0),
        (2, 3, Some(0x1010), 0x1010, STOP, 1),
        (2, 3, None, 0x1010, DISPATCH, 1),
    ] {
        let mut p = packet(
            &code,
            &[],
            0xcd7,
            0x1000,
            budget,
            (
                &[(
                    4,
                    if status == DATA {
                        0x123476543210
                    } else {
                        0x12347654beef
                    },
                )],
                0xcd7,
                pc,
                reason as u32,
                remaining,
            ),
        );
        if let Some(stop) = stop {
            p["stop"] = json!(format!("{stop:x}"));
        }
        p["accesses"] = json!([{"kind":"protection","args":[147,"123476543214","0",1],"result":{"reason":status,"value":"beef","control":1}}]);
        cases.push(p);
    }
    run_cases(cases);
}

#[test]
fn protection_stores_and_context_exits_keep_budget_stop_and_current_gates_precise() {
    let code = [0xb8, 0x34, 0x12, 0, 0, 0x0f, 0x01, 0x03, 0x90];
    let mut cases = vec![];
    for (status, budget, stop, pc, reason, remaining) in [
        (DATA, 3, None, 0x1005, DATA, 2),
        (2, 2, Some(0x1008), 0x1008, BUDGET, 0),
        (2, 3, Some(0x1008), 0x1008, STOP, 1),
        (2, 3, None, 0x1008, DISPATCH, 1),
    ] {
        let mut p = packet(
            &code,
            &[],
            0xcd7,
            0x1000,
            budget,
            (&[(0, 0x1234)], 0xcd7, pc, reason as u32, remaining),
        );
        if let Some(stop) = stop {
            p["stop"] = json!(format!("{stop:x}"));
        }
        p["accesses"] = json!([{"kind":"protection","args":[192,"1122334400000003","0",2],"result":{"reason":status}}]);
        cases.push(p);
    }
    cases.push(packet(
        &code,
        &[],
        0xcd7,
        0x1005,
        0,
        (&[], 0xcd7, 0x1005, BUDGET as u32, 0),
    ));
    let mut stopped = packet(
        &code,
        &[],
        0xcd7,
        0x1005,
        2,
        (&[], 0xcd7, 0x1005, STOP as u32, 2),
    );
    stopped["stop"] = json!("1005");
    cases.push(stopped);
    let skipped = [0x74, 0x03, 0x0f, 0x02, 0xc0, 0x90];
    cases.push(packet(
        &skipped,
        &[],
        0xcd7,
        0x1000,
        2,
        (&[], 0xcd7, 0x1006, BUDGET as u32, 0),
    ));
    cases.push(packet(
        &skipped,
        &[],
        0xcd7,
        0x1005,
        1,
        (&[], 0xcd7, 0x1006, BUDGET as u32, 0),
    ));
    run_cases(cases);
}

#[test]
fn protection_faults_and_completed_context_exits_preserve_dirty_xmm_predecessors() {
    let code = [0xf3, 0x45, 0x0f, 0x6f, 0xc1, 0x0f, 0x00, 0xd0];
    let before = std::array::from_fn::<_, 16, _>(|bank| {
        0x123456789abcdef0_1122334400000000u128 + bank as u128
    });
    let mut after = before;
    after[8] = before[9];
    let mut cases = vec![];
    for status in [DATA, 2] {
        let mut p = packet(
            &code,
            &[(0, 0x123456789abcdef0)],
            0xcd7,
            0x1000,
            3,
            (
                &[],
                0xcd7,
                if status == 2 { 0x1008 } else { 0x1005 },
                if status == 2 { DISPATCH } else { DATA } as u32,
                if status == 2 { 1 } else { 2 },
            ),
        );
        p["xmm"] = json!(before.map(|v| format!("{v:x}")));
        p["expected"]["xmm"] = json!(after.map(|v| format!("{v:x}")));
        p["accesses"] =
            json!([{"kind":"protection","args":[5,"0","def0",2],"result":{"reason":status}}]);
        cases.push(p);
    }
    run_cases(cases);
}
