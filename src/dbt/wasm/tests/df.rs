use super::*;

#[test]
fn inherited_flag_writers_preserve_direction_including_undefined_and_zero_counts() {
    let mut cases = Vec::new();
    for (code, input, expected, flags, mask) in [
        (
            vec![0x04, 1],
            vec![(0, 0x7f)],
            vec![(0, 0x80)],
            0xc92,
            0xcd7,
        ),
        (
            vec![0x10, 0xc8],
            vec![(0, 0), (1, 0xff)],
            vec![(0, 0)],
            0x457,
            0xcd7,
        ),
        (
            vec![0x18, 0xc8],
            vec![(0, 0), (1, 0xff)],
            vec![(0, 0)],
            0x457,
            0xcd7,
        ),
        (vec![0x39, 0xc8], vec![(0, 0), (1, 1)], vec![], 0x497, 0xcd7),
        (vec![0x31, 0xc0], vec![], vec![(0, 0)], 0x446, 0xcd7),
        (
            vec![0x20, 0xc8],
            vec![(0, 0x88), (1, 0)],
            vec![(0, 0)],
            0x446,
            0xcd7,
        ),
        (
            vec![0x08, 0xc8],
            vec![(0, 0x88), (1, 0)],
            vec![(0, 0x88)],
            0x486,
            0xcd7,
        ),
        (
            vec![0x84, 0xc8],
            vec![(0, 0x88), (1, 0)],
            vec![],
            0x446,
            0xcd7,
        ),
        (
            vec![0xfe, 0xc4],
            vec![(0, 0xff88)],
            vec![(0, 0x88)],
            0x457,
            0xcd7,
        ),
        (
            vec![0x66, 0xff, 0xc8],
            vec![(0, 0x8000)],
            vec![(0, 0x7fff)],
            0xc17,
            0xcd7,
        ),
        (
            vec![0xf6, 0xd8],
            vec![(0, 0x80)],
            vec![(0, 0x80)],
            0xc83,
            0xcd7,
        ),
        (
            vec![0xf6, 0xd0],
            vec![(0, 0x88)],
            vec![(0, 0x77)],
            0xcd7,
            0xcd7,
        ),
        (vec![0xf8], vec![], vec![], 0xcd6, 0xcd7),
        (vec![0xf9], vec![], vec![], 0xcd7, 0xcd7),
        (vec![0xf5], vec![], vec![], 0xcd6, 0xcd7),
        (vec![0x9e], vec![(0, 0)], vec![], 0xc02, 0xcd7),
        (vec![0x9f], vec![(0, 0)], vec![(0, 0xd700)], 0xcd7, 0xcd7),
        (
            vec![0xc0, 0xe0, 1],
            vec![(0, 0x80)],
            vec![(0, 0)],
            0xc47,
            0xcc7,
        ),
        (
            vec![0xc0, 0xe8, 1],
            vec![(0, 0x80)],
            vec![(0, 0x40)],
            0xc02,
            0xcc7,
        ),
        (
            vec![0xc0, 0xf8, 1],
            vec![(0, 0x81)],
            vec![(0, 0xc0)],
            0x487,
            0xcc7,
        ),
        (
            vec![0xc0, 0xc0, 8],
            vec![(0, 0x80)],
            vec![(0, 0x80)],
            0x4d6,
            0x4d7,
        ),
        (
            vec![0xc0, 0xd0, 9],
            vec![(0, 0x88)],
            vec![(0, 0x88)],
            0x4d7,
            0x4d7,
        ),
        (
            vec![0xc0, 0xe0, 0],
            vec![(0, 0x88)],
            vec![(0, 0x88)],
            0xcd7,
            0xcd7,
        ),
        (
            vec![0xc1, 0xe0, 32],
            vec![(0, 0x1122334455667788)],
            vec![(0, 0x55667788)],
            0xcd7,
            0xcd7,
        ),
        (
            vec![0x66, 0x0f, 0xa4, 0xc8, 16],
            vec![(0, 1), (1, 0x1234)],
            vec![(0, 0x1234)],
            0x403,
            0x4c7,
        ),
        (
            vec![0x66, 0x0f, 0xac, 0xc8, 17],
            vec![(0, 1), (1, 0x1234)],
            vec![(0, 1)],
            0xcd7,
            0xcd7,
        ),
        (
            vec![0x0f, 0xba, 0xe8, 0],
            vec![(0, 0)],
            vec![(0, 1)],
            0x442,
            0x443,
        ),
        (vec![0x0f, 0xbc, 0xc1], vec![(1, 0)], vec![], 0x446, 0x442),
        (
            vec![0x0f, 0xbd, 0xc1],
            vec![(1, 8)],
            vec![(0, 3)],
            0x402,
            0x442,
        ),
        (
            vec![0xf6, 0xe1],
            vec![(0, 3), (1, 4)],
            vec![(0, 12)],
            0x4d6,
            0xcd7,
        ),
        (
            vec![0xf6, 0xf1],
            vec![(0, 12), (1, 4)],
            vec![(0, 3)],
            0xcd7,
            0xcd7,
        ),
    ] {
        let artifact = compiled_fixture(0x1000, &code, 0x1000);
        let mut packet = execution_case(
            &artifact.bytes,
            &artifact.entries,
            &input,
            0xcd7,
            0x1000,
            1,
            (&expected, flags & mask, 0x1000 + code.len() as u64, 1, 0),
        );
        packet["flagMask"] = json!(format!("{mask:x}"));
        cases.push(packet);
    }
    run_cases(cases);
}

#[test]
fn inherited_memory_faults_and_retained_entries_preserve_direction() {
    let mut cases = Vec::new();
    for code in [
        vec![0x00, 0x0b],
        vec![0x20, 0x0b],
        vec![0x0f, 0xbc, 0x03],
        vec![0xf6, 0x33],
    ] {
        let artifact = compiled_fixture(0x1000, &code, 0x1000);
        let for_write = code[0] != 0x0f && code != [0xf6, 0x33];
        let mut packet = execution_case(
            &artifact.bytes,
            &artifact.entries,
            &[(3, 0x4000)],
            0xcd7,
            0x1000,
            1,
            (&[], 0xcd7, 0x1000, 6, 1),
        );
        packet["accesses"] = json!([
            {"kind":if for_write {"load_for_write"} else {"load"},
                "args":["4000",if code[0] == 0x0f {4} else {1}],"result":"0"},
            {"kind":"access_failed","args":[],"result":1},
        ]);
        cases.push(packet);
    }
    let code = [0x31, 0xc0, 0xf8];
    let artifact = compiled_fixture(0x1000, &code, 0x1000);
    cases.push(execution_case(
        &artifact.bytes,
        &artifact.entries,
        &[],
        0xcd7,
        0x1002,
        1,
        (&[], 0xcd6, 0x1003, 1, 0),
    ));
    run_cases(cases);
}

#[test]
fn direction_updates_and_status_transfers_merge_the_current_imported_direction() {
    let mut cases = Vec::new();
    for (code, flags, result_flags, accumulator, budget) in [
        (vec![0xfc, 0x9f, 0x9e], 0xcd7, 0x8d7, 0x112233445566d788, 3),
        (vec![0xfd, 0x9f, 0x9e], 0x8d7, 0xcd7, 0x112233445566d788, 3),
        (vec![0xfd, 0x31, 0xc0, 0xfc], 0x8d7, 0x46, 0, 3),
        (vec![0xfc, 0x31, 0xc0, 0xfd], 0xcd7, 0x446, 0, 3),
    ] {
        let artifact = compiled_fixture(0x1000, &code, 0x1000);
        cases.push(execution_case(
            &artifact.bytes,
            &artifact.entries,
            &[(0, 0x1122334455660088)],
            flags,
            0x1000,
            budget,
            (
                &[(0, accumulator)],
                result_flags,
                0x1000 + code.len() as u64,
                1,
                0,
            ),
        ));
    }
    let artifact = compiled_fixture(0x1000, &[0xfd, 0x31, 0xc0, 0xfc], 0x1000);
    for flags in [0x8d7, 0xcd7] {
        cases.push(execution_case(
            &artifact.bytes,
            &artifact.entries,
            &[],
            flags,
            0x1003,
            1,
            (&[], 0x8d7, 0x1004, 1, 0),
        ));
    }
    run_cases(cases);
}
