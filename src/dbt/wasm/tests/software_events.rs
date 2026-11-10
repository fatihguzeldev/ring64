use super::*;
use crate::embedding::layout::{BUDGET, DEBUG_EXCEPTION, DISPATCH, PROTECTION, STOP};
use crate::x86::context::ExecutionContext;
use crate::x86::instruction::{SoftwareEventDescriptor, SoftwareEventKind as Kind};

fn descriptor(kind: Kind, width: Width, vector: u8) -> SoftwareEventDescriptor {
    SoftwareEventDescriptor {
        kind,
        width,
        vector,
    }
}

fn pending_numeric(packet: &mut Value) {
    packet["x87"] = json!({
        "registers": (0..8).map(|i| format!("{:x}", (1u128 << 79) + i)).collect::<Vec<_>>(),
        "controlWord": 0x37e, "statusWord": 0x8081, "tagWord": 0xffff,
        "opcode": 0x123, "instructionPointer": "123456789abcdef0", "dataPointer": "fedcba9876543210",
    });
    packet["expected"]["x87"] = packet["x87"].clone();
}

fn software_unit(operation: SoftwareEventDescriptor, observed: bool) -> (Vec<u8>, Vec<u64>) {
    let mut u = unit(vec![Instruction {
        pc: 0x1000,
        next_pc: 0x1001,
        operation: Operation::SoftwareEvent(operation),
    }]);
    if operation.kind == Kind::Into {
        let mut context = u.context.to_json();
        context["mode"] = json!("protected");
        context["segments"]["cs"]["long"] = json!(false);
        u.context = ExecutionContext::from_json(&context).unwrap();
    }
    (emit_observed(&u, observed), vec![0x1000])
}

#[test]
fn event_imports_and_control_lifetimes_are_selected_without_default_bank_traffic() {
    for (event, observed) in [(false, false), (true, false), (true, true)] {
        let bytes = if event {
            let operation = if observed {
                descriptor(Kind::Return, Width::W64, 0)
            } else {
                descriptor(Kind::Interrupt, Width::W16, 0x80)
            };
            software_unit(operation, observed).0
        } else {
            emit(&unit(vec![Instruction {
                pc: 0x1000,
                next_pc: 0x1001,
                operation: Operation::Nop,
            }]))
        };
        wasmparser::Validator::new().validate_all(&bytes).unwrap();
        let mut names = vec![];
        let mut vector_traffic = false;
        for payload in wasmparser::Parser::new(0).parse_all(&bytes) {
            match payload.unwrap() {
                wasmparser::Payload::ImportSection(reader) => {
                    names.extend(reader.into_imports().map(|i| i.unwrap().name.to_owned()));
                }
                wasmparser::Payload::CodeSectionEntry(body) => {
                    for operator in body.get_operators_reader().unwrap() {
                        vector_traffic |= matches!(
                            operator.unwrap(),
                            wasmparser::Operator::V128Load { .. }
                                | wasmparser::Operator::V128Store { .. }
                        );
                    }
                }
                _ => {}
            }
        }
        assert_eq!(names.iter().any(|n| n == "software_event"), event);
        assert_eq!(names.iter().any(|n| n == "debug_finish"), observed);
        assert!(!names.iter().any(|n| n == "flags"));
        assert!(!vector_traffic);
    }
}

#[test]
fn event_helpers_capture_live_predecessors_and_publish_returned_flags_pc_and_raw_sp() {
    let code = [
        0x66, 0x0f, 0xef, 0xc9, // PXOR XMM1,XMM1.
        0x48, 0x83, 0xc4, 8, // ADD RSP,8.
        0x31, 0xc0, // XOR EAX,EAX.
        0xfc, // CLD.
        0xcd, 0x80,
    ];
    let a = compiled_fixture(0x1000, &code, 0x1000);
    let mut p = execution_case(
        &a.bytes,
        &a.entries,
        &[(4, 0xffff800000004010)],
        0x3c7ed7,
        0x1000,
        5,
        (
            &[(0, 0), (4, 0xffff800000003fe8)],
            0x3c3046,
            0x9000,
            BUDGET as u32,
            0,
        ),
    );
    let xmm: Vec<_> = (0..16)
        .map(|i| format!("{:x}", (i + 1) * 0x12345))
        .collect();
    p["xmm"] = json!(xmm);
    p["expected"]["xmm"] = p["xmm"].clone();
    p["expected"]["xmm"][1] = json!("0");
    p["mxcsr"] = json!(0x3f80);
    p["expected"]["mxcsr"] = json!(0x3f80);
    pending_numeric(&mut p);
    let op = descriptor(Kind::Interrupt, Width::W16, 0x80).encode();
    p["accesses"] = json!([{"kind":"software_event","args":[op,"ffff800000004018","3c7246","100d"],"result":{"reason":0,"pc":"9000","sp":"ffff800000003fe8","flags":"3c3046"}}]);
    run_cases(vec![p]);
}

#[test]
fn event_faults_do_not_retire_or_consume_history_and_entry_gates_prevent_the_helper() {
    let operation = descriptor(Kind::Interrupt, Width::W16, 0x80);
    let (bytes, entries) = software_unit(operation, true);
    let mut cases = vec![];
    for reason in [3, 6, 10, PROTECTION, 17] {
        let mut p = execution_case(
            &bytes,
            &entries,
            &[(4, 0x123456789abc4000)],
            0x10102,
            0x1000,
            1,
            (&[], 0x102, 0x1000, reason as u32, 1),
        );
        p["interruptibility"] = json!(2);
        p["expected"]["interruptibility"] = json!(2);
        p["accesses"] = json!([{"kind":"software_event","args":[operation.encode(),"123456789abc4000","102","1001"],"result":{"reason":reason}}]);
        cases.push(p);
    }
    for (budget, stop, reason) in [(0, None, BUDGET), (1, Some("1000"), STOP)] {
        let mut p = execution_case(
            &bytes,
            &entries,
            &[],
            0x10102,
            0x1000,
            budget,
            (&[], 0x10102, 0x1000, reason as u32, budget),
        );
        p["interruptibility"] = json!(2);
        p["expected"]["interruptibility"] = json!(2);
        if let Some(stop) = stop {
            p["stop"] = json!(stop);
        }
        cases.push(p);
    }
    run_cases(cases);
}

#[test]
fn successful_entry_suppresses_its_sampled_step_but_return_uses_the_incoming_tf() {
    let mut cases = vec![];
    for kind in [
        Kind::Interrupt,
        Kind::Int3,
        Kind::Into,
        Kind::Int1,
        Kind::Return,
    ] {
        let vector = match kind {
            Kind::Interrupt => 0x80,
            Kind::Int3 => 3,
            Kind::Into => 4,
            Kind::Int1 => 1,
            Kind::Return => 0,
        };
        let operation = descriptor(
            kind,
            if kind == Kind::Return {
                Width::W64
            } else {
                Width::W16
            },
            vector,
        );
        let (bytes, entries) = software_unit(operation, true);
        let input = if kind == Kind::Into { 0xb02 } else { 0x302 };
        let output = if kind == Kind::Into { 0x802 } else { 2 };
        let sp = match kind {
            Kind::Return => 0x4028,
            Kind::Into => 0x400a,
            _ => 0x3fe8,
        };
        let reason = if kind == Kind::Return {
            DEBUG_EXCEPTION
        } else {
            BUDGET
        };
        let mut p = execution_case(
            &bytes,
            &entries,
            &[(4, 0x4010)],
            input,
            0x1000,
            1,
            (&[(4, sp)], output, 0x7000, reason as u32, 0),
        );
        p["stop"] = json!("7000");
        p["interruptibility"] = json!(2);
        p["expected"]["interruptibility"] = json!(0);
        pending_numeric(&mut p);
        let mut accesses = vec![
            json!({"kind":"software_event","args":[operation.encode(),"4010",format!("{input:x}"),"1001"],"result":{"reason":0,"pc":"7000","sp":format!("{sp:x}"),"flags":format!("{output:x}")}}),
        ];
        if kind == Kind::Return {
            accesses.push(
                json!({"kind":"debug_step","args":["1000","7000",1,"2"],"result":DEBUG_EXCEPTION}),
            );
        }
        p["accesses"] = json!(accesses);
        cases.push(p);
    }
    for (observed, input) in [(false, 2), (true, 0x10002)] {
        let operation = descriptor(Kind::Return, Width::W64, 0);
        let (bytes, entries) = software_unit(operation, observed);
        let mut p = execution_case(
            &bytes,
            &entries,
            &[(4, 0x4010)],
            input,
            0x1000,
            2,
            (&[(4, 0x4000)], 0x10302, 0x7000, DISPATCH as u32, 1),
        );
        p["accesses"] = json!([{"kind":"software_event","args":[operation.encode(),"4010","2","1001"],"result":{"reason":0,"pc":"7000","sp":"4000","flags":"10302"}}]);
        cases.push(p);
    }
    run_cases(cases);
}

#[test]
fn untaken_into_uses_ordinary_fallthrough_and_step_without_event_memory() {
    let operation = descriptor(Kind::Into, Width::W16, 4);
    let (bytes, entries) = software_unit(operation, true);
    let mut stepped = execution_case(
        &bytes,
        &entries,
        &[],
        0x10102,
        0x1000,
        1,
        (&[], 0x102, 0x1001, DEBUG_EXCEPTION as u32, 0),
    );
    stepped["accesses"] =
        json!([{"kind":"debug_step","args":["1000","1001",1,"102"],"result":DEBUG_EXCEPTION}]);
    let mut u = unit(vec![
        Instruction {
            pc: 0x1000,
            next_pc: 0x1001,
            operation: Operation::SoftwareEvent(operation),
        },
        Instruction {
            pc: 0x1001,
            next_pc: 0x1006,
            operation: Operation::Mov {
                dst: RegisterView::low(0),
                src: crate::x86::instruction::DataOperand::Immediate(17),
                width: Width::W32,
            },
        },
    ]);
    let mut context = u.context.to_json();
    context["mode"] = json!("protected");
    context["segments"]["cs"]["long"] = json!(false);
    u.context = ExecutionContext::from_json(&context).unwrap();
    let ordinary = execution_case(
        &emit(&u),
        &[0x1000, 0x1001],
        &[(0, 0x1234567800000000)],
        2,
        0x1000,
        2,
        (&[(0, 0x1234567800000011)], 2, 0x1006, BUDGET as u32, 0),
    );
    run_cases(vec![stepped, ordinary]);
}

#[test]
fn event_discovery_and_retained_entries_do_not_execute_old_context_successors() {
    for code in [
        &[0xcc, 0x90, 0x90][..],
        &[0xcd, 0x80, 0x90][..],
        &[0xf1, 0x90][..],
        &[0xcf, 0x90][..],
        &[0x48, 0xcf, 0x90][..],
    ] {
        let a = compiled_fixture(0x1000, code, 0x1000);
        assert_eq!(a.entries, [0x1000]);
        assert_eq!(a.instruction_count, 1);
        assert_eq!(
            a.source_bytes,
            code.len() - if code[0] == 0xcc { 2 } else { 1 }
        );
    }
    let code = [0x74, 2, 0x48, 0xcf, 0x90];
    let a = compiled_fixture(0x1000, &code, 0x1000);
    assert_eq!(a.entries, [0x1000, 0x1002, 0x1004]);
    let mut cases = vec![execution_case(
        &a.bytes,
        &a.entries,
        &[],
        0x3c3ed7,
        0x1000,
        2,
        (&[], 0x3c3ed7, 0x1005, BUDGET as u32, 0),
    )];
    for (budget, stop, reason, remaining) in [
        (1, None, BUDGET, 0),
        (2, Some("7000"), crate::embedding::layout::STOP, 1),
        (2, None, DISPATCH, 1),
    ] {
        let mut p = execution_case(
            &a.bytes,
            &a.entries,
            &[(4, 0xffff800000004040)],
            0x3c3ed7,
            0x1002,
            budget,
            (
                &[(4, 0xffff800000004050)],
                0x3c3602,
                0x7000,
                reason as u32,
                remaining,
            ),
        );
        if let Some(stop) = stop {
            p["stop"] = json!(stop);
        }
        p["accesses"] = json!([{"kind":"software_event","args":[descriptor(Kind::Return,Width::W64,0).encode(),"ffff800000004040","3c3ed7","1004"],"result":{"reason":0,"pc":"7000","sp":"ffff800000004050","flags":"3c3602"}}]);
        cases.push(p);
    }
    run_cases(cases);
    let mut context = ExecutionContext::default().to_json();
    context["mode"] = json!("protected");
    context["segments"]["cs"]["long"] = json!(false);
    let context = ExecutionContext::from_json(&context).unwrap();
    let image =
        crate::memory::Image::new(0x1000, vec![0xce, 0x90, 0x90], 0x8000, vec![0; 8]).unwrap();
    let a = crate::dbt::compile_with_context(
        &image,
        &context,
        0x1000,
        crate::dbt::Limits {
            max_instructions: 8,
            max_source_bytes: 32,
            max_artifact_bytes: 65536,
        },
    )
    .unwrap();
    assert_eq!(a.entries, [0x1000, 0x1001, 0x1002]);
    assert_eq!(a.block_count, 2);
}

#[test]
fn event_helper_types_coexist_with_dynamic_targets_numeric_and_full_flag_helpers() {
    let code = [
        0xff, 0x10, 0x48, 0xf7, 0xe5, 0x48, 0xf7, 0xf5, 0xf3, 0x0f, 0x58, 0xc1, 0x0f, 0xae, 0x13,
        0x9b, 0x9c, 0x9d, 0xcd, 0x80,
    ];
    let a = compiled_fixture(0x1000, &code, 0x1000);
    assert_eq!(a.source_bytes, code.len());
    wasmparser::Validator::new().validate_all(&a.bytes).unwrap();
    let mut names = vec![];
    let mut functions = 0;
    for payload in wasmparser::Parser::new(0).parse_all(&a.bytes) {
        match payload.unwrap() {
            wasmparser::Payload::ImportSection(reader) => {
                names.extend(reader.into_imports().map(|i| i.unwrap().name.to_owned()));
            }
            wasmparser::Payload::FunctionSection(reader) => functions = reader.count(),
            _ => {}
        }
    }
    assert_eq!(functions, 2, "run plus dynamic entry lookup");
    for name in [
        "software_event",
        "flags",
        "x87",
        "float",
        "load_mxcsr",
        "multiply_high",
        "divide",
    ] {
        assert!(names.iter().any(|n| n == name), "missing {name}");
    }
}
