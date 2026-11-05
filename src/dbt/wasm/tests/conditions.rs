use super::*;

#[test]
fn every_condition_matches_independent_truth_masks_and_preserves_all_flags() {
    use Condition::*;
    // Bit n gives the condition for CF/PF/ZF/SF/OF encoded in n's five bits.
    let truth_masks = [
        (Overflow, 0xffff0000u32),
        (NotOverflow, 0x0000ffff),
        (Below, 0xaaaaaaaa),
        (AboveOrEqual, 0x55555555),
        (Equal, 0xf0f0f0f0),
        (NotEqual, 0x0f0f0f0f),
        (BelowOrEqual, 0xfafafafa),
        (Above, 0x05050505),
        (Sign, 0xff00ff00),
        (NotSign, 0x00ff00ff),
        (Parity, 0xcccccccc),
        (NotParity, 0x33333333),
        (Less, 0x00ffff00),
        (GreaterOrEqual, 0xff0000ff),
        (LessOrEqual, 0xf0fffff0),
        (Greater, 0x0f00000f),
    ];
    let mut cases = Vec::new();
    for (condition, truth_mask) in truth_masks {
        for next_pc in [0x1002, 0x1006] {
            for context in 0..32u64 {
                let flags = 2
                    | (context & 1)
                    | (((context >> 1) & 1) << 2)
                    | (((context >> 2) & 1) << 6)
                    | (((context >> 3) & 1) << 7)
                    | (((context >> 4) & 1) << 11);
                let taken = truth_mask & (1 << context) != 0;
                for af in [0, 0x10] {
                    cases.push(case(
                        vec![Instruction {
                            pc: 0x1000,
                            next_pc,
                            operation: Operation::Jcc {
                                condition,
                                target: 0x1010,
                            },
                        }],
                        &[],
                        flags | af,
                        0x1000,
                        1,
                        (&[], flags | af, if taken { 0x1010 } else { next_pc }, 1, 0),
                    ));
                }
            }
        }
    }
    run_cases(cases);
}

#[test]
fn mixed_conditions_and_middle_entries_use_the_current_flags() {
    let mut cases = Vec::new();
    let mixed = compiled_fixture(0x1000, &[0x7c, 2, 0x72, 2], 0x1000);
    assert_eq!(mixed.entries, [0x1000, 0x1002]);
    for (pc, flags, budget, next_pc) in [
        (0x1000, 3, 2, 0x1006),
        (0x1002, 0x12, 1, 0x1004),
        (0x1002, 0x13, 1, 0x1006),
    ] {
        cases.push(execution_case(
            &mixed.bytes,
            &mixed.entries,
            &[],
            flags,
            pc,
            budget,
            (&[], flags, next_pc, 1, 0),
        ));
    }
    let forward = compiled_fixture(
        0x1000,
        &[
            0x7a, 10, 0xb8, 17, 0, 0, 0, 0xb9, 34, 0, 0, 0, 0xba, 51, 0, 0, 0,
        ],
        0x1000,
    );
    assert_eq!(forward.entries, [0x1000, 0x1002, 0x1007, 0x100c]);
    for (flags, budget, stop, expected, next_pc, reason, remaining) in [
        (6, 2, None, vec![(2, 51)], 0x1011, 1, 0),
        (2, 4, None, vec![(0, 17), (1, 34), (2, 51)], 0x1011, 1, 0),
        (0x16, 1, None, vec![], 0x100c, 1, 0),
        (0x16, 3, Some(0x100c), vec![], 0x100c, 2, 2),
        (0x16, 1, Some(0x100c), vec![], 0x100c, 1, 0),
    ] {
        let mut packet = execution_case(
            &forward.bytes,
            &forward.entries,
            &[],
            flags,
            0x1000,
            budget,
            (&expected, flags, next_pc, reason, remaining),
        );
        if let Some(stop) = stop {
            packet["stop"] = json!(format!("{stop:x}"));
        }
        cases.push(packet);
    }
    let join = compiled_fixture(
        0x1000,
        &[
            0x74, 4, 0x31, 0xc0, 0xeb, 3, 0x83, 0xc8, 1, 0x74, 5, 0xba, 0x22, 0, 0, 0, 0xb9, 0x33,
            0, 0, 0,
        ],
        0x1000,
    );
    assert_eq!(
        join.entries,
        [0x1000, 0x1002, 0x1004, 0x1006, 0x1009, 0x100b, 0x1010]
    );
    for (flags, expected, result_flags) in [
        (2, vec![(0, 0), (1, 0x33)], 0x46),
        (0x42, vec![(0, 1), (1, 0x33), (2, 0x22)], 2),
    ] {
        let mut packet = execution_case(
            &join.bytes,
            &join.entries,
            &[],
            flags,
            0x1000,
            5,
            (&expected, result_flags, 0x1015, 1, 0),
        );
        packet["flagMask"] = json!("8c7");
        cases.push(packet);
    }
    for (flags, budget, expected) in [
        (0x52, 2, vec![(1, 0x33)]),
        (0x12, 3, vec![(1, 0x33), (2, 0x22)]),
    ] {
        cases.push(execution_case(
            &join.bytes,
            &join.entries,
            &[],
            flags,
            0x1009,
            budget,
            (&expected, flags, 0x1015, 1, 0),
        ));
    }
    run_cases(cases);
}

#[test]
fn conditional_target_frontiers_keep_budget_stop_and_target_validation_order() {
    let mut cases = Vec::new();
    let pc = 0x7ffffffffff0;
    let noncanonical = compiled_fixture(pc, &[0x78, 0x0e], pc);
    for (flags, budget, stop, next_pc, reason, remaining) in [
        (2, 1, None, pc + 2, 1, 0),
        (0x82, 1, None, pc, 5, 1),
        (0x92, 1, None, pc, 5, 1),
        (0x92, 0, Some(pc), pc, 1, 0),
        (0x92, 1, Some(pc), pc, 2, 1),
    ] {
        let mut packet = execution_case(
            &noncanonical.bytes,
            &noncanonical.entries,
            &[],
            flags,
            pc,
            budget,
            (&[], flags, next_pc, reason, remaining),
        );
        if let Some(stop) = stop {
            packet["stop"] = json!(format!("{stop:x}"));
        }
        cases.push(packet);
    }
    let pc = 0x7ffffffffffe;
    let fallthrough = compiled_fixture(pc, &[0x78, 0xfe], pc);
    for (flags, next_pc) in [(2, 0x800000000000), (0x92, pc)] {
        cases.push(execution_case(
            &fallthrough.bytes,
            &fallthrough.entries,
            &[],
            flags,
            pc,
            1,
            (&[], flags, next_pc, 1, 0),
        ));
    }
    let external = compiled_fixture(0x1000, &[0x7f, 0x0e], 0x1000);
    for (budget, stop, reason, remaining) in [
        (2, None, 0, 1),
        (2, Some(0x1010), 2, 1),
        (1, Some(0x1010), 1, 0),
    ] {
        let mut packet = execution_case(
            &external.bytes,
            &external.entries,
            &[],
            0x12,
            0x1000,
            budget,
            (&[], 0x12, 0x1010, reason, remaining),
        );
        if let Some(stop) = stop {
            packet["stop"] = json!(format!("{stop:x}"));
        }
        cases.push(packet);
    }
    run_cases(cases);
}
