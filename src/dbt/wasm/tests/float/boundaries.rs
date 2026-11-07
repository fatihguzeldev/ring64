use super::*;

fn access(op: Numeric, left: u128, right: u128, result: u128, reason: u32, mxcsr: u32) -> Value {
    json!({"kind":"float","args":[op.encode(),format!("{:x}",left as u64),format!("{:x}",left>>64),format!("{:x}",right as u64),format!("{:x}",right>>64)],"result":{"value":format!("{result:x}"),"reason":reason,"mxcsr":mxcsr}})
}

#[test]
fn numeric_middle_entries_skip_unexecuted_writers_and_capture_completed_predecessors() {
    let a = 0x11112222333344445555666677778888u128;
    let b = 0x9999aaaabbbbccccddddeeeeffff0000u128;
    let result = 0xfedcba98765432100123456789abcdefu128;
    let op = numeric(Kind::Add);
    let operation = |dst, src| {
        Operation::Float(FloatInstruction {
            op,
            dst,
            src: Location::Register(RegisterView::low(src)),
        })
    };
    let operations = vec![
        operation(8, 9),
        Operation::Jump { target: 0x100c },
        operation(15, 8),
        operation(7, 15),
    ];
    let mut cases = vec![];
    for (entry, budget) in [(0, 3), (1, 2), (2, 2), (3, 1)] {
        let mut changes = vec![(7, result)];
        if entry == 0 {
            changes.push((8, result));
        }
        if entry == 2 {
            changes.push((15, result));
        }
        let mut p = packet(
            operations.clone(),
            &[(7, a), (8, a), (9, b), (15, b)],
            &changes,
            1,
            budget,
        );
        p["pc"] = json!(format!("{:x}", 0x1000 + entry * 4));
        p["budget"] = json!(budget.to_string());
        p["expected"]["pc"] = json!("1010");
        p["expected"]["remaining"] = json!("0");
        let mut accesses = vec![];
        if entry == 0 {
            accesses.push(access(op, a, b, result, 0, 0x1fa0));
        }
        if entry == 2 {
            accesses.push(access(op, b, a, result, 0, 0x1fa0));
        }
        accesses.push(access(
            op,
            a,
            if entry == 2 { result } else { b },
            result,
            0,
            0x1fa0,
        ));
        p["accesses"] = json!(accesses);
        p["expected"]["mxcsr"] = json!(0x1fa0);
        cases.push(p);
    }
    run_cases(cases);
}

#[test]
fn numeric_exception_preserves_live_predecessor_flags_and_status_without_destination_publication() {
    let a = 0x11112222333344445555666677778888u128;
    let b = 0x9999aaaabbbbccccddddeeeeffff0000u128;
    let compare = numeric(Kind::Comi);
    let add = numeric(Kind::Add);
    let operations = vec![
        Operation::Float(FloatInstruction {
            op: compare,
            dst: 0,
            src: Location::Register(RegisterView::low(1)),
        }),
        Operation::Float(FloatInstruction {
            op: add,
            dst: 8,
            src: Location::Register(RegisterView::low(9)),
        }),
    ];
    let mut p = packet(operations, &[(0, a), (1, b), (8, a), (9, b)], &[], 13, 1);
    p["expected"]["flags"] = json!("447");
    p["expected"]["mxcsr"] = json!(0x1fa1);
    p["accesses"] = json!([
        access(compare, a, b, 0x45, 0, 0x1fa0),
        access(add, a, b, 0, 13, 0x1fa1)
    ]);
    run_cases(vec![p]);
}

#[test]
fn mxcsr_code_stores_retire_before_budget_stop_dispatch_and_failed_stores_leave_state_unchanged() {
    let address = Address {
        base: AddressBase::Register(0),
        ..Address::default()
    };
    let operations = vec![
        Operation::Mxcsr {
            address,
            store: true,
        },
        Operation::Nop,
    ];
    let mut cases = vec![];
    for (status, budget, stop, reason, retired) in [
        (0, 2, None, 6, 0),
        (1, 2, None, 1, 2),
        (2, 2, None, 0, 1),
        (2, 1, Some(0x1004), 1, 1),
        (2, 2, Some(0x1004), 2, 1),
    ] {
        let mut p = packet(operations.clone(), &[], &[], reason, retired);
        p["budget"] = json!(budget.to_string());
        p["expected"]["remaining"] = json!((budget - retired).to_string());
        if let Some(stop) = stop {
            p["stop"] = json!(format!("{stop:x}"));
        }
        let mut accesses = vec![
            json!({"kind":"store_mxcsr","args":["1122334400000000",Segment::Ds as u32,0x1f80],"result":status}),
        ];
        if status == 0 {
            accesses.push(json!({"kind":"access_reason","args":[],"result":6}));
        }
        p["accesses"] = json!(accesses);
        cases.push(p);
    }
    run_cases(cases);
}
