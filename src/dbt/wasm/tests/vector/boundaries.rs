use super::*;
use crate::embedding::layout::{ALIGNMENT, STOP};
use crate::x86::context::ExecutionContext;
use crate::x86::instruction::{Repeat, StringKind};

fn instruction(index: u64, operation: Operation) -> Instruction {
    Instruction {
        pc: 0x1000 + 4 * index,
        next_pc: 0x1004 + 4 * index,
        operation,
    }
}

fn movement(dst: u8, src: u8) -> Operation {
    Operation::Vector(VectorInstruction::Move {
        register: dst,
        operand: VectorOperand::Register(src),
        bytes: 16,
        preserve_upper: false,
        aligned: false,
        store: false,
    })
}

#[test]
fn selected_bank_publication_survives_middle_entries_skipped_writers_and_prior_retirement() {
    let a = 0x112233445566778899aabbccddeeff00;
    let b = 0xffeeddccbbaa99887766554433221100;
    let instructions = vec![
        instruction(0, movement(15, 8)),
        instruction(1, Operation::Jump { target: 0x100c }),
        instruction(2, movement(7, 15)),
        instruction(3, movement(8, 7)),
    ];
    let mut cases = vec![];
    for (entry, budget, next, changes) in [
        (0x1000, 3, 0x1010, vec![(15, b), (8, a)]),
        (0x1004, 2, 0x1010, vec![(8, a)]),
        (0x1008, 2, 0x1010, vec![(7, b), (8, b)]),
        (0x100c, 1, 0x1010, vec![(8, a)]),
    ] {
        cases.push(with_xmm(
            case(
                instructions.clone(),
                &[],
                0xcd7,
                entry,
                budget,
                (&[], 0xcd7, next, BUDGET as u32, 0),
            ),
            &[(7, a), (8, b), (15, b)],
            &changes,
        ));
    }
    let address = Address {
        base: AddressBase::Register(0),
        ..Address::default()
    };
    let instructions = vec![
        instruction(0, movement(15, 8)),
        instruction(
            1,
            Operation::Vector(VectorInstruction::Binary {
                kind: VectorBinary::Add(Width::W8),
                dst: 7,
                src: VectorOperand::Memory(address),
            }),
        ),
        instruction(2, movement(8, 7)),
    ];
    let mut p = with_xmm(
        case(
            instructions,
            &[(0, 0x6001)],
            0xcd7,
            0x1000,
            3,
            (&[], 0xcd7, 0x1004, DATA as u32, 2),
        ),
        &[(7, a), (8, b), (15, a)],
        &[(15, b)],
    );
    p["accesses"] = json!([{"kind":"vector_load","args":["6001",16,Segment::Ds as u32,16],"result":null},{"kind":"access_reason","args":[],"result":DATA}]);
    cases.push(p);
    run_cases(cases);
}

#[test]
fn vector_code_writes_retire_then_observe_budget_stop_before_dispatch() {
    let value = 0xffeeddccbbaa99887766554433221100;
    let address = Address {
        base: AddressBase::Register(0),
        ..Address::default()
    };
    let instructions = vec![
        instruction(
            0,
            Operation::Vector(VectorInstruction::Move {
                register: 15,
                operand: VectorOperand::Memory(address),
                bytes: 16,
                preserve_upper: false,
                aligned: false,
                store: true,
            }),
        ),
        instruction(1, movement(7, 15)),
    ];
    let mut cases = vec![];
    for (status, budget, stop, reason, next, remaining, changes) in [
        (2, 2, None, DISPATCH, 0x1004, 1, vec![]),
        (2, 1, Some(0x1004), BUDGET, 0x1004, 0, vec![]),
        (2, 2, Some(0x1004), STOP, 0x1004, 1, vec![]),
        (1, 2, None, BUDGET, 0x1008, 0, vec![(7, value)]),
    ] {
        let mut p = with_xmm(
            case(
                instructions.clone(),
                &[(0, 0x6001)],
                0xcd7,
                0x1000,
                budget,
                (&[], 0xcd7, next, reason as u32, remaining),
            ),
            &[(15, value)],
            &changes,
        );
        p["accesses"] = json!([{"kind":"vector_store","args":["6001",16,Segment::Ds as u32,1,format!("{value:x}")],"result":status}]);
        if let Some(stop) = stop {
            p["stop"] = json!(format!("{stop:x}"));
        }
        cases.push(p);
    }
    run_cases(cases);
}

#[test]
fn mixed_rep_vector_locals_keep_budget_df_and_entry_flags_independent() {
    let a = 0x80018002800380048005800680078008;
    let b = 0x00010002000300040005000600070008;
    let instructions = vec![
        instruction(0, movement(15, 8)),
        instruction(
            1,
            Operation::String {
                kind: StringKind::Scas,
                width: Width::W8,
                address_width: Width::W64,
                source_segment: Segment::Ds,
                repeat: Repeat::WhileEqual,
            },
        ),
        instruction(
            2,
            Operation::Vector(VectorInstruction::Binary {
                kind: VectorBinary::Add(Width::W16),
                dst: 15,
                src: VectorOperand::Register(7),
            }),
        ),
    ];
    let mut cases = vec![];
    for entry in [0x1000, 0x1004, 0x1008] {
        let before = if entry == 0x1000 { b } else { a };
        let mut p = with_xmm(
            case(
                instructions.clone(),
                &[(1, 0)],
                0xcd7,
                entry,
                (0x100c - entry) / 4,
                (&[], 0xcd7, 0x100c, BUDGET as u32, 0),
            ),
            &[(15, a), (8, b), (7, b)],
            &[(15, binary_oracle(VectorBinary::Add(Width::W16), before, b))],
        );
        p["repeatBudget"] = json!(23);
        cases.push(p);
    }
    run_cases(cases);
}

#[test]
fn vector_helpers_keep_effective_offsets_and_scalar_mixed_fault_segments_distinct() {
    let context = ExecutionContext::from_json(
        &json!({"mode":"long64","fsBase":"0x100000000","gsBase":"0x200000000"}),
    )
    .unwrap();
    let address = Address {
        base: AddressBase::Register(0),
        displacement: 0x30,
        size: Width::W32,
        segment: Segment::Fs,
        ..Address::default()
    };
    let instructions = vec![
        instruction(
            0,
            Operation::Load {
                dst: RegisterView::low(2),
                address,
                width: Width::W32,
            },
        ),
        instruction(
            1,
            Operation::Vector(VectorInstruction::Binary {
                kind: VectorBinary::And,
                dst: 15,
                src: VectorOperand::Memory(address),
            }),
        ),
    ];
    let mut u = unit(instructions);
    u.context = context;
    let bytes = emit(&u);
    let mut cases = vec![];
    let mut p = with_xmm(
        execution_case(
            &bytes,
            &[0x1000, 0x1004],
            &[(0, 0x11223344fffffff0)],
            0xcd7,
            0x1000,
            2,
            (&[], 0xcd7, 0x1000, DATA as u32, 2),
        ),
        &[],
        &[],
    );
    p["accesses"] = json!([{"kind":"load","args":["100000020",4],"result":"0"},{"kind":"access_failed","args":[],"result":1}]);
    p["faultSegment"] = json!(Segment::Fs as u32);
    cases.push(p);
    let mut p = with_xmm(
        execution_case(
            &bytes,
            &[0x1000, 0x1004],
            &[(0, 0x11223344fffffff0)],
            0xcd7,
            0x1004,
            1,
            (&[], 0xcd7, 0x1004, ALIGNMENT as u32, 1),
        ),
        &[],
        &[],
    );
    p["accesses"] = json!([{"kind":"vector_load","args":["20",16,Segment::Fs as u32,16],"result":null},{"kind":"access_reason","args":[],"result":ALIGNMENT}]);
    cases.push(p);
    run_cases(cases);
}

#[test]
fn scalar_artifacts_have_no_vector_locals_imports_or_state_traffic() {
    let gp = emit(&unit(vec![instruction(0, Operation::Nop)]));
    let vector = emit(&unit(vec![instruction(0, movement(15, 8))]));
    for (bytes, expected_locals, expected_loads, expected_stores) in
        [(gp, 0, 0, 0), (vector, 5, 2, 1)]
    {
        let (mut locals, mut loads, mut stores) = (0, 0, 0);
        for payload in wasmparser::Parser::new(0).parse_all(&bytes) {
            match payload.unwrap() {
                wasmparser::Payload::ImportSection(imports) => {
                    for group in imports {
                        for import in group.unwrap() {
                            assert!(!import.unwrap().1.name.starts_with("vector_"));
                        }
                    }
                }
                wasmparser::Payload::CodeSectionEntry(body) => {
                    for local in body.get_locals_reader().unwrap() {
                        let (count, ty) = local.unwrap();
                        if ty == wasmparser::ValType::V128 {
                            locals += count;
                        }
                    }
                    for operation in body.get_operators_reader().unwrap() {
                        match operation.unwrap() {
                            wasmparser::Operator::V128Load { .. } => loads += 1,
                            wasmparser::Operator::V128Store { .. } => stores += 1,
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
        }
        assert_eq!(
            (locals, loads, stores),
            (expected_locals, expected_loads, expected_stores)
        );
    }
}
