use super::*;
use crate::x86::instruction::{FarInstruction, FarKind, FarOperand};

#[test]
fn far_helpers_are_conditional_and_keep_the_five_argument_entry_without_xmm_banks() {
    for selected in [false, true] {
        let bytes = emit(&unit(vec![Instruction {
            pc: 0x1000,
            next_pc: 0x1002,
            operation: if selected {
                Operation::Far(FarInstruction {
                    kind: FarKind::Return,
                    width: Width::W32,
                    operand: FarOperand::Return { cleanup: 0 },
                })
            } else {
                Operation::Nop
            },
        }]));
        let mut imports = vec![];
        for payload in wasmparser::Parser::new(0).parse_all(&bytes) {
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
                }
                _ => {}
            }
        }
        assert_eq!(imports.iter().any(|name| name == "far_control"), selected);
        wasmparser::Validator::new().validate_all(&bytes).unwrap();
    }
}

use crate::embedding::layout::{
    BUDGET, DATA, DISPATCH, PROTECTION, SEGMENT, STOP, SYSTEM_MEMORY, UNSUPPORTED,
};

fn packet(
    code: &[u8],
    input: &[(usize, u64)],
    flags: u64,
    entry: u64,
    budget: u64,
    outcome: Outcome<'_>,
) -> Value {
    let a = compiled_fixture(0x1000, code, 0x1000);
    let mut p = execution_case(&a.bytes, &a.entries, input, flags, entry, budget, outcome);
    p["repeatBudget"] = json!(37);
    p["expected"]["repeatRemaining"] = json!("37");
    p
}

#[test]
fn far_captures_live_sp_and_address_then_publishes_target_and_complete_raw_pointer_once() {
    let code = [
        0x48, 0xbc, 0xb0, 0x9a, 0x78, 0x56, 0x34, 0x12, 0, 0, 0x48, 0xff, 0x5c, 0x24, 0x08, 0x90,
    ];
    let mut cases = vec![];
    for (status, budget, stop, pc, sp, reason, left) in [
        (0, 2, Some(0x5000), 0x5000, 0x123456789aa0, BUDGET, 0),
        (0, 3, Some(0x5000), 0x5000, 0x123456789aa0, STOP, 1),
        (0, 3, None, 0x5000, 0x123456789aa0, DISPATCH, 1),
        (DATA, 3, None, 0x100a, 0x123456789ab0, DATA, 2),
        (SEGMENT, 3, None, 0x100a, 0x123456789ab0, SEGMENT, 2),
        (PROTECTION, 3, None, 0x100a, 0x123456789ab0, PROTECTION, 2),
        (
            SYSTEM_MEMORY,
            3,
            None,
            0x100a,
            0x123456789ab0,
            SYSTEM_MEMORY,
            2,
        ),
        (UNSUPPORTED, 3, None, 0x100a, 0x123456789ab0, UNSUPPORTED, 2),
    ] {
        let mut p = packet(
            &code,
            &[],
            0xcd7,
            0x1000,
            budget,
            (&[(4, sp)], 0xcd7, pc, reason as u32, left),
        );
        if let Some(stop) = stop {
            p["stop"] = json!(format!("{stop:x}"));
        }
        p["accesses"] = json!([{"kind":"far_control","args":[24,"123456789ab8",0,"123456789ab0","100f",1],"result":{"reason":status,"pc":"5000","sp":"123456789aa0"}}]);
        cases.push(p);
    }
    run_cases(cases);
}

#[test]
fn far_memory_operand_keeps_selected_offset_segment_and_full_completed_next_pc() {
    let code = [0x67, 0x64, 0x48, 0xff, 0x2d, 0xfc, 0xff, 0xff, 0xff];
    let mut p = packet(
        &code,
        &[(4, 0x4010)],
        0xcd7,
        0x1000,
        1,
        (&[], 0xcd7, 0x6000, BUDGET as u32, 0),
    );
    p["accesses"] = json!([{"kind":"far_control","args":[25,"1005",0,"4010","1009",4],"result":{"reason":0,"pc":"6000","sp":"4010"}}]);
    run_cases(vec![p]);
}

#[test]
fn far_immediate_and_return_arguments_have_independent_selector_and_cleanup_fields() {
    let mut u = unit(vec![Instruction {
        pc: 0x1000,
        next_pc: 0x1005,
        operation: Operation::Far(FarInstruction {
            kind: FarKind::Jump,
            width: Width::W16,
            operand: FarOperand::Immediate {
                selector: 0x9abc,
                offset: 0x5678,
            },
        }),
    }]);
    let mut c = u.context.to_json();
    c["mode"] = json!("protected");
    c["segments"]["cs"]["long"] = json!(false);
    u.context = crate::x86::context::ExecutionContext::from_json(&c).unwrap();
    let mut immediate = execution_case(
        &emit(&u),
        &[0x1000],
        &[(4, 0xfedcba9876543210)],
        0xcd7,
        0x1000,
        1,
        (&[], 0xcd7, 0x5678, BUDGET as u32, 0),
    );
    immediate["accesses"] = json!([{"kind":"far_control","args":[1,"5678",0x9abc,"fedcba9876543210","1005",2],"result":{"reason":0,"pc":"5678","sp":"fedcba9876543210"}}]);
    let mut cases = vec![immediate];
    for (code, descriptor, cleanup, next) in [
        (&[0xca, 0xff, 0xff][..], 6, "ffff", "1003"),
        (&[0x66, 0xcb][..], 2, "0", "1002"),
        (&[0x48, 0xca, 0x10, 0][..], 10, "10", "1004"),
    ] {
        let mut p = packet(
            code,
            &[(4, 0x4010)],
            0xcd7,
            0x1000,
            1,
            (&[(4, 0x89ab0001)], 0xcd7, 0x7000, BUDGET as u32, 0),
        );
        p["accesses"] = json!([{"kind":"far_control","args":[descriptor,cleanup,0,"4010",next,1],"result":{"reason":0,"pc":"7000","sp":"89ab0001"}}]);
        cases.push(p);
    }
    run_cases(cases);
}

#[test]
fn far_entry_gates_skipped_paths_and_retained_entries_never_execute_old_context_successors() {
    let code = [0x74, 0x01, 0xcb, 0x90];
    let mut cases = vec![];
    cases.push(packet(
        &code,
        &[],
        0xcd7,
        0x1000,
        2,
        (&[], 0xcd7, 0x1004, BUDGET as u32, 0),
    ));
    cases.push(packet(
        &code,
        &[],
        0xcd7,
        0x1003,
        1,
        (&[], 0xcd7, 0x1004, BUDGET as u32, 0),
    ));
    cases.push(packet(
        &code,
        &[],
        0xcd7,
        0x1002,
        0,
        (&[], 0xcd7, 0x1002, BUDGET as u32, 0),
    ));
    let mut stopped = packet(
        &code,
        &[],
        0xcd7,
        0x1002,
        2,
        (&[], 0xcd7, 0x1002, STOP as u32, 2),
    );
    stopped["stop"] = json!("1002");
    cases.push(stopped);
    for (budget, target, reason, left) in [(1, 0x5000, BUDGET, 0), (2, 0x1003, DISPATCH, 1)] {
        let mut p = packet(
            &code,
            &[(4, 0x4040)],
            0xc97,
            0x1002,
            budget,
            (&[(4, 0x4050)], 0xc97, target, reason as u32, left),
        );
        p["accesses"] = json!([{"kind":"far_control","args":[6,"0",0,"4040","1003",1],"result":{"reason":0,"pc":format!("{target:x}"),"sp":"4050"}}]);
        cases.push(p);
    }
    run_cases(cases);
}

#[test]
fn far_failures_and_success_keep_live_flags_dirty_xmm_and_pending_numeric_state() {
    let code = [0x31, 0xc0, 0xf3, 0x45, 0x0f, 0x6f, 0xc1, 0xcb];
    let before =
        std::array::from_fn::<_, 16, _>(|i| 0xfedcba9876543210_1122334400000000u128 + i as u128);
    let mut after = before;
    after[8] = before[9];
    let x87 = json!({"registers":["123456789abcdef01234","0","0","0","0","0","0","fedcba98765432101234"],"controlWord":0x37e,"statusWord":0x8081,"tagWord":0x1234,"opcode":0x765,"instructionPointer":"12345678","dataPointer":"87654321"});
    let mut cases = vec![];
    for (status, budget, pc, reason, left) in [
        (None, 2, 0x1007, BUDGET, 0),
        (Some(PROTECTION), 3, 0x1007, PROTECTION, 1),
        (Some(0), 3, 0x7000, BUDGET, 0),
    ] {
        let mut p = packet(
            &code,
            &[(4, 0x4000)],
            0xcd7,
            0x1000,
            budget,
            (
                &[(0, 0), (4, if status == Some(0) { 0x9000 } else { 0x4000 })],
                0x446,
                pc,
                reason as u32,
                left,
            ),
        );
        p["xmm"] = json!(before.map(|v| format!("{v:x}")));
        p["expected"]["xmm"] = json!(after.map(|v| format!("{v:x}")));
        p["x87"] = x87.clone();
        p["expected"]["x87"] = x87.clone();
        p["mxcsr"] = json!(0x5fa0);
        p["expected"]["mxcsr"] = json!(0x5fa0);
        if let Some(status) = status {
            p["accesses"] = json!([{"kind":"far_control","args":[6,"0",0,"4000","1008",1],"result":{"reason":status,"pc":"7000","sp":"9000"}}]);
        }
        cases.push(p);
    }
    run_cases(cases);
}
