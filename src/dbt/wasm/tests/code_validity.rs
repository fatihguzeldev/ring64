use super::*;
use crate::embedding::layout::{BUDGET, DISPATCH, STOP};

#[test]
fn code_writes_finish_effects_then_observe_gates_before_stale_native_edges() {
    let mut cases = vec![];
    let inc = compiled_fixture(0x1000, &[0xfe, 0x03, 0xb8, 1, 0, 0, 0], 0x1000);
    assert_eq!(inc.entries, [0x1000, 0x1002]);
    for (status, budget, stop, changed, reason, remaining) in [
        (2, 2, None, false, DISPATCH, 1),
        (2, 1, Some(0x1002), false, BUDGET, 0),
        (2, 2, Some(0x1002), false, STOP, 1),
        (1, 2, None, true, BUDGET, 0),
    ] {
        let expected = if changed { vec![(0, 1)] } else { vec![] };
        let mut packet = execution_case(
            &inc.bytes,
            &inc.entries,
            &[(3, 0x1002)],
            0x8d7,
            0x1000,
            budget,
            (
                &expected,
                0x83,
                if changed { 0x1007 } else { 0x1002 },
                reason as u32,
                remaining,
            ),
        );
        packet["accesses"] = json!([
            {"kind":"load_for_write","args":["1002",1],"result":"b8"},
            {"kind":"access_failed","args":[],"result":0},
            {"kind":"store","args":["1002",1,"b9"],"result":status}
        ]);
        if let Some(stop) = stop {
            packet["stop"] = json!(format!("{stop:x}"));
        }
        cases.push(packet);
    }

    for (code, inputs, entry, next, value, stack) in [
        (
            vec![0xc6, 3, 0xbb, 0xb8, 1, 0, 0, 0],
            vec![(3, 0x1003)],
            0x1000,
            0x1003,
            "bb",
            false,
        ),
        (
            vec![0x50, 0xb9, 1, 0, 0, 0],
            vec![(0, 0x1005), (4, 0x1010)],
            0x1000,
            0x1001,
            "1005",
            true,
        ),
        (
            vec![0xe8, 3, 0, 0, 0, 0xa5, 0xa5, 0xa5, 0xb9, 1, 0, 0, 0],
            vec![(4, 0x1010)],
            0x1000,
            0x1008,
            "1005",
            true,
        ),
        (
            vec![
                0x75, 6, 0xff, 0xd0, 0xa5, 0xa5, 0xa5, 0xa5, 0xb9, 1, 0, 0, 0,
            ],
            vec![(0, 0x1008), (4, 0x1010)],
            0x1002,
            0x1008,
            "1004",
            true,
        ),
    ] {
        let artifact = compiled_fixture(0x1000, &code, 0x1000);
        for (budget, stop, reason, remaining) in [
            (2, None, DISPATCH, 1),
            (1, Some(next), BUDGET, 0),
            (2, Some(next), STOP, 1),
        ] {
            let expected = if stack { vec![(4, 0x1008)] } else { vec![] };
            let mut packet = execution_case(
                &artifact.bytes,
                &artifact.entries,
                &inputs,
                0x8d7,
                entry,
                budget,
                (&expected, 0x8d7, next, reason as u32, remaining),
            );
            packet["accesses"] = json!([
                {"kind":"store","args":[if stack {"1008"} else {"1003"},if stack {8} else {1},value],"result":2}
            ]);
            if let Some(stop) = stop {
                packet["stop"] = json!(format!("{stop:x}"));
            }
            cases.push(packet);
        }
    }
    run_cases(cases);
}

#[test]
fn code_write_status_covers_identity_and_conditional_memory_writers() {
    let mut cases = vec![];
    for (prefix, width, before, after, flags, read) in [
        (vec![0xc0, 0x23, 0], 1, "b8", "b8", 0x8d7, true),
        (vec![0x0f, 0xa4, 0x03, 0], 4, "1b8", "1b8", 0x8d7, true),
        (vec![0xf6, 0x13], 1, "b8", "47", 0x8d7, true),
        (vec![0x0f, 0x94, 0x03], 1, "0", "1", 0x8d7, false),
        (vec![0x0f, 0xba, 0x2b, 0], 4, "1b8", "1b9", 0x42, true),
        (vec![0x83, 0x13, 0], 4, "1b8", "1b9", 2, true),
    ] {
        let next = 0x1000 + prefix.len() as u64;
        let bit_flags = prefix.starts_with(&[0x0f, 0xba]);
        let mut bytes = prefix;
        bytes.extend_from_slice(&[0xb8, 1, 0, 0, 0]);
        let artifact = compiled_fixture(0x1000, &bytes, 0x1000);
        assert_eq!(artifact.entries, [0x1000, next]);
        let mut packet = execution_case(
            &artifact.bytes,
            &artifact.entries,
            &[(3, next)],
            0x8d7,
            0x1000,
            2,
            (&[], flags, next, DISPATCH as u32, 1),
        );
        let address = format!("{next:x}");
        let mut accesses = vec![];
        if read {
            accesses.push(json!({"kind":"load_for_write","args":[address,width],"result":before}));
            accesses.push(json!({"kind":"access_failed","args":[],"result":0}));
        }
        accesses.push(json!({"kind":"store","args":[address,width,after],"result":2}));
        packet["accesses"] = json!(accesses);
        if bit_flags {
            packet["flagMask"] = json!("43");
        }
        cases.push(packet);
    }
    run_cases(cases);
}
