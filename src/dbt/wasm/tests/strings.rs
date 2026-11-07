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
        (StringKind::Movs, json!([
            {"kind":"load","args":["4000",1],"result":"7b"},
            {"kind":"access_failed","args":[],"result":0},
            {"kind":"store","args":["5000",1,"7b"],"result":1}
        ]), vec![(6, 0x4001), (7, 0x5001)], 0x8d7),
        (StringKind::Stos, json!([
            {"kind":"store","args":["5000",1,"88"],"result":1}
        ]), vec![(7, 0x5001)], 0x8d7),
        (StringKind::Lods, json!([
            {"kind":"load","args":["4000",1],"result":"7b"},
            {"kind":"access_failed","args":[],"result":0}
        ]), vec![(0, 0x112233445566777b), (6, 0x4001)], 0x8d7),
        (StringKind::Cmps, json!([
            {"kind":"load","args":["4000",1],"result":"5"},
            {"kind":"access_failed","args":[],"result":0},
            {"kind":"load","args":["5000",1],"result":"6"},
            {"kind":"access_failed","args":[],"result":0}
        ]), vec![(6, 0x4001), (7, 0x5001)], 0x97),
        (StringKind::Scas, json!([
            {"kind":"load","args":["5000",1],"result":"88"},
            {"kind":"access_failed","args":[],"result":0}
        ]), vec![(7, 0x5001)], 0x46),
    ] {
        let mut p = case(vec![string(kind, Width::W8, Repeat::None)],
            &[(0, 0x1122334455667788), (1, 0), (6, 0x4000), (7, 0x5000)],
            0x8d7, 0x1000, 1, (&expected, flags, 0x1002, BUDGET as u32, 0));
        p["accesses"] = accesses;
        cases.push(p);
    }
    run_cases(cases);
}

#[test]
fn bare_movs_destination_failure_leaves_the_element_uncommitted() {
    let mut p = case(vec![string(StringKind::Movs, Width::W32, Repeat::None)],
        &[(6, 0x4000), (7, 0x5000)], 0xcd7, 0x1000, 1,
        (&[], 0xcd7, 0x1000, DATA as u32, 1));
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
        (StringKind::Lods, Repeat::Count, 1, 3, vec![(0x4000, 5)],
            vec![(0, 0x1122334400000005), (6, 0x4001), (1, 2)], 2, 0x1000, 11, 1),
        (StringKind::Lods, Repeat::Count, 0, 3, vec![], vec![], 2, 0x1000, 11, 1),
        (StringKind::Lods, Repeat::Count, 0, 0, vec![], vec![], 2, 0x1002, 1, 0),
        (StringKind::Cmps, Repeat::WhileEqual, 2, 3,
            vec![(0x4000,5),(0x5000,5),(0x4001,6),(0x5001,7)],
            vec![(6,0x4002),(7,0x5002),(1,1)],0x97,0x1002,1,0),
        (StringKind::Cmps, Repeat::WhileEqual, 2, 3,
            vec![(0x4000,5),(0x5000,5),(0x4001,6),(0x5001,6)],
            vec![(6,0x4002),(7,0x5002),(1,1)],2,0x1000,11,1),
        (StringKind::Scas, Repeat::WhileNotEqual, 1, 3,
            vec![(0x5000,0)], vec![(7,0x5001),(1,2)],0x46,0x1002,1,0),
    ] {
        let mut p = case(vec![string(kind, Width::W8, repeat)],
            &[(0,0x1122334400000000),(1,count),(6,0x4000),(7,0x5000)], 2, 0x1000, 1,
            (&expected,flags,pc,reason,remaining));
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
    let mut p = case(vec![Instruction {
        pc:0x1000, next_pc:0x1002, operation:Operation::Alu {
            kind:Alu::Add, dst:RegisterView::low(0), src:DataOperand::Immediate(1), width:Width::W8
        }}, Instruction { pc:0x1002,next_pc:0x1004,..string(StringKind::Cmps,Width::W8,Repeat::WhileEqual)}],
        &[(0,0x7f),(1,3),(6,0x4000),(7,0x5000)],2,0x1000,2,
        (&[(0,0x80),(1,1),(6,0x4002),(7,0x5002)],0x892,0x1002,DATA as u32,1));
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
