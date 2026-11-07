use super::*;
use crate::embedding::layout::{BUDGET, DATA, DISPATCH, SEGMENT};
use crate::x86::context::{ExecutionContext, Segment};
use crate::x86::instruction::{Address, AddressBase, Bit, BitIndex, Location};

fn context(code32: bool, stack32: bool) -> ExecutionContext {
    let mut segments = serde_json::Map::new();
    for name in ["cs", "ss", "ds", "es", "fs", "gs"] {
        segments.insert(
            name.into(),
            json!({
                "base":"0x0", "limit":u32::MAX,
                "default32":if name == "ss" { stack32 } else { code32 },
                "usable":true, "type":if name == "cs" { "readable-code" } else { "read-write" }
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
    execution_case(&emit(&u), &[0x1000], input, 0x8d7, 0x1000, 2, outcome)
}

#[test]
fn non64_register_writes_preserve_inactive_banks_and_high_dword() {
    let mut cases = vec![];
    for code32 in [false, true] {
        let mut u = unit(vec![Instruction {
            pc: 0x1000,
            next_pc: 0x1005,
            operation: Operation::Mov {
                dst: RegisterView::low(0),
                src: DataOperand::Immediate(0x89abcdef),
                width: Width::W32,
            },
        }]);
        u.context = context(code32, true);
        cases.push(execution_case(
            &emit(&u),
            &[0x1000],
            &[(0, 0xfedcba9876543210)],
            2,
            0x1000,
            1,
            (&[(0, 0xfedcba9889abcdef)], 2, 0x1005, BUDGET as u32, 0),
        ));
    }
    run_cases(cases);
}

#[test]
fn offsets_are_truncated_before_segment_helpers_or_long64_bases() {
    let mut cases = vec![];
    let mut p = packet(
        context(true, true),
        Operation::Load {
            dst: RegisterView::low(0),
            address: Address {
                base: AddressBase::Register(3),
                displacement: 0x30,
                size: Width::W16,
                segment: Segment::Fs,
                ..Address::default()
            },
            width: Width::W32,
        },
        &[(3, 0xaabbccddfffffff0)],
        (
            &[(0, 0x11223344deadbeef)],
            0x8d7,
            0x1003,
            DISPATCH as u32,
            1,
        ),
    );
    p["accesses"] = json!([
        {"kind":"segmented_load","args":["20",4,4],"result":"deadbeef"},
        {"kind":"access_failed","args":[],"result":0}]);
    cases.push(p);

    let long = ExecutionContext::from_json(
        &json!({"mode":"long64","fsBase":"0x100000000","gsBase":"0x0"}),
    )
    .unwrap();
    let mut p = packet(
        long.clone(),
        Operation::Load {
            dst: RegisterView::low(0),
            address: Address {
                base: AddressBase::Register(3),
                displacement: 0x30,
                size: Width::W32,
                segment: Segment::Fs,
                ..Address::default()
            },
            width: Width::W32,
        },
        &[(3, 0x11223344fffffff0)],
        (&[(0, 0xdeadbeef)], 0x8d7, 0x1003, DISPATCH as u32, 1),
    );
    p["accesses"] = json!([
        {"kind":"load","args":["100000020",4],"result":"deadbeef"},
        {"kind":"access_failed","args":[],"result":0}]);
    cases.push(p);

    let mut p = packet(
        long,
        Operation::Bit {
            kind: Bit::Test,
            dst: Location::Memory(Address {
                base: AddressBase::Register(3),
                size: Width::W32,
                segment: Segment::Fs,
                ..Address::default()
            }),
            index: BitIndex::Register(RegisterView::low(1)),
            width: Width::W32,
        },
        &[(3, 0), (1, 0xffffffff)],
        (&[], 0x43, 0x1003, DISPATCH as u32, 1),
    );
    p["accesses"] = json!([
        {"kind":"load","args":["1fffffffc",4],"result":"80000000"},
        {"kind":"access_failed","args":[],"result":0}]);
    cases.push(p);
    run_cases(cases);
}

#[test]
fn stack_slots_and_pointer_widths_remain_independent_including_pop_sp_aliases() {
    let mut cases = vec![];
    for (stack32, width, old, new, offset) in [
        (
            false,
            Width::W32,
            0xaabbccdd76540002,
            0xaabbccdd7654fffe,
            "fffe",
        ),
        (
            true,
            Width::W16,
            0xaabbccdd00000001,
            0xaabbccddffffffff,
            "ffffffff",
        ),
    ] {
        let mut p = packet(
            context(!stack32, stack32),
            Operation::Push {
                src: Operand::Register(4),
                width,
            },
            &[(4, old)],
            (&[(4, new)], 0x8d7, 0x1003, DISPATCH as u32, 1),
        );
        let value = old & width.mask();
        p["accesses"] = json!([{"kind":"segmented_store","args":[offset,width.bytes(),format!("{value:x}"),1],"result":1}]);
        cases.push(p);
    }
    for (stack32, width, old, loaded, new) in [
        (
            true,
            Width::W16,
            0xaabbccdd0000ffff,
            0x7654u64,
            0xaabbccdd00017654,
        ),
        (
            false,
            Width::W32,
            0xaabbccdd7654fffe,
            0x87654321,
            0xaabbccdd87654321,
        ),
    ] {
        let mut p = packet(
            context(true, stack32),
            Operation::Pop { dst: 4, width },
            &[(4, old)],
            (&[(4, new)], 0x8d7, 0x1003, DISPATCH as u32, 1),
        );
        let offset = old & if stack32 { 0xffffffff } else { 0xffff };
        p["accesses"] = json!([
            {"kind":"segmented_load","args":[format!("{offset:x}"),width.bytes(),1],"result":format!("{loaded:x}")},
            {"kind":"access_failed","args":[],"result":0}]);
        cases.push(p);
    }
    run_cases(cases);
}

#[test]
fn segmented_failures_and_target_checks_precede_architectural_commit() {
    let mut cases = vec![];
    for reason in [DATA, SEGMENT] {
        let mut p = packet(
            context(true, false),
            Operation::Pop {
                dst: 4,
                width: Width::W32,
            },
            &[(4, 0xaabbccdd12345678)],
            (&[], 0x8d7, 0x1000, reason as u32, 2),
        );
        p["accesses"] = json!([
            {"kind":"segmented_load","args":["5678",4,1],"result":"0"},
            {"kind":"access_failed","args":[],"result":1},
            {"kind":"access_reason","args":[],"result":reason}]);
        cases.push(p);
    }
    let mut p = packet(
        context(true, true),
        Operation::Call {
            target: Operand::Register(4),
            width: Width::W16,
        },
        &[(4, 0xaabbccddffff2345)],
        (&[], 0x8d7, 0x1000, SEGMENT as u32, 2),
    );
    p["accesses"] = json!([{"kind":"target_check","args":["2345"],"result":0}]);
    cases.push(p);

    let mut p = packet(
        context(true, false),
        Operation::Return {
            cleanup: 0xffff,
            width: Width::W16,
        },
        &[(4, 0xaabbccdd1234ffff)],
        (
            &[(4, 0xaabbccdd12340000)],
            0x8d7,
            0x2345,
            DISPATCH as u32,
            1,
        ),
    );
    p["accesses"] = json!([
        {"kind":"segmented_load","args":["ffff",2,1],"result":"2345"},
        {"kind":"access_failed","args":[],"result":0},
        {"kind":"target_check","args":["2345"],"result":1}]);
    cases.push(p);
    run_cases(cases);
}

#[test]
fn long64_faults_retain_selected_segments_without_hot_path_helper_calls() {
    let mut cases = vec![];
    for segment in [Segment::Ss, Segment::Ds, Segment::Fs] {
        let mut p = packet(
            ExecutionContext::default(),
            Operation::Load {
                dst: RegisterView::low(0),
                address: Address {
                    base: AddressBase::Register(5),
                    segment,
                    ..Address::default()
                },
                width: Width::W32,
            },
            &[(5, 0x8000)],
            (&[], 0x8d7, 0x1000, DATA as u32, 2),
        );
        p["accesses"] = json!([
            {"kind":"load","args":["8000",4],"result":"0"},
            {"kind":"access_failed","args":[],"result":1}]);
        p["faultSegment"] = json!(segment as u32);
        cases.push(p);
    }
    run_cases(cases);
}

#[test]
fn non64_code_writing_call_commits_stack_target_and_retirement_before_exit() {
    let mut p = packet(
        context(true, false),
        Operation::Call {
            target: Operand::Register(4),
            width: Width::W32,
        },
        &[(4, 0xaabbccdd00002004)],
        (
            &[(4, 0xaabbccdd00002000)],
            0x8d7,
            0x2004,
            DISPATCH as u32,
            1,
        ),
    );
    p["accesses"] = json!([
        {"kind":"target_check","args":["2004"],"result":1},
        {"kind":"segmented_store","args":["2000",4,"1003",1],"result":2}]);
    run_cases(vec![p]);
}
