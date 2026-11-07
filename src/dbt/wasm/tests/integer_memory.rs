use super::*;
use crate::embedding::layout::{BUDGET, DATA};
use crate::x86::instruction::{Address, AddressBase, MemoryAluOperands};

#[test]
fn memory_results_commit_flags_only_after_successful_accesses() {
    let mut cases = Vec::new();
    for (read_failed, store_succeeded) in [(true, false), (false, false), (false, true)] {
        let success = !read_failed && store_succeeded;
        let mut packet = case(
            vec![Instruction {
                pc: 0x1000,
                next_pc: 0x1004,
                operation: Operation::MemoryAlu {
                    kind: Alu::Add,
                    address: Address {
                        size: crate::x86::instruction::Width::W64,
                        segment: crate::x86::context::Segment::Ds,
                        base: AddressBase::Register(3),
                        index: None,
                        displacement: 0,
                    },
                    operands: MemoryAluOperands::MemoryFirst(DataOperand::Immediate(3)),
                    width: Width::W64,
                },
            }],
            &[(3, 0x100004000)],
            0x8d7,
            0x1000,
            1,
            (
                &[],
                if success { 2 } else { 0x8d7 },
                if success { 0x1004 } else { 0x1000 },
                if success { BUDGET as u32 } else { DATA as u32 },
                u64::from(!success),
            ),
        );
        let mut accesses = vec![
            json!({"kind":"load_for_write", "args":["100004000",8], "result":"a"}),
            json!({"kind":"access_failed", "args":[], "result":u32::from(read_failed)}),
        ];
        if !read_failed {
            accesses.push(json!({"kind":"store", "args":["100004000",8,"d"],
                "result":u32::from(store_succeeded)}));
        }
        packet["accesses"] = json!(accesses);
        cases.push(packet);
    }
    run_cases(cases);
}

#[test]
fn register_destination_uses_the_incoming_address_and_selected_memory_width() {
    let mut packet = case(
        vec![Instruction {
            pc: 0x1000,
            next_pc: 0x1002,
            operation: Operation::MemoryAlu {
                kind: Alu::Xor,
                address: Address {
                    size: crate::x86::instruction::Width::W64,
                    segment: crate::x86::context::Segment::Ds,
                    base: AddressBase::Register(0),
                    index: None,
                    displacement: 0,
                },
                operands: MemoryAluOperands::RegisterFirst(RegisterView::low(0)),
                width: Width::W32,
            },
        }],
        &[(0, 0x100004000)],
        0x8d7,
        0x1000,
        1,
        (&[(0, 0x4001)], 2, 0x1002, BUDGET as u32, 0),
    );
    packet["accesses"] = json!([
        {"kind":"load", "args":["100004000",4], "result":"ffffffff00000001"},
        {"kind":"access_failed", "args":[], "result":0}
    ]);
    packet["flagMask"] = json!("8c7");
    run_cases(vec![packet]);
}
