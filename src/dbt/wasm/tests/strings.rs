use super::*;
use crate::embedding::layout::{BUDGET, DATA};
use crate::x86::context::Segment;
use crate::x86::instruction::{Repeat, StringKind};

fn string(kind: StringKind, width: Width, repeat: Repeat) -> Instruction {
    Instruction {
        pc: 0x1000,
        next_pc: 0x1002,
        operation: Operation::String {
            kind,
            width,
            address_width: Width::W64,
            source_segment: Segment::Ds,
            repeat,
        },
    }
}

#[test]
fn bare_elements_use_ordered_memory_and_only_their_implicit_registers() {
    let mut cases = vec![];
    for (kind, accesses, expected, flags) in [
        (
            StringKind::Movs,
            json!([
                {"kind":"load","args":["4000",1],"result":"7b"},
                {"kind":"access_failed","args":[],"result":0},
                {"kind":"store","args":["5000",1,"7b"],"result":1}
            ]),
            vec![(6, 0x4001), (7, 0x5001)],
            0x8d7,
        ),
        (
            StringKind::Stos,
            json!([
                {"kind":"store","args":["5000",1,"88"],"result":1}
            ]),
            vec![(7, 0x5001)],
            0x8d7,
        ),
        (
            StringKind::Lods,
            json!([
                {"kind":"load","args":["4000",1],"result":"7b"},
                {"kind":"access_failed","args":[],"result":0}
            ]),
            vec![(0, 0x112233445566777b), (6, 0x4001)],
            0x8d7,
        ),
        (
            StringKind::Cmps,
            json!([
                {"kind":"load","args":["4000",1],"result":"5"},
                {"kind":"access_failed","args":[],"result":0},
                {"kind":"load","args":["5000",1],"result":"6"},
                {"kind":"access_failed","args":[],"result":0}
            ]),
            vec![(6, 0x4001), (7, 0x5001)],
            0x97,
        ),
        (
            StringKind::Scas,
            json!([
                {"kind":"load","args":["5000",1],"result":"88"},
                {"kind":"access_failed","args":[],"result":0}
            ]),
            vec![(7, 0x5001)],
            0x46,
        ),
    ] {
        let mut p = case(
            vec![string(kind, Width::W8, Repeat::None)],
            &[(0, 0x1122334455667788), (1, 0), (6, 0x4000), (7, 0x5000)],
            0x8d7,
            0x1000,
            1,
            (&expected, flags, 0x1002, BUDGET as u32, 0),
        );
        p["accesses"] = accesses;
        cases.push(p);
    }
    run_cases(cases);
}

#[test]
fn bare_movs_destination_failure_leaves_the_element_uncommitted() {
    let mut p = case(
        vec![string(StringKind::Movs, Width::W32, Repeat::None)],
        &[(6, 0x4000), (7, 0x5000)],
        0xcd7,
        0x1000,
        1,
        (&[], 0xcd7, 0x1000, DATA as u32, 1),
    );
    p["accesses"] = json!([
        {"kind":"load","args":["4000",4],"result":"12345678"},
        {"kind":"access_failed","args":[],"result":0},
        {"kind":"store","args":["5000",4,"12345678"],"result":0}
    ]);
    p["faultSegment"] = json!(Segment::Es as u32);
    run_cases(vec![p]);
}

#[test]
fn repetition_quota_and_comparison_completion_have_distinct_exits() {
    let mut cases = vec![];
    for (kind, repeat, quota, count, values, expected, flags, pc, reason, remaining) in [
        (
            StringKind::Lods,
            Repeat::Count,
            1,
            3,
            vec![(0x4000, 5)],
            vec![(0, 0x1122334400000005), (6, 0x4001), (1, 2)],
            2,
            0x1000,
            11,
            1,
        ),
        (
            StringKind::Lods,
            Repeat::Count,
            0,
            3,
            vec![],
            vec![],
            2,
            0x1000,
            11,
            1,
        ),
        (
            StringKind::Lods,
            Repeat::Count,
            0,
            0,
            vec![],
            vec![],
            2,
            0x1002,
            1,
            0,
        ),
        (
            StringKind::Cmps,
            Repeat::WhileEqual,
            2,
            3,
            vec![(0x4000, 5), (0x5000, 5), (0x4001, 6), (0x5001, 7)],
            vec![(6, 0x4002), (7, 0x5002), (1, 1)],
            0x97,
            0x1002,
            1,
            0,
        ),
        (
            StringKind::Cmps,
            Repeat::WhileEqual,
            2,
            3,
            vec![(0x4000, 5), (0x5000, 5), (0x4001, 6), (0x5001, 6)],
            vec![(6, 0x4002), (7, 0x5002), (1, 1)],
            2,
            0x1000,
            11,
            1,
        ),
        (
            StringKind::Scas,
            Repeat::WhileNotEqual,
            1,
            3,
            vec![(0x5000, 0)],
            vec![(7, 0x5001), (1, 2)],
            0x46,
            0x1002,
            1,
            0,
        ),
    ] {
        let mut p = case(
            vec![string(kind, Width::W8, repeat)],
            &[
                (0, 0x1122334400000000),
                (1, count),
                (6, 0x4000),
                (7, 0x5000),
            ],
            2,
            0x1000,
            1,
            (&expected, flags, pc, reason, remaining),
        );
        p["repeatBudget"] = json!(quota.to_string());
        p["expected"]["repeatRemaining"] = json!("0");
        p["accesses"] = json!(values.into_iter().flat_map(|(address,value)| [
            json!({"kind":"load","args":[format!("{address:x}"),1],"result":format!("{value:x}")}),
            json!({"kind":"access_failed","args":[],"result":0})
        ]).collect::<Vec<_>>());
        cases.push(p);
    }
    run_cases(cases);
}

#[test]
fn repeated_comparison_fault_restores_its_own_entry_flags() {
    let mut p = case(
        vec![
            Instruction {
                pc: 0x1000,
                next_pc: 0x1002,
                operation: Operation::Alu {
                    kind: Alu::Add,
                    dst: RegisterView::low(0),
                    src: DataOperand::Immediate(1),
                    width: Width::W8,
                },
            },
            Instruction {
                pc: 0x1002,
                next_pc: 0x1004,
                ..string(StringKind::Cmps, Width::W8, Repeat::WhileEqual)
            },
        ],
        &[(0, 0x7f), (1, 3), (6, 0x4000), (7, 0x5000)],
        2,
        0x1000,
        2,
        (
            &[(0, 0x80), (1, 1), (6, 0x4002), (7, 0x5002)],
            0x892,
            0x1002,
            DATA as u32,
            1,
        ),
    );
    p["repeatBudget"] = json!("3");
    p["expected"]["repeatRemaining"] = json!("1");
    p["accesses"] = json!([
        {"kind":"load","args":["4000",1],"result":"5"},
        {"kind":"access_failed","args":[],"result":0},
        {"kind":"load","args":["5000",1],"result":"5"},
        {"kind":"access_failed","args":[],"result":0},
        {"kind":"load","args":["4001",1],"result":"6"},
        {"kind":"access_failed","args":[],"result":0},
        {"kind":"load","args":["5001",1],"result":"6"},
        {"kind":"access_failed","args":[],"result":0},
        {"kind":"load","args":["4002",1],"result":"0"},
        {"kind":"access_failed","args":[],"result":1}
    ]);
    p["faultSegment"] = json!(Segment::Ds as u32);
    run_cases(vec![p]);
}

#[test]
fn descending_comparison_suspensions_merge_direction_with_predecessor_status() {
    let instructions = vec![
        Instruction {
            pc: 0x1000,
            next_pc: 0x1001,
            operation: Operation::Direction { set: true },
        },
        Instruction {
            pc: 0x1001,
            next_pc: 0x1003,
            operation: Operation::Alu {
                kind: Alu::Add,
                dst: RegisterView::low(0),
                src: DataOperand::Immediate(1),
                width: Width::W8,
            },
        },
        Instruction {
            pc: 0x1003,
            next_pc: 0x1005,
            ..string(StringKind::Cmps, Width::W8, Repeat::WhileEqual)
        },
    ];
    let first_pair = vec![
        json!({"kind":"load","args":["4002",1],"result":"5"}),
        json!({"kind":"access_failed","args":[],"result":0}),
        json!({"kind":"load","args":["5002",1],"result":"5"}),
        json!({"kind":"access_failed","args":[],"result":0}),
    ];
    let mut cases = vec![];
    for (quota, count, pointer, reason, repeat_remaining) in
        [(1, 2, 0x4001, 11, 0), (3, 1, 0x4000, DATA as u32, 1)]
    {
        let mut p = case(
            instructions.clone(),
            &[(0, 0x7f), (1, 3), (6, 0x4002), (7, 0x5002)],
            2,
            0x1000,
            3,
            (
                &[(0, 0x80), (1, count), (6, pointer), (7, pointer + 0x1000)],
                0xc92,
                0x1003,
                reason,
                1,
            ),
        );
        let mut accesses = first_pair.clone();
        if quota == 3 {
            accesses.extend([
                json!({"kind":"load","args":["4001",1],"result":"6"}),
                json!({"kind":"access_failed","args":[],"result":0}),
                json!({"kind":"load","args":["5001",1],"result":"6"}),
                json!({"kind":"access_failed","args":[],"result":0}),
                json!({"kind":"load","args":["4000",1],"result":"0"}),
                json!({"kind":"access_failed","args":[],"result":1}),
            ]);
            p["faultSegment"] = json!(Segment::Ds as u32);
        }
        p["accesses"] = json!(accesses);
        p["repeatBudget"] = json!(quota.to_string());
        p["expected"]["repeatRemaining"] = json!(repeat_remaining.to_string());
        cases.push(p);
    }
    run_cases(cases);
}

fn context(mode: &str, default32: bool) -> crate::x86::context::ExecutionContext {
    if mode == "long64" {
        return crate::x86::context::ExecutionContext::from_json(&json!({
            "mode":"long64","fsBase":"0x100000000","gsBase":"0x0"
        }))
        .unwrap();
    }
    let mut segments = serde_json::Map::new();
    for name in ["cs", "ss", "ds", "es", "fs", "gs"] {
        segments.insert(name.into(),json!({
            "base":"0x0","limit":if mode == "virtual8086" {0xffffu32} else {u32::MAX},
            "default32":if mode == "virtual8086" {false} else if name == "ss" {!default32} else {default32},
            "usable":true,"type":if name == "cs" && mode != "virtual8086" {"readable-code"} else {"read-write"}
        }));
    }
    crate::x86::context::ExecutionContext::from_json(&json!({"mode":mode,"segments":segments}))
        .unwrap()
}

#[test]
fn string_widths_directions_and_upper_banks_follow_each_imported_mode() {
    let mut cases = vec![];
    for (mode, default32) in [
        ("long64", true),
        ("real", false),
        ("real", true),
        ("virtual8086", false),
        ("protected", false),
        ("protected", true),
        ("compatibility", false),
        ("compatibility", true),
    ] {
        for address_width in if mode == "long64" {
            [Width::W32, Width::W64]
        } else {
            [Width::W16, Width::W32]
        } {
            for (width, forward, backward, loaded_accumulator) in [
                (
                    Width::W8,
                    [0x4001, 0x5001],
                    [0x3fff, 0x4fff],
                    0x1122334455667707,
                ),
                (
                    Width::W16,
                    [0x4002, 0x5002],
                    [0x3ffe, 0x4ffe],
                    0x1122334455660007,
                ),
                (
                    Width::W32,
                    [0x4004, 0x5004],
                    [0x3ffc, 0x4ffc],
                    if mode == "long64" {
                        7
                    } else {
                        0x1122334400000007
                    },
                ),
                (Width::W64, [0x4008, 0x5008], [0x3ff8, 0x4ff8], 7),
            ] {
                if width == Width::W64 && mode != "long64" {
                    continue;
                }
                for direction in [false, true] {
                    for kind in [
                        StringKind::Movs,
                        StringKind::Stos,
                        StringKind::Lods,
                        StringKind::Cmps,
                        StringKind::Scas,
                    ] {
                        for repeated in [false, true] {
                            let source = matches!(
                                kind,
                                StringKind::Movs | StringKind::Lods | StringKind::Cmps
                            );
                            let destination = kind != StringKind::Lods;
                            let comparison = matches!(kind, StringKind::Cmps | StringKind::Scas);
                            let repeat = if !repeated {
                                Repeat::None
                            } else if comparison {
                                Repeat::WhileEqual
                            } else {
                                Repeat::Count
                            };
                            let mut instruction = string(kind, width, repeat);
                            instruction.operation = Operation::String {
                                kind,
                                width,
                                address_width,
                                source_segment: Segment::Fs,
                                repeat,
                            };
                            let mut u = unit(vec![instruction]);
                            u.context = context(mode, default32);
                            let raw = if address_width == Width::W64 {
                                0
                            } else {
                                0x1122334400000000
                            };
                            let output_high = if address_width == Width::W64
                                || mode == "long64" && address_width == Width::W32
                            {
                                0
                            } else {
                                raw
                            };
                            let pointers = if direction { backward } else { forward };
                            let mut expected = vec![];
                            if source {
                                expected.push((6, output_high | pointers[0]));
                            }
                            if destination {
                                expected.push((7, output_high | pointers[1]));
                            }
                            if repeated {
                                expected.push((1, output_high));
                            }
                            if kind == StringKind::Lods {
                                expected.push((0, loaded_accumulator));
                            }
                            let flags = if direction { 0xcd7 } else { 0x8d7 };
                            let result_flags = if comparison {
                                if direction { 0x493 } else { 0x93 }
                            } else {
                                flags
                            };
                            let mut p = execution_case(
                                &emit(&u),
                                &[0x1000],
                                &[
                                    (
                                        0,
                                        if kind == StringKind::Lods {
                                            0x1122334455667788
                                        } else {
                                            5
                                        },
                                    ),
                                    (1, raw | 1),
                                    (6, raw | 0x4000),
                                    (7, raw | 0x5000),
                                ],
                                flags,
                                0x1000,
                                1,
                                (&expected, result_flags, 0x1002, BUDGET as u32, 0),
                            );
                            let mut accesses = vec![];
                            let segmented = mode != "long64";
                            if source {
                                let mut args = json!([
                                    if segmented { "4000" } else { "100004000" },
                                    width.bytes()
                                ]);
                                if segmented {
                                    args.as_array_mut().unwrap().push(json!(Segment::Fs as u32));
                                }
                                accesses.push(json!({"kind":if segmented {"segmented_load"} else {"load"},"args":args,"result":if kind == StringKind::Lods {"7"} else {"5"}}));
                                accesses.push(json!({"kind":if segmented {"segmented_access_failed"} else {"access_failed"},"args":[],"result":0}));
                            }
                            if destination {
                                let store = matches!(kind, StringKind::Movs | StringKind::Stos);
                                let mut args = json!(["5000", width.bytes()]);
                                if store {
                                    args.as_array_mut().unwrap().push(json!("5"));
                                }
                                if segmented {
                                    args.as_array_mut().unwrap().push(json!(Segment::Es as u32));
                                }
                                accesses.push(json!({"kind":match (segmented,store) {(true,true)=>"segmented_store",(true,false)=>"segmented_load",(false,true)=>"store",(false,false)=>"load"},"args":args,"result":if store {json!(1)} else {json!("7")}}));
                                if !store {
                                    accesses.push(json!({"kind":if segmented {"segmented_access_failed"} else {"access_failed"},"args":[],"result":0}));
                                }
                            }
                            p["accesses"] = json!(accesses);
                            if repeated {
                                p["repeatBudget"] = json!("1");
                                p["expected"]["repeatRemaining"] = json!("0");
                            }
                            cases.push(p);
                        }
                    }
                }
            }
        }
    }
    run_cases(cases);
}

#[test]
fn unfinished_code_writing_repeats_dispatch_after_one_committed_element() {
    let mut cases = vec![];
    for (count, quota, budget, stop, next, reason, remaining, repeat_remaining) in [
        (2, 2, 1, None, 0x1000, 0, 1, 1),
        (2, 1, 1, None, 0x1000, 11, 1, 0),
        (1, 1, 1, Some(0x1002), 0x1002, 1, 0, 0),
        (1, 2, 2, Some(0x1002), 0x1002, 2, 1, 1),
        (1, 2, 2, None, 0x1002, 0, 1, 1),
    ] {
        let mut p = case(
            vec![
                string(StringKind::Movs, Width::W8, Repeat::Count),
                Instruction {
                    pc: 0x1002,
                    next_pc: 0x1007,
                    operation: Operation::Mov {
                        dst: RegisterView::low(8),
                        src: DataOperand::Immediate(7),
                        width: Width::W32,
                    },
                },
            ],
            &[(1, count), (6, 0x4000), (7, 0x2000)],
            0xcd7,
            0x1000,
            budget,
            (
                &[(1, count - 1), (6, 0x3fff), (7, 0x1fff)],
                0xcd7,
                next,
                reason,
                remaining,
            ),
        );
        p["repeatBudget"] = json!(quota.to_string());
        p["expected"]["repeatRemaining"] = json!(repeat_remaining.to_string());
        if let Some(stop) = stop {
            p["stop"] = json!(format!("{stop:x}"));
        }
        p["accesses"] = json!([
            {"kind":"load","args":["4000",1],"result":"a4"},
            {"kind":"access_failed","args":[],"result":0},
            {"kind":"store","args":["2000",1,"a4"],"result":2}
        ]);
        cases.push(p);
    }
    run_cases(cases);
}

#[test]
fn selected_zero_count_preserves_raw_banks_and_count_max_remains_bounded() {
    let mut zero = string(StringKind::Cmps, Width::W32, Repeat::WhileEqual);
    zero.operation = Operation::String {
        kind: StringKind::Cmps,
        width: Width::W32,
        address_width: Width::W32,
        source_segment: Segment::Fs,
        repeat: Repeat::WhileEqual,
    };
    let mut p = case(
        vec![zero],
        &[(1, 0x1122334400000000), (6, u64::MAX), (7, u64::MAX)],
        0xcd7,
        0x1000,
        1,
        (&[], 0xcd7, 0x1002, BUDGET as u32, 0),
    );
    p["repeatBudget"] = json!("0");
    p["expected"]["repeatRemaining"] = json!("0");
    let mut bounded = case(
        vec![string(StringKind::Stos, Width::W8, Repeat::Count)],
        &[(0, 0x7b), (1, u64::MAX), (7, 0x5000)],
        2,
        0x1000,
        1,
        (&[(1, 0xfffffffffffffffe), (7, 0x5001)], 2, 0x1000, 11, 1),
    );
    bounded["repeatBudget"] = json!("1");
    bounded["expected"]["repeatRemaining"] = json!("0");
    bounded["accesses"] = json!([{"kind":"store","args":["5000",1,"7b"],"result":1}]);
    run_cases(vec![p, bounded]);
}

#[test]
fn repetition_allowance_is_shared_across_retired_instructions_and_middle_entries() {
    let instructions = vec![
        string(StringKind::Lods, Width::W8, Repeat::Count),
        Instruction {
            pc: 0x1002,
            next_pc: 0x1007,
            operation: Operation::Mov {
                dst: RegisterView::low(1),
                src: DataOperand::Immediate(3),
                width: Width::W32,
            },
        },
        Instruction {
            pc: 0x1007,
            next_pc: 0x1009,
            ..string(StringKind::Lods, Width::W8, Repeat::Count)
        },
    ];
    let mut p = case(
        instructions.clone(),
        &[(1, 1), (6, 0x4000)],
        2,
        0x1000,
        3,
        (
            &[(0, 0x1122334400000007), (1, 2), (6, 0x4002)],
            2,
            0x1007,
            11,
            1,
        ),
    );
    p["repeatBudget"] = json!("2");
    p["expected"]["repeatRemaining"] = json!("0");
    p["accesses"] = json!([
        {"kind":"load","args":["4000",1],"result":"5"},
        {"kind":"access_failed","args":[],"result":0},
        {"kind":"load","args":["4001",1],"result":"7"},
        {"kind":"access_failed","args":[],"result":0}
    ]);
    let mut middle = case(
        instructions,
        &[(1, 0x1122334400000000), (6, u64::MAX)],
        0xcd7,
        0x1002,
        2,
        (&[(1, 3)], 0xcd7, 0x1007, 11, 1),
    );
    middle["repeatBudget"] = json!("0");
    middle["expected"]["repeatRemaining"] = json!("0");
    run_cases(vec![p, middle]);
}
