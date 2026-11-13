use super::*;
use crate::embedding::layout::{BUDGET, PROTECTION, STOP};
use crate::x86::processor::Instruction as Processor;

fn time(mut packet: Value, before: u64, after: u64) -> Value {
    packet["time"] = json!({"tsc":before.to_string(),"tscAux":0x89abcdefu32});
    packet["expected"]["time"] = json!({"tsc":after.to_string(),"tscAux":0x89abcdefu32});
    packet
}

#[test]
fn ordinary_units_settle_time_once_with_zero_work_wrap_and_huge_original_budgets() {
    let instructions = vec![
        Instruction {
            pc: 0x1000,
            next_pc: 0x1001,
            operation: Operation::Nop,
        },
        Instruction {
            pc: 0x1001,
            next_pc: 0x1002,
            operation: Operation::Nop,
        },
    ];
    let mut packets = vec![];
    for (budget, stop, pc, reason, remaining, after) in [
        (0, None, 0x1000, BUDGET, 0, u64::MAX),
        (1, None, 0x1001, BUDGET, 0, 0),
        (2, None, 0x1002, BUDGET, 0, 1),
        (1 << 32, Some(0x1001), 0x1001, STOP, (1 << 32) - 1, 0),
        (u64::MAX, Some(0x1002), 0x1002, STOP, u64::MAX - 2, 1),
    ] {
        let mut packet = time(
            case(
                instructions.clone(),
                &[],
                2,
                0x1000,
                budget,
                (&[], 2, pc, reason as u32, remaining),
            ),
            u64::MAX,
            after,
        );
        if let Some(stop) = stop {
            packet["stop"] = json!(format!("{stop:x}"));
        }
        packets.push(packet);
    }
    run_cases(packets);
}

#[test]
fn processor_helpers_receive_live_inputs_and_delta_and_zero_extend_full_outputs() {
    let mut packets = vec![];
    for (operation, outputs, args, words) in [
        (
            Processor::Cpuid,
            vec![(0, 7), (3, 0x676e6952), (1, 0x656e6967), (2, 0x6e453436)],
            json!([0, 0, 7, "1"]),
            json!([7, 0x676e6952u32, 0x656e6967u32, 0x6e453436u32]),
        ),
        (
            Processor::Rdtsc,
            vec![(0, 0x76543210), (2, 0xfedcba98)],
            json!([1, 0, 7, "1"]),
            json!([0x76543210u32, 0xfedcba98u32, 0x89abcdefu32]),
        ),
        (
            Processor::Rdtscp,
            vec![(0, 0x76543210), (2, 0xfedcba98), (1, 0x89abcdef)],
            json!([2, 0, 7, "1"]),
            json!([0x76543210u32, 0xfedcba98u32, 0x89abcdefu32]),
        ),
    ] {
        for legacy in [false, true] {
            let instructions = vec![
                Instruction {
                    pc: 0x1000,
                    next_pc: 0x1005,
                    operation: Operation::Mov {
                        dst: RegisterView::low(0),
                        src: DataOperand::Immediate(0),
                        width: Width::W32,
                    },
                },
                Instruction {
                    pc: 0x1005,
                    next_pc: 0x1008,
                    operation: Operation::Processor(operation),
                },
            ];
            let mut unit = unit(instructions);
            if legacy {
                unit.context
                    .set_mode_and_cpl(crate::x86::context::Mode::Compatibility, 0);
            }
            let mut packet = time(
                execution_case(
                    &emit(&unit),
                    &[0x1000, 0x1005],
                    &[
                        (0, u64::MAX),
                        (1, 0x1122334400000007),
                        (2, u64::MAX),
                        (3, u64::MAX),
                    ],
                    2,
                    0x1000,
                    2,
                    (&outputs, 2, 0x1008, BUDGET as u32, 0),
                ),
                100,
                102,
            );
            packet["accesses"] =
                json!([{"kind":"processor","args":args,"result":{"reason":0,"words":words}}]);
            packets.push(packet);
        }
    }
    run_cases(packets);
}

#[test]
fn timestamp_refusal_preserves_outputs_and_only_settles_prior_retirement() {
    let instructions = vec![
        Instruction {
            pc: 0x1000,
            next_pc: 0x1001,
            operation: Operation::Nop,
        },
        Instruction {
            pc: 0x1001,
            next_pc: 0x1004,
            operation: Operation::Processor(Processor::Rdtscp),
        },
    ];
    let mut packet = time(
        case(
            instructions,
            &[(0, u64::MAX), (1, 7)],
            2,
            0x1000,
            3,
            (&[], 2, 0x1001, PROTECTION as u32, 2),
        ),
        100,
        101,
    );
    packet["accesses"] =
        json!([{"kind":"processor","args":[2,-1,7,"1"],"result":{"reason":PROTECTION}}]);
    run_cases(vec![packet]);
}

#[test]
fn selected_msr_write_receives_live_delta_and_epilogue_uses_the_rebased_bank() {
    let instructions = vec![
        Instruction {
            pc: 0x1000,
            next_pc: 0x1001,
            operation: Operation::Nop,
        },
        Instruction {
            pc: 0x1001,
            next_pc: 0x1003,
            operation: Operation::Paging(
                crate::x86::instruction::PagingInstruction::ModelSpecificRegister { write: true },
            ),
        },
    ];
    let mut packet = time(
        case(
            instructions,
            &[(0, u64::MAX), (1, 0x10), (2, u64::MAX)],
            2,
            0x1000,
            u64::MAX,
            (&[], 2, 0x1003, 0, u64::MAX - 2),
        ),
        100,
        u64::MAX,
    );
    // The independent helper reply rebases W=MAX at delta1 to MAX-2.
    packet["accesses"] = json!([{"kind":"paging_control","args":[3,0x10,"ffffffffffffffff","1001","2","1"],
        "result":{"reason":0,"timeBase":(u64::MAX-2).to_string()}}]);
    run_cases(vec![packet]);
}

#[test]
fn partial_repeat_has_no_tick_until_middle_entry_completion_and_zero_count_retires() {
    use crate::x86::{
        context::Segment,
        instruction::{Repeat, StringKind},
    };
    let instructions = vec![
        Instruction {
            pc: 0x1000,
            next_pc: 0x1001,
            operation: Operation::Nop,
        },
        Instruction {
            pc: 0x1001,
            next_pc: 0x1003,
            operation: Operation::String {
                kind: StringKind::Lods,
                width: Width::W8,
                address_width: Width::W64,
                source_segment: Segment::Ds,
                repeat: Repeat::Count,
            },
        },
        Instruction {
            pc: 0x1003,
            next_pc: 0x1006,
            operation: Operation::Processor(Processor::Rdtscp),
        },
    ];
    let mut partial = time(
        case(
            instructions.clone(),
            &[(0, 0x1122334400000000), (1, 3), (6, 0x4000)],
            2,
            0x1000,
            3,
            (
                &[(0, 0x1122334400000005), (1, 2), (6, 0x4001)],
                2,
                0x1001,
                11,
                2,
            ),
        ),
        100,
        101,
    );
    partial["repeatBudget"] = json!("1");
    partial["expected"]["repeatRemaining"] = json!("0");
    partial["accesses"] = json!([
        {"kind":"load","args":["4000",1],"result":"5"},
        {"kind":"access_failed","args":[],"result":0},
    ]);
    let mut complete = time(
        case(
            instructions.clone(),
            &[(0, 0x1122334400000005), (1, 2), (6, 0x4001)],
            2,
            0x1001,
            2,
            (
                &[(0, 102), (1, 0x89abcdef), (2, 0), (6, 0x4003)],
                2,
                0x1006,
                BUDGET as u32,
                0,
            ),
        ),
        101,
        103,
    );
    complete["repeatBudget"] = json!("2");
    complete["expected"]["repeatRemaining"] = json!("0");
    complete["accesses"] = json!([
        {"kind":"load","args":["4001",1],"result":"6"},
        {"kind":"access_failed","args":[],"result":0},
        {"kind":"load","args":["4002",1],"result":"7"},
        {"kind":"access_failed","args":[],"result":0},
        {"kind":"processor","args":[2,7,0,"1"],"result":{"reason":0,"words":[102,0,0x89abcdefu32]}},
    ]);
    let mut zero = time(
        case(
            instructions,
            &[(0, 9), (1, 0)],
            2,
            0x1001,
            2,
            (
                &[(0, 101), (1, 0x89abcdef), (2, 0)],
                2,
                0x1006,
                BUDGET as u32,
                0,
            ),
        ),
        100,
        102,
    );
    zero["repeatBudget"] = json!("0");
    zero["expected"]["repeatRemaining"] = json!("0");
    zero["accesses"] = json!([
        {"kind":"processor","args":[2,9,0,"1"],"result":{"reason":0,"words":[101,0,0x89abcdefu32]}},
    ]);
    run_cases(vec![partial, complete, zero]);
}

#[test]
fn completed_prefix_survives_data_and_target_faults_without_crediting_the_failed_instruction() {
    use crate::embedding::layout::{DATA, TARGET};
    use crate::x86::instruction::{Address, AddressBase};
    let nop = Instruction {
        pc: 0x1000,
        next_pc: 0x1001,
        operation: Operation::Nop,
    };
    let mut data = time(
        case(
            vec![
                nop,
                Instruction {
                    pc: 0x1001,
                    next_pc: 0x1004,
                    operation: Operation::Load {
                        dst: RegisterView::low(0),
                        width: Width::W64,
                        address: Address {
                            base: AddressBase::Register(3),
                            ..Address::default()
                        },
                    },
                },
            ],
            &[(3, 0x4000)],
            2,
            0x1000,
            u64::MAX,
            (&[], 2, 0x1001, DATA as u32, u64::MAX - 1),
        ),
        u64::MAX,
        0,
    );
    data["accesses"] = json!([
        {"kind":"load","args":["4000",8],"result":"0"},
        {"kind":"access_failed","args":[],"result":1},
    ]);
    let mut target = time(
        case(
            vec![
                nop,
                Instruction {
                    pc: 0x1001,
                    next_pc: 0x1003,
                    operation: Operation::JumpRegister {
                        target: 0,
                        width: Width::W64,
                    },
                },
            ],
            &[(0, 0x800000000000)],
            2,
            0x1000,
            u64::MAX,
            (&[], 2, 0x1001, TARGET as u32, u64::MAX - 1),
        ),
        100,
        101,
    );
    target["target"] = json!("800000000000");
    run_cases(vec![data, target]);
}

#[test]
fn code_alias_retirement_settles_before_dispatching_away_from_the_stale_suffix() {
    let artifact = compiled_fixture(0x1000, &[0x90, 0xc6, 0x03, 0x90, 0x0f, 0x01, 0xf9], 0x1000);
    let mut packet = time(
        execution_case(
            &artifact.bytes,
            &artifact.entries,
            &[(3, 0x1004)],
            2,
            0x1000,
            3,
            (&[], 2, 0x1004, 0, 1),
        ),
        100,
        102,
    );
    packet["accesses"] = json!([
        {"kind":"store","args":["1004",1,"90"],"result":2},
    ]);
    run_cases(vec![packet]);
}

#[test]
fn processor_tf_completion_clears_rf_and_settles_once_before_exposing_debug_outputs() {
    use crate::embedding::layout::DEBUG_EXCEPTION;
    let mut packets = vec![];
    for (operation, outputs, words) in [
        (
            Processor::Cpuid,
            vec![(0, 7), (3, 0x676e6952), (1, 0x656e6967), (2, 0x6e453436)],
            json!([7, 0x676e6952u32, 0x656e6967u32, 0x6e453436u32]),
        ),
        (
            Processor::Rdtsc,
            vec![(0, 100), (2, 0)],
            json!([100, 0, 0x89abcdefu32]),
        ),
        (
            Processor::Rdtscp,
            vec![(0, 100), (2, 0), (1, 0x89abcdef)],
            json!([100, 0, 0x89abcdefu32]),
        ),
    ] {
        let u = unit(vec![Instruction {
            pc: 0x1000,
            next_pc: 0x1003,
            operation: Operation::Processor(operation),
        }]);
        let mut packet = time(
            execution_case(
                &emit_observed(&u, true),
                &[0x1000],
                &[
                    (0, 0x1122334400000000),
                    (1, 0x1122334400000007),
                    (2, u64::MAX),
                    (3, u64::MAX),
                ],
                0x10302,
                0x1000,
                1,
                (&outputs, 0x302, 0x1003, DEBUG_EXCEPTION as u32, 0),
            ),
            100,
            101,
        );
        packet["accesses"] = json!([
            {"kind":"processor","args":[operation as u32,0,7,"0"],"result":{"reason":0,"words":words}},
            {"kind":"debug_step","args":["1000","1003",1,"302"],"result":DEBUG_EXCEPTION},
        ]);
        packets.push(packet);
    }
    run_cases(packets);
}

#[test]
fn processor_shadow_completion_settles_before_external_acceptance_and_last_budget_gate() {
    use crate::embedding::layout::PENDING_INTERRUPT;
    let mut packets = vec![];
    for (operation, outputs, words) in [
        (
            Processor::Cpuid,
            vec![(0, 7), (3, 0x676e6952), (1, 0x656e6967), (2, 0x6e453436)],
            json!([7, 0x676e6952u32, 0x656e6967u32, 0x6e453436u32]),
        ),
        (
            Processor::Rdtsc,
            vec![(0, 100), (2, 0)],
            json!([100, 0, 0x89abcdefu32]),
        ),
        (
            Processor::Rdtscp,
            vec![(0, 100), (2, 0), (1, 0x89abcdef)],
            json!([100, 0, 0x89abcdefu32]),
        ),
    ] {
        let u = unit(vec![Instruction {
            pc: 0x1000,
            next_pc: 0x1003,
            operation: Operation::Processor(operation),
        }]);
        let mut packet = time(
            execution_case(
                &emit_observed(&u, true),
                &[0x1000],
                &[(0, 0), (1, 7)],
                0x202,
                0x1000,
                1,
                (&outputs, 0x202, 0x1003, PENDING_INTERRUPT as u32, 0),
            ),
            100,
            101,
        );
        packet["interruptibility"] = json!(2);
        packet["expected"]["interruptibility"] = json!(0);
        packet["irq"] = json!(0x20);
        packet["accesses"] = json!([
            {"kind":"processor","args":[operation as u32,0,7,"0"],"result":{"reason":0,"words":words}},
            {"kind":"external_step","args":["1003","202",0],"result":PENDING_INTERRUPT},
        ]);
        packets.push(packet);
    }
    run_cases(packets);
}
