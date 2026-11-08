use super::*;
use crate::embedding::layout::{BUDGET, DISPATCH, GENERAL_PROTECTION, STOP};
use crate::x86::mmx::{Kind as MmxKind, Op as Mmx};
use crate::x86::numeric_images::{Format, ImageOp, Kind};

fn raw() -> [u128; 16] {
    std::array::from_fn(|i| 0x112233445566778899aabbcc00000000 + i as u128)
}

fn packet(code: &[u8], entry: u64, budget: u64, outcome: Outcome<'_>) -> Value {
    let artifact = compiled_fixture(0x1000, code, 0x1000);
    execution_case(
        &artifact.bytes,
        &artifact.entries,
        &[],
        0xcd7,
        entry,
        budget,
        outcome,
    )
}

fn xmm(mut packet: Value, before: [u128; 16], after: [u128; 16]) -> Value {
    packet["xmm"] = json!(before.map(|v| format!("{v:x}")));
    packet["expected"]["xmm"] = json!(after.map(|v| format!("{v:x}")));
    packet["repeatBudget"] = json!(23);
    packet["expected"]["repeatRemaining"] = json!("23");
    packet
}

fn image(kind: Kind) -> u32 {
    ImageOp {
        kind,
        format: Format::Fx64,
    }
    .encode()
}

#[test]
fn numeric_imports_and_xmm_locals_are_selected_by_actual_consumers() {
    for (code, mmx, image) in [
        (&[0x90][..], false, false),
        (&[0x0f, 0x77], false, false),
        (&[0x0f, 0xae, 0x03], false, true),
        (&[0x0f, 0x77, 0x0f, 0xae, 0x03], false, true),
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
                wasmparser::Payload::CodeSectionEntry(body) => {
                    for local in body.get_locals_reader().unwrap() {
                        assert_ne!(local.unwrap().1, wasmparser::ValType::V128);
                    }
                }
                _ => {}
            }
        }
        assert_eq!(imports.iter().any(|name| name == "mmx"), mmx);
        assert_eq!(imports.iter().any(|name| name == "numeric_image"), image);
        wasmparser::Validator::new()
            .validate_all(&artifact.bytes)
            .unwrap();
    }
}

#[test]
fn fx_save_sees_dirty_simd_and_restore_replaces_local_and_epilogue_values() {
    let mut zero = raw();
    zero[0] = 0;
    let mut save = xmm(
        packet(
            &[0x66, 0x0f, 0xef, 0xc0, 0x0f, 0xae, 0x03],
            0x1000,
            2,
            (&[], 0xcd7, 0x1007, BUDGET as u32, 0),
        ),
        raw(),
        zero,
    );
    save["accesses"] = json!([{"kind":"numeric_image","args":[image(Kind::SaveFx),"1122334400000003",2],"result":{"reason":0,"xmmBefore":{"0":"0"}}}]);

    let code = [
        0x0f, 0xae, 0x0b, 0xeb, 4, 0x66, 0x0f, 0xef, 0xc0, 0x66, 0x0f, 0x6f, 0xc8,
    ];
    let restored =
        std::array::from_fn::<_, 16, _>(|i| 0x98765432100000000000000000000000 + i as u128);
    let mut after = restored;
    after[1] = restored[0];
    let mut restore = xmm(
        packet(&code, 0x1000, 3, (&[], 0xcd7, 0x100d, BUDGET as u32, 0)),
        raw(),
        after,
    );
    let fields: serde_json::Map<String, Value> = restored
        .iter()
        .enumerate()
        .map(|(i, v)| (i.to_string(), json!(format!("{v:x}"))))
        .collect();
    restore["accesses"] = json!([{"kind":"numeric_image","args":[image(Kind::RestoreFx),"1122334400000003",2],"result":{"reason":0,"xmm":fields}}]);

    let mut imported = raw();
    imported[0] = 0xabcdef;
    let mut middle_after = imported;
    middle_after[1] = imported[0];
    let middle = xmm(
        packet(&code, 0x1009, 1, (&[], 0xcd7, 0x100d, BUDGET as u32, 0)),
        imported,
        middle_after,
    );
    run_cases(vec![save, restore, middle]);
}

#[test]
fn skipped_or_failed_restore_preserves_live_simd_predecessors() {
    let mut after = raw();
    after[0] = 0;
    after[1] = 0;
    let skipped = xmm(
        packet(
            &[
                0x66, 0x0f, 0xef, 0xc0, 0xeb, 3, 0x0f, 0xae, 0x0b, 0x66, 0x0f, 0x6f, 0xc8,
            ],
            0x1000,
            3,
            (&[], 0xcd7, 0x100d, BUDGET as u32, 0),
        ),
        raw(),
        after,
    );
    after[1] = raw()[1];
    let mut failed = xmm(
        packet(
            &[
                0x66, 0x0f, 0xef, 0xc0, 0x0f, 0xae, 0x0b, 0x66, 0x0f, 0x6f, 0xc8,
            ],
            0x1000,
            3,
            (&[], 0xcd7, 0x1004, GENERAL_PROTECTION as u32, 2),
        ),
        raw(),
        after,
    );
    failed["accesses"] = json!([{"kind":"numeric_image","args":[image(Kind::RestoreFx),"1122334400000003",2],"result":{"reason":GENERAL_PROTECTION}}]);
    run_cases(vec![skipped, failed]);
}

#[test]
fn mmx_bridges_capture_live_gpr_and_selected_xmm_and_reload_destinations() {
    let code = [
        0x49, 0xb8, 0xef, 0xcd, 0xab, 0x89, 0x67, 0x45, 0x23, 0x01, 0x49, 0x0f, 0x6e, 0xc0, 0x49,
        0x0f, 0x7e, 0xc0,
    ];
    let gp = packet(
        &code,
        0x1000,
        3,
        (&[(8, 0x123456789abcdef)], 0xcd7, 0x1012, BUDGET as u32, 0),
    );
    let mut zero = raw();
    zero[1] = 0;
    let source = xmm(
        packet(
            &[0x66, 0x0f, 0xef, 0xc9, 0xf2, 0x0f, 0xd6, 0xc1],
            0x1000,
            2,
            (&[], 0xcd7, 0x1008, BUDGET as u32, 0),
        ),
        raw(),
        zero,
    );
    let mut result = raw();
    result[0] = (raw()[1] & !(u64::MAX as u128)) | 0x12345678;
    let mut destination = xmm(
        packet(
            &[0x66, 0x0f, 0x6f, 0xc1, 0x0f, 0x2a, 0xc2],
            0x1000,
            2,
            (&[], 0xcd7, 0x1007, BUDGET as u32, 0),
        ),
        raw(),
        result,
    );
    destination["accesses"] = json!([{"kind":"mmx","args":[Mmx{kind:MmxKind::PiToPs,src:2,..Mmx::default()}.encode(),"0",2],"result":{"reason":0,"xmmBefore":{"0":format!("{:x}",raw()[1])},"xmm":{"0":format!("{:x}",result[0])}}}]);
    run_cases(vec![gp, source, destination]);
}

#[test]
fn numeric_state_stores_retire_before_smc_exit_with_budget_stop_priority() {
    let mut cases = vec![];
    for (budget, reason, remaining, stop) in [
        (1, BUDGET, 0, false),
        (2, STOP, 1, true),
        (2, DISPATCH, 1, false),
    ] {
        for code in [&[0x0f, 0xae, 0x03, 0x90][..], &[0x0f, 0x7f, 0x03, 0x90]] {
            let mut p = packet(
                code,
                0x1000,
                budget,
                (&[], 0xcd7, 0x1003, reason as u32, remaining),
            );
            p["accesses"] = if code[1] == 0xae {
                json!([{"kind":"numeric_image","args":[image(Kind::SaveFx),"1122334400000003",2],"result":{"reason":2}}])
            } else {
                json!([{"kind":"store","args":["1122334400000003",8,"0"],"result":2}])
            };
            if stop {
                p["stop"] = json!("1003");
            }
            cases.push(p);
        }
    }
    run_cases(cases);
}

#[test]
fn numeric_image_and_mmx_types_coexist_with_all_prior_helper_signatures() {
    let code = [
        0x48, 0x83, 0x03, 1, 0x48, 0xf7, 0xe5, 0x48, 0xf7, 0xf5, 0xf3, 0x0f, 0x58, 0xc1, 0x0f,
        0xae, 0x13, 0x9b, 0x0f, 0x77, 0x0f, 0xae, 0x03, 0xc3,
    ];
    let artifact = compiled_fixture(0x1000, &code, 0x1000);
    wasmparser::Validator::new()
        .validate_all(&artifact.bytes)
        .unwrap();
}
