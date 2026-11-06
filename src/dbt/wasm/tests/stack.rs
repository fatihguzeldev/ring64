use super::*;
use crate::embedding::layout::{BUDGET, DATA, DISPATCH, TARGET};

fn packet(
    operation: Operation,
    input: &[(usize, u64)],
    expected: &[(usize, u64)],
    pc: u64,
    reason: i32,
    remaining: u64,
) -> Value {
    case(
        vec![Instruction {
            pc: 0x1000,
            next_pc: 0x1003,
            operation,
        }],
        input,
        0x8d7,
        0x1000,
        1,
        (expected, 0x8d7, pc, reason as u32, remaining),
    )
}

#[test]
fn stack_publication_follows_checked_access_and_preserves_aliases() {
    let mut cases = vec![];
    for success in [false, true] {
        for (src, value) in [
            (Operand::Register(4), 0x4020),
            (Operand::Immediate(u64::MAX), u64::MAX),
        ] {
            let expected = if success { vec![(4, 0x4018)] } else { vec![] };
            let mut p = packet(
                Operation::Push { src },
                &[(4, 0x4020)],
                &expected,
                if success { 0x1003 } else { 0x1000 },
                if success { BUDGET } else { DATA },
                u64::from(!success),
            );
            p["accesses"] = json!([{"kind":"store","args":["4018",8,format!("{value:x}")],"result":u32::from(success)}]);
            cases.push(p);
        }
        for dst in [0, 4, 12] {
            let mut expected = vec![];
            if success {
                expected.push((4, 0x4028));
                expected.push((dst, 0xfedcba9876543210));
            }
            let mut p = packet(
                Operation::Pop { dst: dst as u8 },
                &[(4, 0x4020)],
                &expected,
                if success { 0x1003 } else { 0x1000 },
                if success { BUDGET } else { DATA },
                u64::from(!success),
            );
            p["accesses"] = json!([
                {"kind":"load","args":["4020",8],"result":"fedcba9876543210"},
                {"kind":"access_failed","args":[],"result":u32::from(!success)}]);
            cases.push(p);
        }
    }
    run_cases(cases);
}

#[test]
fn runtime_targets_are_checked_before_stack_or_architectural_commit() {
    let mut cases = vec![];
    for bad in [0x800000000000, 0xffff7fff12345678] {
        for (operation, input, reads) in [
            (
                Operation::Call {
                    target: Operand::Register(4),
                },
                vec![(4, bad)],
                false,
            ),
            (
                Operation::JumpRegister { target: 12 },
                vec![(4, 0x7000), (12, bad)],
                false,
            ),
            (
                Operation::Return { cleanup: 0xffff },
                vec![(4, 0x4020)],
                true,
            ),
        ] {
            let mut p = packet(operation, &input, &[], 0x1000, TARGET, 1);
            p["target"] = json!(format!("{bad:x}"));
            if reads {
                p["accesses"] = json!([
                {"kind":"load","args":["4020",8],"result":format!("{bad:x}")},
                {"kind":"access_failed","args":[],"result":0}]);
            }
            cases.push(p);
        }
    }
    let mut p = packet(
        Operation::Call {
            target: Operand::Register(4),
        },
        &[(4, 0x4020)],
        &[(4, 0x4018)],
        0x4020,
        BUDGET,
        0,
    );
    p["accesses"] = json!([{"kind":"store","args":["4018",8,"1003"],"result":1}]);
    cases.push(p);
    for (succeeded, read_failed) in [(false, true), (false, false), (true, false)] {
        let loaded = if succeeded {
            "ffff800000001010"
        } else {
            "800000000000"
        };
        let expected = if succeeded { vec![(4, 0xc027)] } else { vec![] };
        let mut p = packet(
            Operation::Return { cleanup: 0x7fff },
            &[(4, 0x4020)],
            &expected,
            if succeeded {
                0xffff800000001010
            } else {
                0x1000
            },
            if succeeded {
                BUDGET
            } else if read_failed {
                DATA
            } else {
                TARGET
            },
            u64::from(!succeeded),
        );
        p["accesses"] = json!([
            {"kind":"load","args":["4020",8],"result":loaded},
            {"kind":"access_failed","args":[],"result":u32::from(read_failed)}]);
        cases.push(p);
    }
    // Remaining budget exposes the dynamic dispatcher path, rather than only a
    // final budget gate. No native or host recursion is introduced by a CALL.
    let mut p = case(
        vec![Instruction {
            pc: 0x1000,
            next_pc: 0x1002,
            operation: Operation::JumpRegister { target: 0 },
        }],
        &[(0, 0xffff800000001010)],
        0x8d7,
        0x1000,
        2,
        (&[], 0x8d7, 0xffff800000001010, DISPATCH as u32, 1),
    );
    p["accesses"] = json!([]);
    cases.push(p);
    run_cases(cases);
}
