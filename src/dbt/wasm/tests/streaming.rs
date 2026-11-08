use super::*;
use crate::embedding::layout::{BUDGET, DATA, DISPATCH, STOP, X87_EXCEPTION};

fn packet(code: &[u8], entry: u64, budget: u64, outcome: Outcome<'_>) -> Value {
    let artifact = compiled_fixture(0x1000, code, 0x1000);
    let mut packet = execution_case(
        &artifact.bytes,
        &artifact.entries,
        &[],
        0xcd7,
        entry,
        budget,
        outcome,
    );
    packet["repeatBudget"] = json!(41);
    packet["expected"]["repeatRemaining"] = json!("41");
    packet
}

fn xmm(mut packet: Value, before: [u128; 16], after: [u128; 16]) -> Value {
    packet["xmm"] = json!(before.map(|v| format!("{v:x}")));
    packet["expected"]["xmm"] = json!(after.map(|v| format!("{v:x}")));
    packet
}

#[test]
fn streaming_helpers_are_selected_only_by_actual_memory_consumers() {
    for (code, masked, flush) in [
        (&[0x90][..], false, false),
        (&[0xf3, 0x41, 0x90], false, false),
        (&[0x0f, 0x18, 0x03], false, false),
        (&[0x0f, 0xae, 0xef], false, false),
        (&[0x0f, 0xae, 0x3b], false, true),
        (&[0x0f, 0xf7, 0xc1], true, false),
        (&[0x66, 0x0f, 0xf7, 0xc1], true, false),
    ] {
        let artifact = compiled_fixture(0x1000, code, 0x1000);
        let mut imports = vec![];
        for payload in wasmparser::Parser::new(0).parse_all(&artifact.bytes) {
            match payload.unwrap() {
                wasmparser::Payload::ImportSection(reader) => {
                    for import in reader.into_imports() {
                        imports.push(import.unwrap().name.to_owned());
                    }
                }
                wasmparser::Payload::CodeSectionEntry(body) if code.first() != Some(&0x66) => {
                    for local in body.get_locals_reader().unwrap() {
                        assert_ne!(
                            local.unwrap().1,
                            wasmparser::ValType::V128,
                            "no unused XMM locals"
                        );
                    }
                }
                _ => {}
            }
        }
        assert_eq!(imports.iter().any(|v| v == "masked_store"), masked);
        assert_eq!(imports.iter().any(|v| v == "clflush"), flush);
        assert!(!imports.iter().any(|v| v == "mmx"));
        wasmparser::Validator::new()
            .validate_all(&artifact.bytes)
            .unwrap();
    }
}

#[test]
fn streaming_mmx_sources_observe_preceding_direct_writer_and_zero_high_mask_half() {
    let code = [0x48, 0x0f, 0x6e, 0xf8, 0x4f, 0x0f, 0xf7, 0xff];
    let artifact = compiled_fixture(0x1000, &code, 0x1000);
    let mut p = execution_case(
        &artifact.bytes,
        &artifact.entries,
        &[(0, 0x8001007fff008000)],
        0xcd7,
        0x1000,
        2,
        (&[], 0xcd7, 0x1008, BUDGET as u32, 0),
    );
    let state = json!({"registers":["11223344556677889900","0","0","0","0","0","0","12340000000000000000"],"controlWord":0x37f,"statusWord":0x2940,"tagWord":0x1234,"opcode":0x765,"instructionPointer":"9876543210","dataPointer":"abcdef1234"});
    p["x87"] = state.clone();
    p["expected"]["x87"] = state;
    p["expected"]["x87"]["registers"][7] = json!("ffff8001007fff008000");
    p["expected"]["x87"]["statusWord"] = json!(0x140);
    p["expected"]["x87"]["tagWord"] = json!(0);
    p["accesses"] = json!([{"kind":"masked_store","args":["1122334400000007",8,"8001007fff008000",0x8a,2],"result":0}]);
    run_cases(vec![p]);
}

#[test]
fn streaming_masked_sources_use_dirty_selected_xmm_and_current_middle_inputs() {
    let code = [0xf3, 0x45, 0x0f, 0x6f, 0xc2, 0x66, 0x45, 0x0f, 0xf7, 0xc1];
    let mut before = std::array::from_fn(|i| 0x1122334400000000u128 + i as u128);
    before[9] = 0x8001007fff008000_8001007fff008000;
    before[10] = 0xfedcba9876543210_0123456789abcdef;
    let mut after = before;
    after[8] = before[10];
    let mut whole = xmm(
        packet(&code, 0x1000, 2, (&[], 0xcd7, 0x100a, BUDGET as u32, 0)),
        before,
        after,
    );
    whole["accesses"] = json!([{"kind":"masked_store","args":["1122334400000007",16,"fedcba98765432100123456789abcdef",0x8a8a,2],"result":0}]);
    let mut middle = xmm(
        packet(&code, 0x1005, 1, (&[], 0xcd7, 0x100a, BUDGET as u32, 0)),
        before,
        before,
    );
    middle["accesses"] = json!([{"kind":"masked_store","args":["1122334400000007",16,"1122334400000008",0x8a8a,2],"result":0}]);
    let same = [0x66, 0x45, 0x0f, 0xf7, 0xff];
    before[15] = 0x8080808080808080_8080808080808080;
    let mut alias = xmm(
        packet(&same, 0x1000, 1, (&[], 0xcd7, 0x1005, BUDGET as u32, 0)),
        before,
        before,
    );
    alias["accesses"] = json!([{"kind":"masked_store","args":["1122334400000007",16,"80808080808080808080808080808080",65535,2],"result":0}]);
    run_cases(vec![whole, middle, alias]);
}

#[test]
fn streaming_helper_failures_and_smc_preserve_precise_retirement_priority() {
    let code = [0xb8, 0x34, 0x12, 0, 0, 0x0f, 0xf7, 0xc1, 0x90];
    let mut cases = vec![];
    for (status, budget, stop, pc, reason, remaining) in [
        (DATA, 3, None, 0x1005, DATA, 2),
        (X87_EXCEPTION, 3, None, 0x1005, X87_EXCEPTION, 2),
        (2, 2, Some(0x1008), 0x1008, BUDGET, 0),
        (2, 3, Some(0x1008), 0x1008, STOP, 1),
        (2, 3, None, 0x1008, DISPATCH, 1),
    ] {
        let mut p = packet(
            &code,
            0x1000,
            budget,
            (&[(0, 0x1234)], 0xcd7, pc, reason as u32, remaining),
        );
        if let Some(stop) = stop {
            p["stop"] = json!(format!("{stop:x}"));
        }
        p["accesses"] =
            json!([{"kind":"masked_store","args":["1122334400000007",8,"0",0,2],"result":status}]);
        cases.push(p);
    }
    let flush = [0xb8, 0x34, 0x12, 0, 0, 0x0f, 0xae, 0x3b];
    for status in [0, DATA] {
        let mut p = packet(
            &flush,
            0x1000,
            2,
            (
                &[(0, 0x1234)],
                0xcd7,
                if status == 0 { 0x1008 } else { 0x1005 },
                if status == 0 { BUDGET } else { status } as u32,
                if status == 0 { 0 } else { 1 },
            ),
        );
        p["accesses"] = json!([{"kind":"clflush","args":["1122334400000003",2],"result":status}]);
        cases.push(p);
    }
    run_cases(cases);
}

#[test]
fn streaming_hints_and_fences_never_probe_data_or_consume_repeat_work() {
    let code = [
        0xf3, 0x41, 0x90, 0x0f, 0xae, 0xef, 0x0f, 0xae, 0xf7, 0x0f, 0xae, 0xff, 0x66, 0xf2, 0x0f,
        0x18, 0x84, 0x8b, 0xff, 0xff, 0xff, 0x7f,
    ];
    run_cases(vec![packet(
        &code,
        0x1000,
        5,
        (&[], 0xcd7, 0x1016, BUDGET as u32, 0),
    )]);
}
