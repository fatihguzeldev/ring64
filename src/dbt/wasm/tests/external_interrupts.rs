use super::*;
use crate::embedding::layout::{BUDGET, DEBUG_EXCEPTION, HALTED, PENDING_INTERRUPT};

#[test]
fn halt_retires_before_private_gates_and_tf_wakes_before_external_service() {
    let u = unit(vec![Instruction {
        pc: 0x1000,
        next_pc: 0x1001,
        operation: Operation::Halt,
    }]);
    let mut packets = vec![];
    for (flags, budget, reason) in [(2, 2, HALTED), (2, 1, BUDGET), (0x302, 1, DEBUG_EXCEPTION)] {
        let bytes = emit_observed(&u, flags & 0x100 != 0);
        let mut p = execution_case(
            &bytes,
            &[0x1000],
            &[],
            flags,
            0x1000,
            budget,
            (&[], flags, 0x1001, reason as u32, budget - 1),
        );
        p["accesses"] = json!([{ "kind":"halt", "args":[format!("{flags:x}")], "result":0 }]);
        if flags & 0x100 != 0 {
            p["accesses"].as_array_mut().unwrap().push(json!({"kind":"debug_step", "args":["1000","1001",1,"302"],"result":DEBUG_EXCEPTION}));
        }
        packets.push(p);
    }
    run_cases(packets);
}

#[test]
fn shadow_completion_publishes_external_boundary_before_last_allowance_gate() {
    let u = unit(vec![Instruction {
        pc: 0x1000,
        next_pc: 0x1001,
        operation: Operation::Nop,
    }]);
    let bytes = emit_observed(&u, true);
    let mut p = execution_case(
        &bytes,
        &[0x1000],
        &[],
        0x202,
        0x1000,
        1,
        (&[], 0x202, 0x1001, PENDING_INTERRUPT as u32, 0),
    );
    p["interruptibility"] = json!(2);
    p["expected"]["interruptibility"] = json!(0);
    p["irq"] = json!(0x20);
    p["accesses"] =
        json!([{"kind":"external_step", "args":["1001","202",0], "result":PENDING_INTERRUPT}]);
    run_cases(vec![p]);
}

#[test]
fn ordinary_plain_units_do_not_import_external_boundary_work() {
    let bytes = emit(&unit(vec![Instruction {
        pc: 0x1000,
        next_pc: 0x1001,
        operation: Operation::Nop,
    }]));
    for payload in wasmparser::Parser::new(0).parse_all(&bytes) {
        if let wasmparser::Payload::ImportSection(reader) = payload.unwrap() {
            for import in reader.into_imports() {
                assert!(!matches!(import.unwrap().name, "external_step" | "halt"));
            }
        }
    }
}

#[test]
fn software_entry_handler_gates_precede_newly_unblocked_nmi_acceptance() {
    use crate::embedding::layout::STOP;
    use crate::x86::instruction::{SoftwareEventDescriptor, SoftwareEventKind, Width};
    let operation = SoftwareEventDescriptor {
        kind: SoftwareEventKind::Interrupt,
        vector: 0x20,
        width: Width::W16,
    };
    let bytes = emit_observed(
        &unit(vec![Instruction {
            pc: 0x1000,
            next_pc: 0x1002,
            operation: Operation::SoftwareEvent(operation),
        }]),
        true,
    );
    let mut packets = vec![];
    for (budget, stop, reason) in [(1, None, BUDGET), (2, Some("2000"), STOP)] {
        let mut p = execution_case(
            &bytes,
            &[0x1000],
            &[(4, 0x8000)],
            0x202,
            0x1000,
            budget,
            (&[(4, 0x7ff4)], 0x202, 0x2000, reason as u32, budget - 1),
        );
        p["interruptibility"] = json!(2);
        p["expected"]["interruptibility"] = json!(0);
        p["nmiPending"] = json!(true);
        if let Some(stop) = stop {
            p["stop"] = json!(stop);
        }
        p["accesses"] = json!([{"kind":"software_event","args":[operation.encode(),"8000","202","1002"],"result":{"reason":0,"pc":"2000","sp":"7ff4","flags":"202"}}]);
        packets.push(p);
    }
    run_cases(packets);
}
