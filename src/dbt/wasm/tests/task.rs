use super::*;
use crate::embedding::layout::{BUDGET, DISPATCH, PROTECTION, STOP};
use crate::x86::context::{ExecutionContext, Segment};
use crate::x86::instruction::{
    Address, AddressBase, Location, ProtectionDescriptor, ProtectionInstruction,
    ProtectionKind as Kind,
};

fn task(kind: Kind, operand: Location, width: Width, pc: u64, next_pc: u64) -> Instruction {
    Instruction {
        pc,
        next_pc,
        operation: Operation::Protection(ProtectionInstruction {
            kind,
            operand,
            register: 0,
            width,
        }),
    }
}

#[test]
fn ltr_captures_a_live_extended_selector_and_retires_before_context_or_smc_dispatch() {
    let source = Location::Register(RegisterView::low(15));
    let instructions = vec![
        Instruction {
            pc: 0x1000,
            next_pc: 0x100a,
            operation: Operation::Mov {
                dst: RegisterView::low(15),
                src: DataOperand::Immediate(0x1122334455667788),
                width: Width::W64,
            },
        },
        task(Kind::LoadTask, source, Width::W16, 0x100a, 0x100e),
    ];
    let bytes = emit(&unit(instructions));
    let descriptor = ProtectionDescriptor {
        kind: Kind::LoadTask,
        width: Width::W16,
        memory: false,
    }
    .encode();
    let mut cases = vec![];
    for (status, budget, stop, pc, reason, remaining) in [
        (0, 2, None, 0x100e, BUDGET, 0),
        (2, 2, None, 0x100e, BUDGET, 0),
        (2, 3, Some("100e"), 0x100e, STOP, 1),
        (2, 3, None, 0x100e, DISPATCH, 1),
        (PROTECTION, 3, None, 0x100a, PROTECTION, 2),
    ] {
        let mut p = execution_case(
            &bytes,
            &[0x1000, 0x100a],
            &[(15, 0xfedcba9876543210)],
            0x3c7ed7,
            0x1000,
            budget,
            (
                &[(15, 0x1122334455667788)],
                0x3c7ed7,
                pc,
                reason as u32,
                remaining,
            ),
        );
        p["accesses"] = json!([{"kind":"protection","args":[descriptor,"0","7788",Segment::Ds as u32],"result":{"reason":status}}]);
        if let Some(stop) = stop {
            p["stop"] = json!(stop);
        }
        cases.push(p);
    }
    let mut middle = execution_case(
        &bytes,
        &[0x1000, 0x100a],
        &[(15, 0x9988776655440028)],
        0x3c7ed7,
        0x100a,
        1,
        (&[], 0x3c7ed7, 0x100e, BUDGET as u32, 0),
    );
    middle["accesses"] = json!([{"kind":"protection","args":[descriptor,"0","28",Segment::Ds as u32],"result":{"reason":0}}]);
    cases.push(middle);
    run_cases(cases);
}

#[test]
fn str_merges_the_selected_live_register_width_in_each_execution_family() {
    let mut cases = vec![];
    for nonlong in [false, true] {
        for width in [Width::W16, Width::W32, Width::W64] {
            if nonlong && width == Width::W64 {
                continue;
            }
            let bank = if nonlong { 0 } else { 15 };
            let mut u = unit(vec![task(
                Kind::ReadTask,
                Location::Register(RegisterView::low(bank)),
                width,
                0x1000,
                0x1004,
            )]);
            if nonlong {
                let mut context = u.context.to_json();
                context["mode"] = json!("protected");
                context["segments"]["cs"]["long"] = json!(false);
                u.context = ExecutionContext::from_json(&context).unwrap();
            }
            let expected = match width {
                Width::W16 => 0xfedcba9876540028,
                Width::W32 if nonlong => 0xfedcba9800000028,
                _ => 0x28,
            };
            let mut p = execution_case(
                &emit(&u),
                &[0x1000],
                &[(bank as usize, 0xfedcba9876543210)],
                0x3c7ed7,
                0x1000,
                1,
                (
                    &[(bank as usize, expected)],
                    0x3c7ed7,
                    0x1004,
                    BUDGET as u32,
                    0,
                ),
            );
            let descriptor = ProtectionDescriptor {
                kind: Kind::ReadTask,
                width,
                memory: false,
            }
            .encode();
            p["accesses"] = json!([{"kind":"protection","args":[descriptor,"0","0",Segment::Ds as u32],"result":{"reason":0,"value":"28","control":1}}]);
            cases.push(p);
        }
    }
    run_cases(cases);
}

#[test]
fn task_memory_forms_forward_the_live_address_and_selected_segment_without_bank_copies() {
    let mut cases = vec![];
    for kind in [Kind::ReadTask, Kind::LoadTask] {
        let address = Address {
            base: AddressBase::Register(8),
            displacement: 7,
            segment: Segment::Fs,
            ..Address::default()
        };
        let u = unit(vec![
            Instruction {
                pc: 0x1000,
                next_pc: 0x100a,
                operation: Operation::Mov {
                    dst: RegisterView::low(8),
                    src: DataOperand::Immediate(0x4000),
                    width: Width::W64,
                },
            },
            task(kind, Location::Memory(address), Width::W16, 0x100a, 0x100e),
        ]);
        let bytes = emit(&u);
        wasmparser::Validator::new().validate_all(&bytes).unwrap();
        let mut p = execution_case(
            &bytes,
            &[0x1000, 0x100a],
            &[(8, 0x8888)],
            0x3c7ed7,
            0x1000,
            2,
            (&[(8, 0x4000)], 0x3c7ed7, 0x100e, BUDGET as u32, 0),
        );
        let descriptor = ProtectionDescriptor {
            kind,
            width: Width::W16,
            memory: true,
        }
        .encode();
        p["accesses"] = json!([{"kind":"protection","args":[descriptor,"4007","0",Segment::Fs as u32],"result":{"reason":2}}]);
        cases.push(p);
    }
    run_cases(cases);
}
