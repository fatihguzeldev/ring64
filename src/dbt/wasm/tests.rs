mod addressing;
mod arithmetic_bits;
mod conditions;
mod counts;
mod data_widths;
mod integer_memory;
mod logical;
mod routing;
mod stack;

use super::*;
use crate::embedding::layout::RunState;
use crate::x86::instruction::{
    Alu, Condition, DataOperand, Instruction, Operand, Operation, RegisterView, Width,
};
use serde_json::{Value, json};
use std::process::{Command, Stdio};

fn unit(instructions: Vec<Instruction>) -> Unit {
    Unit {
        source_bytes: instructions.len(),
        block_count: 1,
        instructions,
    }
}

#[test]
fn emits_a_valid_module() {
    let bytes = emit(&unit(vec![Instruction {
        pc: 0x1000,
        next_pc: 0x1005,
        operation: Operation::Mov {
            dst: RegisterView::low(0),
            src: DataOperand::Immediate(7),
            width: Width::W32,
        },
    }]));
    wasmparser::Validator::new().validate_all(&bytes).unwrap();
}

type Outcome<'a> = (&'a [(usize, u64)], u64, u64, u32, u64);

fn case(
    instructions: Vec<Instruction>,
    input: &[(usize, u64)],
    flags: u64,
    entry: u64,
    budget: u64,
    outcome: Outcome<'_>,
) -> Value {
    let entries: Vec<_> = instructions
        .iter()
        .map(|instruction| instruction.pc)
        .collect();
    let bytes = emit(&unit(instructions));
    execution_case(&bytes, &entries, input, flags, entry, budget, outcome)
}

fn execution_case(
    bytes: &[u8],
    entries: &[u64],
    input: &[(usize, u64)],
    flags: u64,
    entry: u64,
    budget: u64,
    outcome: Outcome<'_>,
) -> Value {
    let (expected, result_flags, result_pc, reason, remaining) = outcome;
    let mut registers = std::array::from_fn::<_, 16, _>(|i| 0x1122334400000000 + i as u64);
    for &(index, value) in input {
        registers[index] = value;
    }
    let mut result = registers;
    for &(index, value) in expected {
        result[index] = value;
    }
    wasmparser::Validator::new().validate_all(bytes).unwrap();
    json!({ "bytes": bytes, "registers": registers.map(|v| format!("{v:x}")),
        "entries": entries.iter().map(|pc| format!("{pc:x}")).collect::<Vec<_>>(),
        "flags": format!("{flags:x}"), "pc": format!("{entry:x}"), "budget": budget.to_string(),
        "expected": { "registers": result.map(|v| format!("{v:x}")),
            "flags": format!("{result_flags:x}"), "pc": format!("{result_pc:x}"),
            "reason": reason, "remaining": remaining.to_string() } })
}

#[test]
fn generated_integer_and_control_paths_match_independent_literals() {
    let mut cases = Vec::new();
    for (kind, width, dst, src, input, expected, flags) in [
        (
            Alu::Cmp,
            Width::W32,
            8,
            DataOperand::Register(RegisterView::low(9)),
            vec![(8, 0x1122334400000000), (9, 0xaabbccdd00000001)],
            vec![],
            0x97,
        ),
        (
            Alu::Add,
            Width::W64,
            0,
            DataOperand::Immediate(u64::MAX),
            vec![(0, 0)],
            vec![(0, u64::MAX)],
            0x86,
        ),
        (
            Alu::Sub,
            Width::W64,
            0,
            DataOperand::Immediate(u64::MAX),
            vec![(0, 0)],
            vec![(0, 1)],
            0x13,
        ),
        (
            Alu::Add,
            Width::W64,
            0,
            DataOperand::Immediate(1),
            vec![(0, u64::MAX)],
            vec![(0, 0)],
            0x57,
        ),
        (
            Alu::Add,
            Width::W64,
            0,
            DataOperand::Immediate(1),
            vec![(0, i64::MAX as u64)],
            vec![(0, 1 << 63)],
            0x896,
        ),
        (
            Alu::Sub,
            Width::W32,
            0,
            DataOperand::Immediate(1),
            vec![(0, 0x1234567800000000)],
            vec![(0, 0xffffffff)],
            0x97,
        ),
        (
            Alu::Add,
            Width::W32,
            0,
            DataOperand::Register(RegisterView::low(0)),
            vec![(0, 0x1234567880000000)],
            vec![(0, 0)],
            0x847,
        ),
    ] {
        cases.push(case(
            vec![Instruction {
                pc: 0x1000,
                next_pc: 0x1003,
                operation: Operation::Alu {
                    kind,
                    dst: RegisterView::low(dst),
                    src,
                    width,
                },
            }],
            &input,
            0x8d7,
            0x1000,
            1,
            (&expected, flags, 0x1003, 1, 0),
        ));
    }
    let control = vec![
        Instruction {
            pc: 0x1000,
            next_pc: 0x1004,
            operation: Operation::Alu {
                kind: Alu::Sub,
                dst: RegisterView::low(1),
                src: DataOperand::Immediate(1),
                width: Width::W64,
            },
        },
        Instruction {
            pc: 0x1004,
            next_pc: 0x1006,
            operation: Operation::Jcc {
                condition: Condition::NotEqual,
                target: 0x1000,
            },
        },
        Instruction {
            pc: 0x1006,
            next_pc: 0x100c,
            operation: Operation::Mov {
                dst: RegisterView::low(8),
                src: DataOperand::Immediate(42),
                width: Width::W32,
            },
        },
    ];
    cases.push(case(
        control.clone(),
        &[(1, 3)],
        2,
        0x1000,
        7,
        (&[(1, 0), (8, 42)], 0x46, 0x100c, 1, 0),
    ));
    cases.push(case(
        control.clone(),
        &[(1, 3)],
        2,
        0x1000,
        3,
        (&[(1, 1)], 2, 0x1004, 1, 0),
    ));
    cases.push(case(
        control,
        &[(1, 7)],
        0x42,
        0x1004,
        2,
        (&[(8, 42)], 0x42, 0x100c, 1, 0),
    ));
    for flags in [2, 0x42] {
        cases.push(case(
            vec![Instruction {
                pc: 0x7ffffffffff0,
                next_pc: 0x7ffffffffff2,
                operation: Operation::Jcc {
                    condition: Condition::NotEqual,
                    target: 0x800000000000,
                },
            }],
            &[],
            flags,
            0x7ffffffffff0,
            1,
            (
                &[],
                flags,
                if flags == 2 {
                    0x7ffffffffff0
                } else {
                    0x7ffffffffff2
                },
                if flags == 2 { 5 } else { 1 },
                if flags == 2 { 1 } else { 0 },
            ),
        ));
    }
    let mov = vec![Instruction {
        pc: 0x1000,
        next_pc: 0x1005,
        operation: Operation::Mov {
            dst: RegisterView::low(0),
            src: DataOperand::Immediate(7),
            width: Width::W32,
        },
    }];
    for (budget, stop, expected, pc, reason, remaining) in [
        (0, 0x1000, vec![], 0x1000, 1, 0),
        (3, 0x1000, vec![], 0x1000, 2, 3),
        (3, 0x1005, vec![(0, 7)], 0x1005, 2, 2),
        (1, 0x1001, vec![(0, 7)], 0x1005, 1, 0),
    ] {
        let mut c = case(
            mov.clone(),
            &[],
            0x8d7,
            0x1000,
            budget,
            (&expected, 0x8d7, pc, reason, remaining),
        );
        c["stop"] = json!(format!("{stop:x}"));
        cases.push(c);
    }
    cases.push(case(
        vec![Instruction {
            pc: u64::MAX - 4,
            next_pc: 0,
            operation: Operation::Mov {
                dst: RegisterView::low(0),
                src: DataOperand::Immediate(0),
                width: Width::W32,
            },
        }],
        &[],
        2,
        u64::MAX - 4,
        1,
        (&[(0, 0)], 2, 0, 1, 0),
    ));
    run_cases(cases);
}

#[test]
fn artifact_entry_indices_and_forward_edges_match_literal_boundaries() {
    let mut cases = Vec::new();
    for base in [0x1000, 0xffff800000001000] {
        // Both sides are discovered, so a taken forward edge skips two
        // admitted instructions rather than merely leaving the artifact.
        let conditional = compiled_fixture(
            base,
            &[
                0x75, 10, 0xb8, 17, 0, 0, 0, 0xb9, 34, 0, 0, 0, 0xba, 51, 0, 0, 0, 0x90,
            ],
            base,
        );
        assert_eq!(conditional.entries, [base, base + 2, base + 7, base + 12]);
        for (entry, flags, budget, stop, expected, next, reason, remaining) in [
            (0, 2, 2, None, vec![(2, 51)], 17, 1, 0),
            (0, 0x42, 4, None, vec![(0, 17), (1, 34), (2, 51)], 17, 1, 0),
            (0, 2, 1, None, vec![], 12, 1, 0),
            (0, 2, 5, Some(12), vec![], 12, 2, 4),
            (0, 0x42, 5, Some(12), vec![(0, 17), (1, 34)], 12, 2, 2),
            (0, 2, 1, Some(12), vec![], 12, 1, 0),
            (7, 2, 1, None, vec![(1, 34)], 12, 1, 0),
            (12, 2, 1, None, vec![(2, 51)], 17, 1, 0),
            (12, 2, 0, Some(12), vec![], 12, 1, 0),
        ] {
            let mut packet = execution_case(
                &conditional.bytes,
                &conditional.entries,
                &[],
                flags,
                base + entry,
                budget,
                (&expected, flags, base + next, reason, remaining),
            );
            if let Some(stop) = stop {
                packet["stop"] = json!(format!("{:x}", base + stop));
            }
            cases.push(packet);
        }

        let forward_jump = compiled_fixture(
            base,
            &[
                0x75, 2, 0xeb, 10, 0xb8, 17, 0, 0, 0, 0xb9, 34, 0, 0, 0, 0xba, 51, 0, 0, 0, 0x90,
            ],
            base,
        );
        assert_eq!(
            forward_jump.entries,
            [base, base + 2, base + 4, base + 9, base + 14]
        );
        cases.push(execution_case(
            &forward_jump.bytes,
            &forward_jump.entries,
            &[],
            0x42,
            base,
            3,
            (&[(2, 51)], 0x42, base + 19, 1, 0),
        ));
        cases.push(execution_case(
            &forward_jump.bytes,
            &forward_jump.entries,
            &[],
            2,
            base + 2,
            1,
            (&[], 2, base + 14, 1, 0),
        ));

        for flags in [2, 0x42] {
            let next = compiled_fixture(base, &[0x75, 0, 0xb8, 7, 0, 0, 0, 0x90], base);
            cases.push(execution_case(
                &next.bytes,
                &next.entries,
                &[],
                flags,
                base,
                2,
                (&[(0, 7)], flags, base + 7, 1, 0),
            ));
        }

        let self_jump = compiled_fixture(base, &[0xeb, 0xfe], base);
        cases.push(execution_case(
            &self_jump.bytes,
            &self_jump.entries,
            &[],
            2,
            base,
            7,
            (&[], 2, base, 1, 0),
        ));

        // Discovery starts at index one; metadata order must still select
        // the matching emitted entry, not the compilation entry by default.
        let backward = compiled_fixture(base, &[0xb8, 17, 0, 0, 0, 0xeb, 0xf9], base + 5);
        assert_eq!(backward.entries, [base, base + 5]);
        cases.push(execution_case(
            &backward.bytes,
            &backward.entries,
            &[],
            2,
            base + 5,
            2,
            (&[(0, 17)], 2, base + 5, 1, 0),
        ));

        // Overlapping instruction entries have distinct indices and effects.
        let overlapping = compiled_fixture(base, &[0x75, 1, 0xb8, 0xb9, 3, 0, 0, 0, 0x90], base);
        assert_eq!(overlapping.entries, [base, base + 2, base + 3]);
        for (entry, expected, next) in [(2, vec![(0, 0x3b9)], 7), (3, vec![(1, 3)], 8)] {
            cases.push(execution_case(
                &overlapping.bytes,
                &overlapping.entries,
                &[],
                2,
                base + entry,
                1,
                (&expected, 2, base + next, 1, 0),
            ));
        }
    }
    run_cases(cases);
}

fn compiled_fixture(base: u64, code: &[u8], entry: u64) -> crate::dbt::Artifact {
    let image = crate::memory::Image::new(base, code.to_vec(), 0x8000, vec![0; 8]).unwrap();
    crate::dbt::compile(
        &image,
        entry,
        crate::dbt::Limits {
            max_instructions: 64,
            max_source_bytes: 256,
            max_artifact_bytes: 65536,
        },
    )
    .unwrap()
}

fn run_cases(cases: Vec<Value>) {
    let input = json!({ "layout": RunState::descriptor(), "cases": cases,
        "targetOffset": std::mem::offset_of!(RunState, target) });
    // Memory imports assert literal calls; other cases forbid data access.
    // No import implements an alternative guest memory policy.
    let script = r#"
import fs from 'node:fs';
import assert from 'node:assert/strict';
const {layout:l,cases,targetOffset}=JSON.parse(fs.readFileSync(0,'utf8'));
for (const [index,c] of cases.entries()) {
 const memory=new WebAssembly.Memory({initial:1}); const d=new DataView(memory.buffer);
 c.registers.forEach((v,i)=>d.setBigUint64(l.registers+8*i,BigInt('0x'+v),true));
 d.setBigUint64(l.flags,BigInt('0x'+c.flags),true); d.setBigUint64(l.rip,BigInt('0x'+c.pc),true);
 let accessIndex=0;
 const access=(kind,args)=>{
  const expected=c.accesses?.[accessIndex++];assert(expected,'unexpected '+kind+' import');
  assert.deepEqual({kind,args},{kind:expected.kind,args:expected.args},'memory import '+index);
  return expected.result;
 };
 const bits=v=>BigInt.asUintN(64,v).toString(16);
 const load=(address,width)=>BigInt('0x'+access('load',[bits(address),width]));
 const load_for_write=(address,width)=>BigInt('0x'+access('load_for_write',[bits(address),width]));
 const store=(address,width,value)=>access('store',[bits(address),width,bits(value)]);
 const access_failed=()=>access('access_failed',[]);
 const {instance}=await WebAssembly.instantiate(Uint8Array.from(c.bytes),{env:{memory,load,load_for_write,store,access_failed}});
 assert.equal(instance.exports.run.length,5,'generated run ABI includes the entry index');
 const snapshot=reason=>{
  const flags=d.getBigUint64(l.flags,true);
  assert.equal(flags&~0x8d7n,0n,'valid flag word '+index);
  assert.equal(flags&2n,2n,'reserved flag bit '+index);
  return {registers:Array.from({length:16},(_,i)=>d.getBigUint64(l.registers+8*i,true).toString(16)),
   flags:flags.toString(16),pc:d.getBigUint64(l.rip,true).toString(16),
   reason,remaining:d.getBigUint64(l.remaining,true).toString()};
 };
 const entryIndex=c.entries.indexOf(c.pc);assert(entryIndex>=0,'entry must belong to the artifact');
 const reason=instance.exports.run(0,BigInt(c.budget),BigInt('0x'+(c.stop??'0')),c.stop===undefined?0:1,entryIndex);
 const actual=snapshot(reason);
 const flagWord=BigInt('0x'+actual.flags);
 if(c.flagMask!==undefined) actual.flags=(flagWord&BigInt('0x'+c.flagMask)).toString(16);
 assert.deepEqual(actual,c.expected,'generated case '+index);
 if(c.target!==undefined) assert.equal(d.getBigUint64(targetOffset,true).toString(16),c.target,'executed target '+index);
 if(c.preservingSuffix!==undefined){
  const suffix=c.preservingSuffix;
  const savedFlags=suffix.flags===undefined?flagWord:BigInt('0x'+suffix.flags);
  d.setBigUint64(l.flags,savedFlags,true);d.setBigUint64(l.rip,BigInt('0x'+suffix.pc),true);
  const suffixIndex=c.entries.indexOf(suffix.pc);assert(suffixIndex>=0,'suffix entry belongs to the artifact');
  const suffixReason=instance.exports.run(0,BigInt(suffix.budget),0n,0,suffixIndex);
  assert.deepEqual(snapshot(suffixReason),{...suffix.expected,flags:savedFlags.toString(16)},'preserving suffix '+index);
 }
 assert.equal(accessIndex,c.accesses?.length??0,'memory import count '+index);
}
"#;
    let mut child = Command::new("node")
        .args(["--input-type=module", "-e", script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    serde_json::to_writer(child.stdin.take().unwrap(), &input).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
