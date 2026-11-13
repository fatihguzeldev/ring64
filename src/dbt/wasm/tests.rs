mod addressing;
mod arithmetic_bits;
mod bits;
mod code_validity;
mod conditions;
mod counts;
mod data_widths;
mod df;
mod exchange;
mod external_interrupts;
mod far;
mod float;
mod integer_memory;
mod logical;
mod mmx;
mod mode_context;
mod multiply_divide;
mod near_stack;
mod numeric_state;
mod paging;
mod processor;
mod protection;
mod routing;
mod software_events;
mod stack;
mod streaming;
mod strings;
mod system_flags;
mod system_lifetime;
mod task;
mod vector;
mod x87;

use super::*;
use crate::embedding::layout::RunState;
use crate::x86::instruction::{
    Alu, Condition, DataOperand, Instruction, Operand, Operation, RegisterView, Width,
};
use serde_json::{Value, json};
use std::process::{Command, Stdio};

fn unit(instructions: Vec<Instruction>) -> Unit {
    Unit {
        context: crate::x86::context::ExecutionContext::default(),
        source_bytes: instructions.len(),
        source_ranges: vec![],
        read_dependencies: vec![],
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
                0x75, 10, 0xb8, 17, 0, 0, 0, 0xb9, 34, 0, 0, 0, 0xba, 51, 0, 0, 0, 0x82,
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
                0x75, 2, 0xeb, 10, 0xb8, 17, 0, 0, 0, 0xb9, 34, 0, 0, 0, 0xba, 51, 0, 0, 0, 0x82,
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
            let next = compiled_fixture(base, &[0x75, 0, 0xb8, 7, 0, 0, 0, 0x82], base);
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
        let overlapping = compiled_fixture(base, &[0x75, 1, 0xb8, 0xb9, 3, 0, 0, 0, 0x60], base);
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
 // Expected allowances are authored literals, not values returned by the generated run.
 if(c.time===undefined){c.time={tsc:'0',tscAux:0};c.expected.time={tsc:(BigInt(c.budget)-BigInt(c.expected.remaining)).toString(),tscAux:0}}
 if(c.preservingSuffix){const suffix=c.preservingSuffix;suffix.expected.time??={tsc:BigInt.asUintN(64,BigInt(c.expected.time.tsc)+BigInt(suffix.budget)-BigInt(suffix.expected.remaining)).toString(),tscAux:c.expected.time.tscAux}}
 const memory=new WebAssembly.Memory({initial:1}); const d=new DataView(memory.buffer);
 c.registers.forEach((v,i)=>d.setBigUint64(l.registers+8*i,BigInt('0x'+v),true));
 d.setBigUint64(l.flags,BigInt('0x'+c.flags),true); d.setBigUint64(l.rip,BigInt('0x'+c.pc),true);
 if(c.interruptibility!==undefined)d.setUint32(l.interruptibility,c.interruptibility,true);
 if(c.irq!==undefined)d.setUint32(l.interrupts.offset+l.interrupts.irq,c.irq+1,true);
 if(c.nmiPending)d.setUint32(l.interrupts.offset+l.interrupts.nmiPending,1,true);
 if(c.repeatBudget!==undefined)d.setBigUint64(l.repeatRemaining,BigInt(c.repeatBudget),true);
 if(c.time){d.setBigUint64(l.time.offset+l.time.tsc,BigInt(c.time.tsc),true);d.setUint32(l.time.offset+l.time.tscAux,c.time.tscAux,true)}
 const xmmOffset=l.xmm??176,scratch=l.vectorScratch??432;
 if(c.mxcsr!==undefined)d.setUint32(l.mxcsr,Number(c.mxcsr),true);
 const read128=pointer=>(d.getBigUint64(pointer,true)|(d.getBigUint64(pointer+8,true)<<64n)).toString(16);
 const fp=l.x87,fpBase=fp.offset;
 const read80=pointer=>{let raw=0n;for(let i=9;i>=0;i--)raw=(raw<<8n)|BigInt(d.getUint8(pointer+i));return raw.toString(16)};
 if(c.x87){for(let bank=0;bank<8;bank++){let raw=BigInt('0x'+c.x87.registers[bank]);for(let i=0;i<10;i++){d.setUint8(fpBase+fp.registers+10*bank+i,Number(raw&255n));raw>>=8n}}for(const field of ['controlWord','statusWord','tagWord','opcode'])d.setUint16(fpBase+fp[field],c.x87[field],true);for(const field of ['instructionPointer','dataPointer'])d.setBigUint64(fpBase+fp[field],BigInt('0x'+c.x87[field]),true)}
 if(c.xmm)c.xmm.forEach((v,i)=>{const bits=BigInt('0x'+v);d.setBigUint64(xmmOffset+16*i,BigInt.asUintN(64,bits),true);d.setBigUint64(xmmOffset+16*i+8,bits>>64n,true)});
 let accessIndex=0;
 const access=(kind,args)=>{
  const expected=c.accesses?.[accessIndex++];assert(expected,'unexpected '+kind+' import');
  assert.deepEqual({kind,args},{kind:expected.kind,args:expected.args},'memory import '+index);
  if(expected.canonicalAc!==undefined)assert.equal((d.getBigUint64(l.flags,true)&0x40000n)!==0n,expected.canonicalAc,'live canonical AC before '+kind);
  return expected.result;
 };
 const bits=v=>BigInt.asUintN(64,v).toString(16);
 const load=(address,width)=>BigInt('0x'+access('load',[bits(address),width]));
 const load_for_write=(address,width)=>BigInt('0x'+access('load_for_write',[bits(address),width]));
 const store=(address,width,value)=>access('store',[bits(address),width,bits(value)]);
 const access_failed=()=>access('access_failed',[]);
 const segmented_access_failed=()=>access('segmented_access_failed',[]);
 const segmented_load=(address,width,segment)=>BigInt('0x'+access('segmented_load',[bits(address),width,segment]));
 const segmented_load_for_write=(address,width,segment)=>BigInt('0x'+access('segmented_load_for_write',[bits(address),width,segment]));
 const segmented_store=(address,width,value,segment)=>access('segmented_store',[bits(address),width,bits(value),segment]);
 const access_reason=()=>access('access_reason',[]);
 const target_check=target=>access('target_check',[bits(target)]);
 const multiply_high=(a,b,signed)=>BigInt('0x'+access('multiply_high',[bits(a),bits(b),signed]));
 const divide=(high,low,divisor,signed)=>BigInt('0x'+access('divide',[bits(high),bits(low),bits(divisor),signed]));
 const divide_failed=()=>access('divide_failed',[]);
 const vector_load=(address,width,segment,alignment)=>{const value=access('vector_load',[bits(address),width,segment,alignment]);if(value===null)return 0;const v=BigInt('0x'+value);d.setBigUint64(scratch,BigInt.asUintN(64,v),true);d.setBigUint64(scratch+8,v>>64n,true);return scratch};
 const vector_store=(address,width,segment,alignment,pointer)=>access('vector_store',[bits(address),width,segment,alignment,read128(pointer)]);
 const masked_store=(address,width,pointer,mask,segment)=>{assert.equal(pointer,scratch,'shared masked-store scratch');return access('masked_store',[bits(address),width,read128(pointer),mask,segment])};
 const clflush=(address,segment)=>access('clflush',[bits(address),segment]);
 const far_control=(op,operand,selector,sp,next,segment)=>{const result=access('far_control',[op,bits(operand),selector,bits(sp),bits(next),segment]);if(result.pc!==undefined)d.setBigUint64(scratch,BigInt('0x'+result.pc),true);if(result.sp!==undefined)d.setBigUint64(scratch+8,BigInt('0x'+result.sp),true);return result.reason};
 const software_event=(op,sp,full,next)=>{const result=access('software_event',[op,bits(sp),bits(full),bits(next)]);if(result.pc!==undefined)d.setBigUint64(scratch,BigInt('0x'+result.pc),true);if(result.sp!==undefined)d.setBigUint64(scratch+8,BigInt('0x'+result.sp),true);if(result.flags!==undefined)d.setBigUint64(l.flags,BigInt('0x'+result.flags),true);return result.reason};
 const flags=(op,full,input)=>{const result=access('flags',[op,bits(full),bits(input)]);if(result.value!==undefined)d.setBigUint64(scratch,BigInt('0x'+result.value),true);return result.reason};
 const debug_begin=()=>0;
 const debug_finish=(pc,resume,completed,full,decision)=>(decision&1)&&!((decision&4)&&!(decision&2))?debug_step(pc,resume,completed,full):0;
 const debug_step=(pc,resume,completed,full)=>access('debug_step',[bits(pc),bits(resume),completed,bits(full)]);
 const external_step=(pc,full,shadow)=>access('external_step',[bits(pc),bits(full),shadow]);
 const halt=full=>access('halt',[bits(full)]);
 const paging_control=(kind,register,value,pc,full,retired)=>{const result=access('paging_control',[kind,register,bits(value),bits(pc),bits(full),bits(retired)]);if(result.value!==undefined)d.setBigUint64(scratch,BigInt('0x'+result.value),true);if(result.timeBase!==undefined)d.setBigUint64(l.time.offset+l.time.tsc,BigInt(result.timeBase),true);return result.reason};
 const processor=(kind,eax,ecx,retired)=>{const result=access('processor',[kind,eax,ecx,bits(retired)]);if(result.words)result.words.forEach((v,i)=>d.setUint32(scratch+4*i,v,true));return result.reason};
 const protection=(op,address,input,segment)=>{const result=access('protection',[op,bits(address),bits(input),segment]);if(result.value!==undefined)d.setBigUint64(scratch,BigInt('0x'+result.value),true);d.setUint8(scratch+8,result.control??0);return result.reason};
 const float=(op,leftlo,lefthi,rightlo,righthi)=>{const result=access('float',[op,bits(leftlo),bits(lefthi),bits(rightlo),bits(righthi)]);if(result.mxcsr!==undefined)d.setUint32(l.mxcsr,result.mxcsr,true);if(result.value!==undefined){const value=BigInt('0x'+result.value);d.setBigUint64(scratch,BigInt.asUintN(64,value),true);d.setBigUint64(scratch+8,value>>64n,true)}return result.reason};
 const load_mxcsr=(address,segment)=>{const result=access('load_mxcsr',[bits(address),segment]);if(result.mxcsr!==undefined)d.setUint32(l.mxcsr,result.mxcsr,true);return result.reason};
 const store_mxcsr=(address,segment)=>access('store_mxcsr',[bits(address),segment,d.getUint32(l.mxcsr,true)]);
 const x87=(op,address,segment,pc,flags,rax)=>{const result=access('x87',[op,bits(address),segment,bits(pc),bits(flags),bits(rax)]);if(result.flags!==undefined)d.setBigUint64(l.flags,BigInt('0x'+result.flags),true);if(result.rax!==undefined)d.setBigUint64(l.registers,BigInt('0x'+result.rax),true);return result.reason};
 const numericState=(kind,op,address,segment)=>{const result=access(kind,[op,bits(address),segment]);for(const [bank,value] of Object.entries(result.xmmBefore??{}))assert.equal(read128(xmmOffset+16*Number(bank)),value,'live XMM before '+kind);for(const [bank,value] of Object.entries(result.xmm??{})){const raw=BigInt('0x'+value),offset=xmmOffset+16*Number(bank);d.setBigUint64(offset,BigInt.asUintN(64,raw),true);d.setBigUint64(offset+8,raw>>64n,true)}for(const [bank,value] of Object.entries(result.registers??{}))d.setBigUint64(l.registers+8*Number(bank),BigInt('0x'+value),true);return result.reason};
 const mmx=(...args)=>numericState('mmx',...args),numeric_image=(...args)=>numericState('numeric_image',...args);
 const {instance}=await WebAssembly.instantiate(Uint8Array.from(c.bytes),{env:{memory,load,load_for_write,store,access_failed,segmented_access_failed,segmented_load,segmented_load_for_write,segmented_store,access_reason,target_check,multiply_high,divide,divide_failed,vector_load,vector_store,masked_store,clflush,protection,far_control,software_event,flags,debug_begin,debug_step,debug_finish,external_step,halt,paging_control,processor,float,load_mxcsr,store_mxcsr,x87,mmx,numeric_image}});
 assert.equal(instance.exports.run.length,5,'generated run ABI includes the entry index');
 const snapshot=reason=>{
  const flags=d.getBigUint64(l.flags,true);
  assert.equal(flags&~0x3d7fd7n,0n,'valid flag word '+index);
  assert.equal(flags&2n,2n,'reserved flag bit '+index);
  return {registers:Array.from({length:16},(_,i)=>d.getBigUint64(l.registers+8*i,true).toString(16)),
   flags:flags.toString(16),pc:d.getBigUint64(l.rip,true).toString(16),
   reason,remaining:d.getBigUint64(l.remaining,true).toString(),
   ...(c.interruptibility===undefined?{}:{interruptibility:d.getUint32(l.interruptibility,true)}),
   ...(c.time===undefined?{}:{time:{tsc:d.getBigUint64(l.time.offset+l.time.tsc,true).toString(),tscAux:d.getUint32(l.time.offset+l.time.tscAux,true)}}),
   ...(c.mxcsr===undefined?{}:{mxcsr:d.getUint32(l.mxcsr,true)}),
   ...(c.xmm===undefined?{}:{xmm:Array.from({length:16},(_,i)=>read128(xmmOffset+16*i))}),
   ...(c.x87===undefined?{}:{x87:{registers:Array.from({length:8},(_,i)=>read80(fpBase+fp.registers+10*i)),...Object.fromEntries(['controlWord','statusWord','tagWord','opcode'].map(field=>[field,d.getUint16(fpBase+fp[field],true)])),...Object.fromEntries(['instructionPointer','dataPointer'].map(field=>[field,d.getBigUint64(fpBase+fp[field],true).toString(16)]))}}),
   ...(c.repeatBudget===undefined?{}:{repeatRemaining:d.getBigUint64(l.repeatRemaining,true).toString()})};
 };
 const entryIndex=c.entries.indexOf(c.pc);assert(entryIndex>=0,'entry must belong to the artifact');
 const reason=instance.exports.run(0,BigInt(c.budget),BigInt('0x'+(c.stop??'0')),c.stop===undefined?0:1,entryIndex);
 const actual=snapshot(reason);
 const flagWord=BigInt('0x'+actual.flags);
 if(c.flagMask!==undefined) actual.flags=(flagWord&BigInt('0x'+c.flagMask)).toString(16);
 assert.deepEqual(actual,c.expected,'generated case '+index);
 if(c.target!==undefined) assert.equal(d.getBigUint64(targetOffset,true).toString(16),c.target,'executed target '+index);
 if(c.faultSegment!==undefined) assert.equal(d.getUint32(l.faultSegment,true),c.faultSegment,'fault segment '+index);
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
