use super::*;
use crate::embedding::layout::{BUDGET, DATA, X87_EXCEPTION};
use crate::x86::context::Segment;
use crate::x86::instruction::{
    ProtectionInstruction, ProtectionKind, SystemFlagsDescriptor, SystemFlagsKind,
};
use crate::x86::x87::{Format, Kind, Op as Numeric};

#[test]
fn immutable_system_and_shadow_values_are_not_live_after_the_fast_entry_guard() {
    for (operation, observed, system_live, shadow_live) in [
        (Operation::Nop, false, false, false),
        (Operation::Nop, true, true, true),
        (
            Operation::SystemFlags(SystemFlagsDescriptor {
                kind: SystemFlagsKind::Push,
                width: Width::W64,
            }),
            false,
            true,
            true,
        ),
        (
            Operation::Protection(ProtectionInstruction {
                kind: ProtectionKind::LoadSegment(Segment::Ss),
                operand: crate::x86::instruction::Location::Register(RegisterView::low(0)),
                register: 0,
                width: Width::W16,
            }),
            false,
            false,
            true,
        ),
    ] {
        let bytes = emit_observed(
            &unit(vec![Instruction {
                pc: 0x1000,
                next_pc: 0x1001,
                operation,
            }]),
            observed,
        );
        wasmparser::Validator::new().validate_all(&bytes).unwrap();
        let mut after_loop = false;
        let mut live_system = false;
        let mut live_shadow = false;
        for payload in wasmparser::Parser::new(0).parse_all(&bytes) {
            if let wasmparser::Payload::CodeSectionEntry(body) = payload.unwrap() {
                for operator in body.get_operators_reader().unwrap() {
                    match operator.unwrap() {
                        wasmparser::Operator::Loop { .. } => after_loop = true,
                        wasmparser::Operator::LocalGet {
                            local_index: SYSTEM,
                        } if after_loop => live_system = true,
                        wasmparser::Operator::LocalGet {
                            local_index: SHADOW,
                        } if after_loop => live_shadow = true,
                        _ => {}
                    }
                }
            }
        }
        assert_eq!(
            (live_system, live_shadow),
            (system_live, shadow_live),
            "{operation:?} observed={observed}"
        );
    }
}

#[test]
fn canonical_flag_writing_compares_preserve_live_controls_before_later_fault_publication() {
    let mut cases = vec![];
    for (opcode, kind, encoding) in [
        (0xf1, Kind::CompareFlags, 0x3f1),
        (0xe9, Kind::CompareUnorderedFlags, 0x3e9),
    ] {
        for wait in [false, true] {
            let mut code = vec![0xdb, opcode];
            code.extend_from_slice(if wait {
                &[0x9b][..]
            } else {
                &[0x31, 0xc0, 0x8b, 0x03][..]
            });
            let a = compiled_fixture(0x1000, &code, 0x1000);
            let expected = if wait { vec![] } else { vec![(0, 0)] };
            let mut p = execution_case(
                &a.bytes,
                &a.entries,
                &[(0, 0x1122334455667788), (3, 0x7000)],
                0x3c7ed7,
                0x1000,
                if wait { 2 } else { 3 },
                (
                    &expected,
                    if wait { 0x3c7603 } else { 0x3c7646 },
                    if wait { 0x1002 } else { 0x1004 },
                    if wait {
                        X87_EXCEPTION as u32
                    } else {
                        DATA as u32
                    },
                    1,
                ),
            );
            let op = Numeric {
                kind,
                format: Format::Register,
                index: 1,
                encoding,
                ..Numeric::default()
            }
            .encode();
            let mut accesses = vec![
                json!({"kind":"x87","args":[op,"0",Segment::Ds as u32,"1000","3c7ed7","1122334455667788"],"result":{"reason":0,"flags":"3c7603"}}),
            ];
            if wait {
                let wait = Numeric {
                    kind: Kind::Wait,
                    format: Format::None,
                    ..Numeric::default()
                }
                .encode();
                accesses.push(json!({"kind":"x87","args":[wait,"0",Segment::Ds as u32,"1002","3","1122334455667788"],"result":{"reason":X87_EXCEPTION}}));
            } else {
                accesses.extend([
                    json!({"kind":"load","args":["7000",4],"result":"0"}),
                    json!({"kind":"access_failed","args":[],"result":1}),
                ]);
            }
            p["accesses"] = json!(accesses);
            cases.push(p);
        }
    }
    run_cases(cases);
}

#[test]
fn unchanged_controls_survive_a_nonwriting_helper_failure_and_a_live_direction_change() {
    let code = [0xfc, 0x9b];
    let a = compiled_fixture(0x1000, &code, 0x1000);
    let mut p = execution_case(
        &a.bytes,
        &a.entries,
        &[],
        0x3c7ed7,
        0x1000,
        2,
        (&[], 0x3c7ad7, 0x1001, X87_EXCEPTION as u32, 1),
    );
    let wait = Numeric {
        kind: Kind::Wait,
        format: Format::None,
        ..Numeric::default()
    }
    .encode();
    p["accesses"] = json!([{"kind":"x87","args":[wait,"0",Segment::Ds as u32,"1001","8d7","1122334400000000"],"result":{"reason":X87_EXCEPTION}}]);
    run_cases(vec![p]);
    let a = compiled_fixture(0x1000, &[0xfc, 0x90], 0x1000);
    run_cases(vec![execution_case(
        &a.bytes,
        &a.entries,
        &[],
        0x3c7ed7,
        0x1000,
        2,
        (&[], 0x3c7ad7, 0x1002, BUDGET as u32, 0),
    )]);
}
