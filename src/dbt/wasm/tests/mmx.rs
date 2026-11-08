use super::*;
use crate::embedding::layout::{BUDGET, DATA, DISPATCH, X87_EXCEPTION};
use crate::x86::x87::State as NumericState;

fn seeded() -> NumericState {
    let mut state = NumericState::default();
    for bank in 0..8 {
        state.set_raw(bank, 0x12340000000000000000 + bank as u128);
    }
    state.status_word = 0x6f00;
    state.control_word = 0x37f;
    state.tag_word = 0xe731;
    state.instruction_pointer = 0x123456789abcdef0;
    state.data_pointer = 0xfedcba9876543210;
    state.opcode = 0x345;
    state
}

fn projection(state: NumericState) -> Value {
    json!({"registers":(0..8).map(|bank|format!("{:x}",state.raw(bank))).collect::<Vec<_>>(),
        "controlWord":state.control_word,"statusWord":state.status_word,"tagWord":state.tag_word,"opcode":state.opcode,
        "instructionPointer":format!("{:x}",state.instruction_pointer),"dataPointer":format!("{:x}",state.data_pointer)})
}

fn packet(code: &[u8], before: NumericState, after: NumericState, outcome: Outcome<'_>) -> Value {
    let artifact = compiled_fixture(0x1000, code, 0x1000);
    let mut p = execution_case(
        &artifact.bytes,
        &artifact.entries,
        &[],
        0xcd7,
        0x1000,
        1,
        outcome,
    );
    p["x87"] = projection(before);
    p["expected"]["x87"] = projection(after);
    p["repeatBudget"] = json!(19);
    p["expected"]["repeatRemaining"] = json!("19");
    p
}

fn transition(mut state: NumericState, dst: Option<(usize, u64)>) -> NumericState {
    state.status_word &= !0x3800;
    state.tag_word = 0;
    if let Some((bank, raw)) = dst {
        state.set_raw(bank, (0xffffu128 << 64) | u128::from(raw));
    }
    state
}

fn imports(bytes: &[u8]) -> Vec<String> {
    wasmparser::Parser::new(0)
        .parse_all(bytes)
        .filter_map(|payload| match payload.unwrap() {
            wasmparser::Payload::ImportSection(reader) => Some(reader),
            _ => None,
        })
        .flat_map(|reader| reader.into_imports())
        .map(|import| import.unwrap().name.to_owned())
        .collect()
}

#[test]
fn integer_data_and_emms_lower_without_mmx_semantic_helper_calls() {
    for code in [
        &[0x0f, 0xd4, 0xc1][..],
        &[0x0f, 0x63, 0xc1],
        &[0x0f, 0x69, 0xc1],
        &[0x0f, 0x71, 0xd0, 0xff],
        &[0x0f, 0x70, 0xc1, 0x1b],
        &[0x0f, 0x6e, 0xc0],
        &[0x0f, 0x7e, 0xc0],
        &[0x0f, 0x7f, 0x03],
        &[0xf3, 0x0f, 0xd6, 0xc0],
        &[0xf2, 0x0f, 0xd6, 0xc0],
        &[0x0f, 0x77],
    ] {
        let artifact = compiled_fixture(0x1000, code, 0x1000);
        assert!(
            !imports(&artifact.bytes).iter().any(|name| name == "mmx"),
            "{code:02x?}"
        );
    }
    let conversion = compiled_fixture(0x1000, &[0x0f, 0x2a, 0xc0], 0x1000);
    assert!(imports(&conversion.bytes).iter().any(|name| name == "mmx"));
}

#[test]
fn canonical_mmx_register_data_and_emms_preserve_neighbors_and_metadata() {
    let before = seeded();
    let moved = packet(
        &[0x0f, 0x6f, 0xf8],
        before,
        transition(before, Some((7, before.raw(0) as u64))),
        (&[], 0xcd7, 0x1003, BUDGET as u32, 0),
    );
    let mut empty = before;
    empty.status_word &= !0x3800;
    empty.tag_word = 0xffff;
    let emms = packet(
        &[0x0f, 0x77],
        before,
        empty,
        (&[], 0xcd7, 0x1002, BUDGET as u32, 0),
    );
    let from = packet(
        &[0x0f, 0x6e, 0xf8],
        before,
        transition(before, Some((7, 0))),
        (&[], 0xcd7, 0x1003, BUDGET as u32, 0),
    );
    run_cases(vec![moved, emms, from]);
}

#[test]
fn mmx_64bit_pack_unpack_product_shuffle_and_full_count_literals() {
    let mut cases = vec![];
    for (code, left, right, result) in [
        (
            &[0x0f, 0x63, 0xc1][..],
            0x0080ff7f007fff80u64,
            0x7fff80000000ffffu64,
            0x7f8000ff7f807f80u64,
        ),
        (
            &[0x0f, 0x6b, 0xc1],
            0x00008000ffff7fffu64,
            0x00007fffffff8000,
            0x7fff80007fff8000,
        ),
        (
            &[0x0f, 0x67, 0xc1],
            0x010000ff0000ffff,
            0x7fff80000001fffe,
            0xff000100ffff0000,
        ),
        (
            &[0x0f, 0x68, 0xc1],
            0x0706050403020100,
            0x1716151413121110,
            0x1707160615051404,
        ),
        (
            &[0x0f, 0x69, 0xc1],
            0x0706050403020100,
            0x1716151413121110,
            0x1716070615140504,
        ),
        (
            &[0x0f, 0x6a, 0xc1],
            0x0706050403020100,
            0x1716151413121110,
            0x1716151407060504,
        ),
        (
            &[0x0f, 0xf5, 0xc1],
            0x8000800080008000,
            0x8000800080008000,
            0x8000000080000000,
        ),
        (
            &[0x0f, 0xf4, 0xc1],
            0xdeadbeefffffffff,
            0x0123456700000002,
            0x1fffffffe,
        ),
        (
            &[0x0f, 0xe1, 0xc1],
            0xffff800000010002,
            0x1000000000000001,
            0xffffffff00000000,
        ),
        (
            &[0x0f, 0x70, 0xc1, 0x1b],
            0,
            0x1111222233334444,
            0x4444333322221111,
        ),
    ] {
        let mut before = seeded();
        before.set_raw(0, (0x1234u128 << 64) | u128::from(left));
        before.set_raw(1, (0x5678u128 << 64) | u128::from(right));
        cases.push(packet(
            code,
            before,
            transition(before, Some((0, result))),
            (&[], 0xcd7, 0x1000 + code.len() as u64, BUDGET as u32, 0),
        ));
    }
    run_cases(cases);
}

#[test]
fn mmx_pending_precedes_memory_and_failed_access_preserves_all_raw_state() {
    let mut pending = seeded();
    pending.control_word = 0x37b;
    pending.status_word = 0xa884;
    let blocked = packet(
        &[0x0f, 0xfc, 0x03],
        pending,
        pending,
        (&[], 0xcd7, 0x1000, X87_EXCEPTION as u32, 1),
    );
    let before = seeded();
    let mut failed = packet(
        &[0x0f, 0xfc, 0x03],
        before,
        before,
        (&[], 0xcd7, 0x1000, DATA as u32, 1),
    );
    failed["accesses"] = json!([{"kind":"load","args":["1122334400000003",8],"result":"0"},{"kind":"access_failed","args":[],"result":1}]);
    let mut store = packet(
        &[0x0f, 0x7f, 0x03],
        before,
        transition(before, None),
        (&[], 0xcd7, 0x1003, DISPATCH as u32, 0),
    );
    store["budget"] = json!(2);
    store["expected"]["remaining"] = json!("1");
    store["accesses"] = json!([{"kind":"store","args":["1122334400000003",8,"0"],"result":2}]);
    run_cases(vec![blocked, failed, store]);
}
