use super::*;
use crate::embedding::layout::{DEBUG_EXCEPTION, DISPATCH, PROTECTION};
use crate::x86::context::{Mode, Segment};
use crate::x86::instruction::{Address, AddressBase, PagingInstruction as Paging};

#[test]
fn paging_helpers_receive_live_operands_and_publish_one_completed_boundary() {
    let mut cases = Vec::new();
    for (operation, input, expected, call, reply, mode) in [
        (
            Paging::ControlRegister {
                register: 2,
                gpr: 0,
                write: false,
                width: Width::W32,
            },
            vec![(0, 0x1122334400000000)],
            vec![(0, 0x1122334476543210)],
            json!([0, 2, "0", "1000", "8d7"]),
            json!({"reason":0,"value":"fedcba9876543210"}),
            Mode::Compatibility,
        ),
        (
            Paging::ControlRegister {
                register: 0,
                gpr: 9,
                write: false,
                width: Width::W64,
            },
            vec![],
            vec![(9, 0x80000033)],
            json!([0, 0, "0", "1000", "8d7"]),
            json!({"reason":0,"value":"80000033"}),
            Mode::Long64,
        ),
        (
            Paging::ControlRegister {
                register: 3,
                gpr: 15,
                write: true,
                width: Width::W64,
            },
            vec![(15, 0x12345018)],
            vec![],
            json!([1, 3, "12345018", "1000", "8d7"]),
            json!({"reason":0}),
            Mode::Long64,
        ),
        (
            Paging::ModelSpecificRegister { write: false },
            vec![(0, u64::MAX), (2, u64::MAX), (1, 0x99887766c0000080)],
            vec![(0, 0x500), (2, 0)],
            json!([2, -1073741696i64, "0", "1000", "8d7"]),
            json!({"reason":0,"value":"500"}),
            Mode::Compatibility,
        ),
        (
            Paging::ModelSpecificRegister { write: true },
            vec![
                (0, 0x8877665500000d00),
                (2, 0x1122334400000000),
                (1, 0xc0000080),
            ],
            vec![],
            json!([3, -1073741696i64, "d00", "1000", "8d7"]),
            json!({"reason":0}),
            Mode::Long64,
        ),
        (
            Paging::InvalidatePage(Address {
                base: AddressBase::Register(5),
                index: None,
                displacement: 0x1000,
                size: Width::W32,
                segment: Segment::Fs,
            }),
            vec![(5, 0xffff000000001000)],
            vec![],
            json!([4, 4, "2000", "1000", "8d7"]),
            json!({"reason":0}),
            Mode::Long64,
        ),
    ] {
        let mut unit = unit(vec![Instruction {
            pc: 0x1000,
            next_pc: 0x1003,
            operation: Operation::Paging(operation),
        }]);
        unit.context.set_mode_and_cpl(mode, 0);
        let mut packet = execution_case(
            &emit(&unit),
            &[0x1000],
            &input,
            0x8d7,
            0x1000,
            2,
            (&expected, 0x8d7, 0x1003, DISPATCH as u32, 1),
        );
        packet["accesses"] = json!([{"kind":"paging_control","args":call,"result":reply}]);
        cases.push(packet);
    }
    run_cases(cases);
}

#[test]
fn paging_failure_preserves_boundary_and_tf_completion_precedes_post_budget() {
    let unit = unit(vec![Instruction {
        pc: 0x1000,
        next_pc: 0x1003,
        operation: Operation::Paging(Paging::ControlRegister {
            register: 2,
            gpr: 0,
            write: false,
            width: Width::W64,
        }),
    }]);
    let mut refusal = execution_case(
        &emit(&unit),
        &[0x1000],
        &[],
        2,
        0x1000,
        2,
        (&[], 2, 0x1000, PROTECTION as u32, 2),
    );
    refusal["accesses"] = json!([{"kind":"paging_control","args":[0,2,"0","1000","2"],"result":{"reason":PROTECTION}}]);
    let mut trap = execution_case(
        &emit_observed(&unit, true),
        &[0x1000],
        &[],
        0x302,
        0x1000,
        1,
        (&[(0, 0x1234)], 0x302, 0x1003, DEBUG_EXCEPTION as u32, 0),
    );
    trap["accesses"] = json!([
        {"kind":"paging_control","args":[0,2,"0","1000","302"],"result":{"reason":0,"value":"1234"}},
        {"kind":"debug_step","args":["1000","1003",1,"302"],"result":DEBUG_EXCEPTION}
    ]);
    run_cases(vec![refusal, trap]);
}
