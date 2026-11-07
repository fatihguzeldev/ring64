use super::*;
use crate::embedding::layout::{BUDGET, DATA, DISPATCH, SEGMENT, TARGET};
use crate::x86::context::{ExecutionContext, Segment};
use crate::x86::instruction::{Address, AddressBase, AddressIndex, CountCondition};

fn context(stack32: bool) -> ExecutionContext {
    limited_context(stack32, u32::MAX)
}

fn limited_context(stack32: bool, code_limit: u32) -> ExecutionContext {
    let mut segments = serde_json::Map::new();
    for name in ["cs", "ss", "ds", "es", "fs", "gs"] {
        segments.insert(
            name.into(),
            json!({
                "base":"0x0", "limit":if name == "cs" {code_limit}else{u32::MAX},
                "default32":name != "ss" || stack32,
                "usable":true,"type":if name == "cs" {"readable-code"} else {"read-write"}
            }),
        );
    }
    ExecutionContext::from_json(&json!({"mode":"protected","segments":segments})).unwrap()
}

fn packet(
    context: ExecutionContext,
    operation: Operation,
    input: &[(usize, u64)],
    outcome: Outcome<'_>,
) -> Value {
    let mut u = unit(vec![Instruction {
        pc: 0x1000,
        next_pc: 0x1003,
        operation,
    }]);
    u.context = context;
    execution_case(&emit(&u), &[0x1000], input, 0xcd7, 0x1000, 2, outcome)
}

#[test]
fn memory_call_captures_the_target_before_the_return_store_and_stages_all_failures() {
    let mut cases = vec![];
    for (read_failed, bad_target, store_failed) in [
        (true, true, true),
        (false, true, true),
        (false, false, true),
        (false, false, false),
    ] {
        let target = if bad_target {
            0x800000000000u64
        } else {
            0x1010
        };
        let success = !read_failed && !bad_target && !store_failed;
        let expected = if success { vec![(4, 0x4018)] } else { vec![] };
        let mut p = packet(
            ExecutionContext::default(),
            Operation::Call {
                target: Operand::Memory(Address {
                    base: AddressBase::Register(4),
                    displacement: -8,
                    segment: Segment::Ss,
                    ..Address::default()
                }),
                width: Width::W64,
            },
            &[(4, 0x4020)],
            (
                &expected,
                0xcd7,
                if success { 0x1010 } else { 0x1000 },
                if success {
                    DISPATCH
                } else if read_failed || store_failed && !bad_target {
                    DATA
                } else {
                    TARGET
                } as u32,
                u64::from(!success) + 1,
            ),
        );
        let mut accesses = vec![
            json!({"kind":"load","args":["4018",8],"result":format!("{target:x}")}),
            json!({"kind":"access_failed","args":[],"result":u32::from(read_failed)}),
        ];
        if !read_failed && !bad_target {
            accesses.push(
                json!({"kind":"store","args":["4018",8,"1003"],"result":u32::from(!store_failed)}),
            );
        }
        p["accesses"] = json!(accesses);
        cases.push(p);
    }
    run_cases(cases);
}

#[test]
fn pop_memory_uses_the_pending_full_stack_bank_without_publishing_it_on_failure() {
    let mut cases = vec![];
    for success in [false, true] {
        for (base, index, destination) in [
            (AddressBase::Register(4), None, "10000"),
            (AddressBase::Register(12), None, "5000"),
            (
                AddressBase::None,
                Some(AddressIndex {
                    register: 4,
                    scale: 2,
                }),
                "20000",
            ),
        ] {
            let expected = if success {
                vec![(4, 0x1122334400010000)]
            } else {
                vec![]
            };
            let mut p = packet(
                context(false),
                Operation::PopMemory {
                    address: Address {
                        base,
                        index,
                        size: Width::W32,
                        segment: Segment::Ss,
                        ..Address::default()
                    },
                    width: Width::W32,
                },
                &[(4, 0x112233440001fffc), (12, 0x5000)],
                (
                    &expected,
                    0xcd7,
                    if success { 0x1003 } else { 0x1000 },
                    if success { DISPATCH } else { SEGMENT } as u32,
                    u64::from(!success) + 1,
                ),
            );
            let mut accesses = vec![
                json!({"kind":"segmented_load","args":["fffc",4,1],"result":"12345678"}),
                json!({"kind":"segmented_access_failed","args":[],"result":0}),
                json!({"kind":"segmented_store","args":[destination,4,"12345678",1],"result":u32::from(success)}),
            ];
            if !success {
                accesses.push(json!({"kind":"access_reason","args":[],"result":SEGMENT}));
            }
            p["accesses"] = json!(accesses);
            cases.push(p);
        }
    }
    run_cases(cases);
}

#[test]
fn leave_reads_the_frame_at_stack_width_before_any_pointer_is_written() {
    let mut cases = vec![];
    for success in [false, true] {
        for (ctx, width, old_sp, bp, address, loaded, new_sp, new_bp, segmented) in [
            (
                ExecutionContext::default(),
                Width::W16,
                0x800000000000,
                0xffff800000004020,
                "ffff800000004020",
                0x7788u64,
                0xffff800000004022,
                0xffff800000007788,
                false,
            ),
            (
                ExecutionContext::default(),
                Width::W64,
                0x800000000000,
                0xffff800000004020,
                "ffff800000004020",
                0x1122334455667788,
                0xffff800000004028,
                0x1122334455667788,
                false,
            ),
            (
                context(true),
                Width::W16,
                0x1122334400abcde0,
                0x99aabbcc00014000,
                "14000",
                0x5678,
                0x1122334400014002,
                0x99aabbcc00015678,
                true,
            ),
            (
                context(false),
                Width::W32,
                0x1122334400014000,
                0x99aabbcc0001fffe,
                "fffe",
                0x5678,
                0x1122334400010002,
                0x99aabbcc00005678,
                true,
            ),
        ] {
            let expected = if success {
                vec![(4, new_sp), (5, new_bp)]
            } else {
                vec![]
            };
            let reason = if success { DISPATCH } else { DATA };
            let mut p = packet(
                ctx,
                Operation::Leave { width },
                &[(4, old_sp), (5, bp)],
                (
                    &expected,
                    0xcd7,
                    if success { 0x1003 } else { 0x1000 },
                    reason as u32,
                    u64::from(!success) + 1,
                ),
            );
            let args = if segmented {
                json!([address, width.bytes(), 1])
            } else {
                json!([address, width.bytes()])
            };
            let mut accesses = vec![
                json!({"kind":if segmented{"segmented_load"}else{"load"},"args":args,"result":format!("{loaded:x}")}),
                json!({"kind":if segmented{"segmented_access_failed"}else{"access_failed"},"args":[],"result":u32::from(!success)}),
            ];
            if segmented && !success {
                accesses.push(json!({"kind":"access_reason","args":[],"result":DATA}));
            }
            p["accesses"] = json!(accesses);
            cases.push(p);
        }
    }
    run_cases(cases);
}

#[test]
fn count_branches_preserve_flags_stage_bad_targets_and_do_not_write_zero_tests() {
    let mut cases = vec![];
    for condition in [
        CountCondition::Always,
        CountCondition::Equal,
        CountCondition::NotEqual,
        CountCondition::Zero,
    ] {
        for flags in [0x897, 0xcd7] {
            for width in [Width::W16, Width::W32, Width::W64] {
                for count in [0, 1, 2] {
                    for raw in [count, 0x1122334400000000 | count] {
                        let selected = raw & width.mask();
                        let decremented = selected.wrapping_sub(1) & width.mask();
                        let taken = match condition {
                            CountCondition::Always => decremented != 0,
                            CountCondition::Equal => decremented != 0 && flags & 0x40 != 0,
                            CountCondition::NotEqual => decremented != 0 && flags & 0x40 == 0,
                            CountCondition::Zero => selected == 0,
                        };
                        for bad in [false, true] {
                            let target = if bad { 0x800000000071 } else { 0x1010 };
                            let failed = taken && bad;
                            let expected = if failed || condition == CountCondition::Zero {
                                vec![]
                            } else {
                                vec![(
                                    1,
                                    if width == Width::W16 {
                                        (raw & !0xffff) | decremented
                                    } else {
                                        decremented
                                    },
                                )]
                            };
                            cases.push(case(
                                vec![Instruction {
                                    pc: 0x1000,
                                    next_pc: 0x1003,
                                    operation: Operation::CountBranch {
                                        condition,
                                        count_width: width,
                                        target,
                                    },
                                }],
                                &[(1, raw)],
                                flags,
                                0x1000,
                                1,
                                (
                                    &expected,
                                    flags,
                                    if failed {
                                        0x1000
                                    } else if taken {
                                        target
                                    } else {
                                        0x1003
                                    },
                                    if failed { TARGET } else { BUDGET } as u32,
                                    u64::from(failed),
                                ),
                            ));
                        }
                    }
                }
            }
        }
    }
    run_cases(cases);
}

#[test]
fn counter_self_loops_are_bounded_and_middle_entries_read_current_state() {
    let instructions = vec![
        Instruction {
            pc: 0x1000,
            next_pc: 0x1005,
            operation: Operation::Mov {
                dst: RegisterView::low(1),
                src: DataOperand::Immediate(5),
                width: Width::W64,
            },
        },
        Instruction {
            pc: 0x1005,
            next_pc: 0x1007,
            operation: Operation::CountBranch {
                condition: CountCondition::Always,
                count_width: Width::W64,
                target: 0x1005,
            },
        },
        Instruction {
            pc: 0x1007,
            next_pc: 0x1008,
            operation: Operation::Carry {
                kind: crate::x86::instruction::Carry::Complement,
            },
        },
    ];
    let mut cases = vec![];
    for (entry, count, budget, remaining, pc, flags) in [
        (0x1000, 99, 3, 3, 0x1005, 0xcd7),
        (0x1005, 0, 3, u64::MAX - 2, 0x1005, 0xcd7),
        (0x1005, 1, 1, 0, 0x1007, 0xcd7),
        (0x1005, 1, 2, 0, 0x1008, 0xcd6),
        (0x1007, 99, 1, 99, 0x1008, 0xcd6),
    ] {
        cases.push(case(
            instructions.clone(),
            &[(1, count)],
            0xcd7,
            entry,
            budget,
            (&[(1, remaining)], flags, pc, BUDGET as u32, 0),
        ));
    }
    run_cases(cases);
}

#[test]
fn mixed_width_count_writes_and_segment_target_faults_use_incoming_banks() {
    let mut cases = vec![];
    for width in [Width::W16, Width::W32] {
        for condition in [CountCondition::Always, CountCondition::Zero] {
            for success in [false, true] {
                let count = if condition == CountCondition::Zero {
                    0
                } else {
                    2
                };
                let raw = 0x1122334400000000 | count;
                let expected = if success && condition != CountCondition::Zero {
                    vec![(1, 0x1122334400000001)]
                } else {
                    vec![]
                };
                let mut p = packet(
                    limited_context(false, if success { u32::MAX } else { 0x1005 }),
                    Operation::CountBranch {
                        condition,
                        count_width: width,
                        target: 0x1010,
                    },
                    &[(1, raw)],
                    (
                        &expected,
                        0xcd7,
                        if success { 0x1010 } else { 0x1000 },
                        if success { DISPATCH } else { SEGMENT } as u32,
                        u64::from(!success) + 1,
                    ),
                );
                p["accesses"] = if success {
                    json!([])
                } else {
                    json!([{"kind":"target_check","args":["1010"],"result":0}])
                };
                cases.push(p);
            }
        }
    }
    run_cases(cases);
}

#[test]
fn code_writing_memory_stack_operations_finish_before_dispatch() {
    let mut cases = vec![];
    for operation in [
        Operation::Call {
            target: Operand::Memory(Address {
                base: AddressBase::Register(4),
                segment: Segment::Ss,
                ..Address::default()
            }),
            width: Width::W64,
        },
        Operation::Push {
            src: Operand::Memory(Address {
                base: AddressBase::Register(4),
                segment: Segment::Ss,
                ..Address::default()
            }),
            width: Width::W64,
        },
        Operation::PopMemory {
            address: Address {
                base: AddressBase::Register(4),
                segment: Segment::Ss,
                ..Address::default()
            },
            width: Width::W64,
        },
    ] {
        let call = matches!(operation, Operation::Call { .. });
        let pop = matches!(operation, Operation::PopMemory { .. });
        let new_sp = if pop { 0x4028 } else { 0x4018 };
        let mut p = packet(
            ExecutionContext::default(),
            operation,
            &[(4, 0x4020)],
            (
                &[(4, new_sp)],
                0xcd7,
                if call { 0x1010 } else { 0x1003 },
                DISPATCH as u32,
                1,
            ),
        );
        p["accesses"] = json!([
            {"kind":"load","args":["4020",8],"result":"1010"},
            {"kind":"access_failed","args":[],"result":0},
            {"kind":"store","args":[format!("{new_sp:x}"),8,if call{"1003"}else{"1010"}],"result":2}
        ]);
        cases.push(p);
    }
    run_cases(cases);
}
