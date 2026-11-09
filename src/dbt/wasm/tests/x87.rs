use super::*;
use crate::embedding::layout::{BUDGET, DISPATCH, STOP};
use crate::x86::context::Segment;
use crate::x86::x87::{Format, Kind, Op as Numeric};

const X87_EXCEPTION: i32 = 15;

fn helper(kind: Kind, format: Format, encoding: u16) -> i32 {
    Numeric {
        kind,
        format,
        encoding,
        ..Numeric::default()
    }
    .encode() as i32
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

#[test]
fn x87_helpers_are_imported_only_for_units_that_execute_x87() {
    for (code, expected) in [(&[0x90][..], false), (&[0x9b][..], true)] {
        let artifact = compiled_fixture(0x1000, code, 0x1000);
        let imports = wasmparser::Parser::new(0)
            .parse_all(&artifact.bytes)
            .filter_map(|payload| match payload.unwrap() {
                wasmparser::Payload::ImportSection(reader) => Some(reader),
                _ => None,
            })
            .flat_map(|reader| reader.into_imports())
            .filter(|import| import.as_ref().unwrap().name == "x87")
            .count();
        assert_eq!(imports, usize::from(expected));
    }
}

#[test]
fn x87_generated_boundaries_capture_live_operands_and_reload_only_written_projections() {
    let mut cases = vec![];
    // Both helpers see live EAX/FLAGS after unpublished GP predecessors.
    // Their unrelated canonical writes must be overwritten by the right owner.
    for (suffix, op, input_flags, output, flags, registers) in [
        (
            &[0xdf, 0xe0][..],
            helper(Kind::StoreStatus, Format::Ax, 0x7e0),
            "46",
            json!({"reason":0,"rax":"deadaabb","flags":"2"}),
            0x446,
            vec![(0, 0xdeadaabb)],
        ),
        (
            &[0xdb, 0xf1][..],
            Numeric {
                kind: Kind::CompareFlags,
                format: Format::Register,
                index: 1,
                encoding: 0x3f1,
                ..Numeric::default()
            }
            .encode() as i32,
            "446",
            json!({"reason":0,"flags":"47","rax":"1234"}),
            0x447,
            vec![(0, 0xdeadbeef)],
        ),
    ] {
        let mut code = vec![0xb8, 0xef, 0xbe, 0xad, 0xde, 0x39, 0xc0];
        code.extend_from_slice(suffix);
        let mut p = packet(
            &code,
            0x1000,
            3,
            (&registers, flags, 0x1009, BUDGET as u32, 0),
        );
        p["accesses"] = json!([{"kind":"x87","args":[op,"0",Segment::Ds as u32,"1007",input_flags,"deadbeef"],"result":output}]);
        cases.push(p);
    }
    run_cases(cases);
}

#[test]
fn x87_waiting_detector_obeys_predecessor_retirement_budget_stop_and_middle_entries() {
    let code = [0xb8, 0xef, 0xbe, 0xad, 0xde, 0x9b, 0x90];
    let wait = helper(Kind::Wait, Format::None, 0);
    let mut failed = packet(
        &code,
        0x1000,
        2,
        (&[(0, 0xdeadbeef)], 0xcd7, 0x1005, X87_EXCEPTION as u32, 1),
    );
    failed["accesses"] = json!([{"kind":"x87","args":[wait,"0",Segment::Ds as u32,"1005","8d7","deadbeef"],"result":{"reason":X87_EXCEPTION}}]);
    let budget = packet(
        &code,
        0x1000,
        1,
        (&[(0, 0xdeadbeef)], 0xcd7, 0x1005, BUDGET as u32, 0),
    );
    let mut stop = packet(
        &code,
        0x1000,
        2,
        (&[(0, 0xdeadbeef)], 0xcd7, 0x1005, STOP as u32, 1),
    );
    stop["stop"] = json!("1005");
    let mut middle = packet(
        &code,
        0x1005,
        1,
        (&[], 0xcd7, 0x1005, X87_EXCEPTION as u32, 1),
    );
    middle["accesses"] = json!([{"kind":"x87","args":[wait,"0",Segment::Ds as u32,"1005","8d7","1122334400000000"],"result":{"reason":X87_EXCEPTION}}]);
    run_cases(vec![failed, budget, stop, middle]);
}

#[test]
fn x87_code_writes_retire_before_dispatch_and_obey_budget_stop_priority() {
    let mut cases = vec![];
    for (budget, reason, remaining, stop) in [
        (1, BUDGET, 0, false),
        (2, STOP, 1, true),
        (2, DISPATCH, 1, false),
    ] {
        let mut p = packet(
            &[0xd9, 0x3b, 0x90],
            0x1000,
            budget,
            (&[], 0xcd7, 0x1002, reason as u32, remaining),
        );
        p["accesses"] = json!([{"kind":"x87","args":[helper(Kind::StoreControl, Format::None, 0x13b),"1122334400000003",Segment::Ds as u32,"1000","8d7","1122334400000000"],"result":{"reason":2}}]);
        if stop {
            p["stop"] = json!("1002");
        }
        cases.push(p);
    }
    run_cases(cases);
}

#[test]
fn x87_helper_types_coexist_with_dynamic_scalar_wide_vector_and_numeric_imports() {
    let code = [
        0x48, 0x83, 0x03, 1, 0x48, 0xf7, 0xe5, 0x48, 0xf7, 0xf5, 0xf3, 0x0f, 0x58, 0xc1, 0x0f,
        0xae, 0x13, 0x9b, 0xc3,
    ];
    let artifact = compiled_fixture(0x1000, &code, 0x1000);
    wasmparser::Validator::new()
        .validate_all(&artifact.bytes)
        .unwrap();
}
