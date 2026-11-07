use super::*;
mod boundaries;
use crate::x86::context::Segment;
use crate::x86::float::{Format, Kind, Op as Numeric};
use crate::x86::instruction::{
    Address, AddressBase, FloatInstruction, Location, VectorInstruction, VectorOperand,
};

fn instruction(index: u64, operation: Operation) -> Instruction {
    Instruction {
        pc: 0x1000 + 4 * index,
        next_pc: 0x1004 + 4 * index,
        operation,
    }
}
fn numeric(kind: Kind) -> Numeric {
    Numeric {
        kind,
        format: Format::F32,
        scalar: true,
        integer64: false,
        predicate: 0,
    }
}
fn packet(
    operations: Vec<Operation>,
    input: &[(usize, u128)],
    output: &[(usize, u128)],
    reason: u32,
    retired: u64,
) -> Value {
    let length = operations.len();
    let p = case(
        operations
            .into_iter()
            .enumerate()
            .map(|(i, op)| instruction(i as u64, op))
            .collect(),
        &[],
        0xcd7,
        0x1000,
        length as u64,
        (
            &[],
            0xcd7,
            0x1000 + retired * 4,
            reason,
            length as u64 - retired,
        ),
    );
    let mut raw =
        std::array::from_fn::<_, 16, _>(|i| 0x112233445566778899aabbcc00000000u128 + i as u128);
    for &(i, v) in input {
        raw[i] = v;
    }
    let mut result = raw;
    for &(i, v) in output {
        result[i] = v;
    }
    let mut p = p;
    p["xmm"] = json!(raw.map(|v| format!("{v:x}")));
    p["expected"]["xmm"] = json!(result.map(|v| format!("{v:x}")));
    p["mxcsr"] = json!(0x1f80u32);
    p["expected"]["mxcsr"] = json!(0x1f80u32);
    p["repeatBudget"] = json!(23);
    p["expected"]["repeatRemaining"] = json!("23");
    p
}

#[test]
fn half_moves_capture_the_selected_half_for_memory_register_and_same_bank_sources() {
    let a = 0x0123456789abcdeffedcba9876543210u128;
    let b = 0xaaaaaaaa55555555bbbbbbbb66666666u128;
    let mut cases = vec![];
    for high in [false, true] {
        for alias in [false, true] {
            let src = if alias { 0 } else { 1 };
            let source = if alias { a } else { b };
            let value = if high {
                (a & u64::MAX as u128) | ((source & u64::MAX as u128) << 64)
            } else {
                (a & !(u64::MAX as u128)) | (source >> 64)
            };
            cases.push(packet(
                vec![Operation::Vector(VectorInstruction::HalfMove {
                    register: 0,
                    operand: VectorOperand::Register(src),
                    high,
                    store: false,
                })],
                &[(0, a), (1, b)],
                &[(0, value)],
                1,
                1,
            ));
        }
    }
    for high in [false, true] {
        for store in [false, true] {
            let address = Address {
                base: AddressBase::Register(0),
                ..Address::default()
            };
            let mut p = packet(
                vec![Operation::Vector(VectorInstruction::HalfMove {
                    register: 1,
                    operand: VectorOperand::Memory(address),
                    high,
                    store,
                })],
                &[(1, b)],
                &[],
                1,
                1,
            );
            let at = "1122334400000000";
            if store {
                let value = if high { b >> 64 } else { b };
                // Scratch upper bits are irrelevant to the selected8-byte store.
                let staged = if high {
                    (b & !(u64::MAX as u128)) | (value & u64::MAX as u128)
                } else {
                    b
                };
                p["accesses"] = json!([{"kind":"vector_store","args":[at,8,Segment::Ds as u32,1,format!("{staged:x}")],"result":1}]);
            } else {
                p["expected"]["xmm"][1] = json!(format!(
                    "{:x}",
                    if high {
                        (b & u64::MAX as u128) | (a as u64 as u128) << 64
                    } else {
                        (b & !(u64::MAX as u128)) | a as u64 as u128
                    }
                ));
                p["accesses"] = json!([{"kind":"vector_load","args":[at,8,Segment::Ds as u32,1],"result":format!("{:x}",a as u64)}]);
            }
            cases.push(p);
        }
    }
    run_cases(cases);
}

#[test]
fn numeric_calls_capture_live_banks_publish_only_successful_results_and_keep_faulting_destinations()
{
    let a = 0x0123456789abcdeffedcba9876543210u128;
    let b = 0xaaaaaaaa55555555bbbbbbbb66666666u128;
    let value = 0xfedcba980123456789abcdef76543210u128;
    let op = numeric(Kind::Add);
    let operations = vec![
        Operation::Vector(VectorInstruction::Move {
            register: 0,
            operand: VectorOperand::Register(1),
            bytes: 16,
            preserve_upper: false,
            aligned: false,
            store: false,
        }),
        Operation::Float(FloatInstruction {
            op,
            dst: 0,
            src: Location::Register(RegisterView::low(0)),
        }),
    ];
    let mut cases = vec![];
    for reason in [0, 13] {
        let mut p = packet(
            operations.clone(),
            &[(0, a), (1, b)],
            &[(0, if reason == 0 { value } else { b })],
            if reason == 0 { 1 } else { 13 },
            if reason == 0 { 2 } else { 1 },
        );
        p["accesses"] = json!([{"kind":"float","args":[op.encode(),format!("{:x}",b as u64),format!("{:x}",b>>64),format!("{:x}",b as u64),format!("{:x}",b>>64)],"result":{"reason":reason,"value":format!("{value:x}"),"mxcsr":0x1fa0}}]);
        p["expected"]["mxcsr"] = json!(0x1fa0);
        cases.push(p);
    }
    let address = Address {
        base: AddressBase::Register(0),
        ..Address::default()
    };
    let mut p = packet(
        vec![Operation::Float(FloatInstruction {
            op,
            dst: 0,
            src: Location::Memory(address),
        })],
        &[(0, a)],
        &[],
        6,
        0,
    );
    p["accesses"] = json!([{"kind":"vector_load","args":["1122334400000000",4,Segment::Ds as u32,1],"result":null},{"kind":"access_reason","args":[],"result":6}]);
    cases.push(p);
    run_cases(cases);
}

#[test]
fn mxcsr_helpers_keep_control_changes_in_invocation_order_and_exit_before_retirement_on_failures() {
    let address = Address {
        base: AddressBase::Register(0),
        ..Address::default()
    };
    let mut cases = vec![];
    for reason in [0, 6, 10, 14] {
        let operations = vec![
            Operation::Mxcsr {
                address,
                store: false,
            },
            Operation::Mxcsr {
                address,
                store: true,
            },
        ];
        let mut p = packet(
            operations,
            &[],
            &[],
            if reason == 0 { 1 } else { reason },
            if reason == 0 { 2 } else { 0 },
        );
        let mut accesses = vec![
            json!({"kind":"load_mxcsr","args":["1122334400000000",Segment::Ds as u32],"result":{"reason":reason,"mxcsr":if reason==0{0x5fa0}else{0x1f80}}}),
        ];
        if reason == 0 {
            accesses.push(
                json!({"kind":"store_mxcsr","args":["1122334400000000",Segment::Ds as u32,0x5fa0],"result":1}),
            );
            p["expected"]["mxcsr"] = json!(0x5fa0);
        }
        p["accesses"] = json!(accesses);
        cases.push(p);
    }
    run_cases(cases);
}

#[test]
fn float_models_do_not_inflate_scalar_translation_records_or_add_unselected_numeric_imports() {
    assert_eq!(std::mem::size_of::<Operation>(), 48);
    assert_eq!(std::mem::size_of::<Instruction>(), 64);
    let bytes = emit(&unit(vec![instruction(
        0,
        Operation::Vector(VectorInstruction::Binary {
            kind: crate::x86::instruction::VectorBinary::Xor,
            dst: 0,
            src: VectorOperand::Register(1),
        }),
    )]));
    for payload in wasmparser::Parser::new(0).parse_all(&bytes) {
        if let wasmparser::Payload::ImportSection(imports) = payload.unwrap() {
            for import in imports.into_imports() {
                let import = import.unwrap();
                assert!(!matches!(
                    import.name,
                    "float" | "load_mxcsr" | "store_mxcsr"
                ));
            }
        }
    }
}

#[test]
fn numeric_gpr_views_and_comparison_flags_publish_only_the_selected_projection() {
    let a = 0x0123456789abcdeffedcba9876543210u128;
    let b = 0xaaaaaaaa55555555bbbbbbbb66666666u128;
    let value = 0x9876543210fedcba1122334480000000u128;
    let mut cases = vec![];
    for format in [Format::F32, Format::F64] {
        for integer64 in [false, true] {
            let mut from = numeric(Kind::IntToFloat);
            from.format = format;
            from.integer64 = integer64;
            let mut p = packet(
                vec![Operation::Float(FloatInstruction {
                    op: from,
                    dst: 8,
                    src: Location::Register(RegisterView::low(1)),
                })],
                &[(8, a)],
                &[(8, value)],
                1,
                1,
            );
            p["accesses"] = json!([{"kind":"float","args":[from.encode(),format!("{:x}",a as u64),format!("{:x}",a>>64),if integer64{"1122334400000001"}else{"1"},"0"],"result":{"reason":0,"value":format!("{value:x}")}}]);
            cases.push(p);
            for kind in [Kind::FloatToInt, Kind::TruncToInt] {
                let mut to = from;
                to.kind = kind;
                let mut p = packet(
                    vec![Operation::Float(FloatInstruction {
                        op: to,
                        dst: 8,
                        src: Location::Register(RegisterView::low(1)),
                    })],
                    &[(1, b)],
                    &[],
                    1,
                    1,
                );
                p["expected"]["registers"][8] = json!(format!(
                    "{:x}",
                    if integer64 {
                        value as u64
                    } else {
                        value as u32 as u64
                    }
                ));
                p["accesses"] = json!([{"kind":"float","args":[to.encode(),"0","0",format!("{:x}",b as u64),format!("{:x}",b>>64)],"result":{"reason":0,"value":format!("{value:x}")}}]);
                cases.push(p);
            }
        }
    }
    for kind in [Kind::Comi, Kind::Ucomi] {
        for reason in [0, 13] {
            for alias in [false, true] {
                let op = numeric(kind);
                let src = if alias { 0 } else { 1 };
                let rhs = if alias { a } else { b };
                let mut p = packet(
                    vec![Operation::Float(FloatInstruction {
                        op,
                        dst: 0,
                        src: Location::Register(RegisterView::low(src)),
                    })],
                    &[(0, a), (1, b)],
                    &[],
                    if reason == 0 { 1 } else { 13 },
                    if reason == 0 { 1 } else { 0 },
                );
                if reason == 0 {
                    p["expected"]["flags"] = json!("447");
                }
                p["accesses"] = json!([{"kind":"float","args":[op.encode(),format!("{:x}",a as u64),format!("{:x}",a>>64),format!("{:x}",rhs as u64),format!("{:x}",rhs>>64)],"result":{"reason":reason,"value":"45"}}]);
                cases.push(p);
            }
        }
    }
    run_cases(cases);
}

#[test]
fn numeric_memory_sources_use_actual_declared_spans_before_calling_the_numeric_authority() {
    let raw = 0x0123456789abcdeffedcba9876543210u128;
    let address = Address {
        base: AddressBase::Register(0),
        ..Address::default()
    };
    let mut cases = vec![];
    for (kind, format, scalar, integer64, width) in [
        (Kind::Add, Format::F32, true, false, 4),
        (Kind::Add, Format::F64, true, false, 8),
        (Kind::Add, Format::F32, false, false, 16),
        (Kind::FloatConvert, Format::F32, false, false, 8),
        (Kind::FloatConvert, Format::F64, false, false, 16),
        (Kind::IntToFloat, Format::F64, false, false, 8),
        (Kind::IntToFloat, Format::F32, true, true, 8),
    ] {
        let op = Numeric {
            kind,
            format,
            scalar,
            integer64,
            predicate: 0,
        };
        let mut p = packet(
            vec![Operation::Float(FloatInstruction {
                op,
                dst: 0,
                src: Location::Memory(address),
            })],
            &[(0, raw)],
            &[(0, raw)],
            1,
            1,
        );
        p["accesses"] = json!([
            {"kind":"vector_load","args":["1122334400000000",width,Segment::Ds as u32,if width==16{16}else{1}],"result":"1122334455667788"},
            {"kind":"float","args":[op.encode(),format!("{:x}",raw as u64),format!("{:x}",raw>>64),"1122334455667788","0"],"result":{"reason":0,"value":format!("{raw:x}")}}
        ]);
        cases.push(p);
    }
    run_cases(cases);
}
