use super::*;
use crate::embedding::layout::{BUDGET, DATA, DISPATCH, SEGMENT};
use crate::x86::compound_stack::{CompoundStack, CompoundStackKind};

#[test]
fn compound_helper_import_and_spills_are_absent_from_unrelated_units() {
    for selected in [false, true] {
        let bytes = emit(&unit(vec![Instruction {
            pc: 0x1000,
            next_pc: 0x1004,
            operation: if selected {
                Operation::CompoundStack(CompoundStack {
                    kind: CompoundStackKind::Enter {
                        allocation: 0,
                        nesting: 0,
                    },
                    width: Width::W64,
                })
            } else {
                Operation::Nop
            },
        }]));
        wasmparser::Validator::new().validate_all(&bytes).unwrap();
        let mut imports = vec![];
        for payload in wasmparser::Parser::new(0).parse_all(&bytes) {
            if let wasmparser::Payload::ImportSection(reader) = payload.unwrap() {
                for import in reader.into_imports() {
                    imports.push(import.unwrap().name.to_owned());
                }
            }
        }
        assert_eq!(
            imports.iter().any(|name| name == "compound_stack"),
            selected
        );
    }
}

#[test]
fn compound_helper_receives_live_banks_and_failure_prefix_survives_common_exit() {
    for (status, pc, remaining, reason) in [
        (0, 0x100e, 0, BUDGET),
        (2, 0x100e, 1, DISPATCH),
        (DATA, 0x100a, 1, DATA),
        (SEGMENT, 0x100a, 1, SEGMENT),
    ] {
        let code = [
            0x48, 0xbf, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11, 0xc8, 0, 0, 0, 0x90,
        ];
        let a = compiled_fixture(0x1000, &code, 0x1000);
        let budget = if status == 0 { 2 } else { 3 };
        let changed = status != DATA;
        let di = if changed {
            0x123456789abcdef0
        } else {
            0x1122334455667788
        };
        let left = if status == SEGMENT || status == DATA {
            budget - 1
        } else {
            remaining
        };
        let mut p = execution_case(
            &a.bytes,
            &a.entries,
            &[],
            0x40202,
            0x1000,
            budget,
            (&[(7, di)], 0x40202, pc, reason as u32, left),
        );
        p["accesses"] = json!([{"kind":"compound_stack","args":[8],"canonicalAc":true,"result":{"reason":status,"before":{"7":"1122334455667788"},"registers":if changed {json!({"7":"123456789abcdef0"})} else {json!({})}}}]);
        run_cases(vec![p]);
    }
}
