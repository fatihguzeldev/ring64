use super::*;

fn literal(code: &[u8], input: &[(usize, u64)], expected: &[(usize, u64)], flags: u64) -> Value {
    let artifact = compiled_fixture(0x1000, code, 0x1000);
    let mut value = execution_case(
        &artifact.bytes,
        &artifact.entries,
        input,
        0x8d7,
        0x1000,
        1,
        (expected, flags, 0x1000 + code.len() as u64, 1, 0),
    );
    value["flagMask"] = json!("803");
    value
}

#[test]
fn products_commit_complete_pairs_and_signed_overflow() {
    run_cases(vec![
        literal(
            &[0xf6, 0xe4],
            &[(0, 0x1122334455660305)],
            &[(0, 0x112233445566000f)],
            2,
        ),
        literal(
            &[0xf6, 0xec],
            &[(0, 0x112233445566fe80)],
            &[(0, 0x1122334455660100)],
            0x803,
        ),
        literal(
            &[0x66, 0xf7, 0xe1],
            &[(0, 0x112233445566ffff), (1, 2), (2, 0x99aabbccddeeff11)],
            &[(0, 0x112233445566fffe), (2, 0x99aabbccddee0001)],
            0x803,
        ),
        literal(
            &[0xf7, 0xe1],
            &[(0, 0x11223344ffffffff), (1, 2)],
            &[(0, 0xfffffffe), (2, 1)],
            0x803,
        ),
        literal(
            &[0x0f, 0xaf, 0xc1],
            &[(0, 0x1122334480000000), (1, 2)],
            &[(0, 0)],
            0x803,
        ),
        literal(
            &[0x66, 0x69, 0xc1, 0xff, 0xff],
            &[(1, 0x8000)],
            &[(0, 0x1122334400008000)],
            0x803,
        ),
    ]);
}

#[test]
fn wide_products_pass_captured_operands_to_the_exact_high_half_primitive() {
    let mut cases = vec![
        literal(
            &[0x48, 0xf7, 0xe0],
            &[(0, u64::MAX)],
            &[(0, 1), (2, u64::MAX - 1)],
            0x803,
        ),
        literal(
            &[0x48, 0xf7, 0xe9],
            &[(0, u64::MAX), (1, 2)],
            &[(0, u64::MAX - 1), (2, u64::MAX)],
            2,
        ),
        literal(
            &[0x48, 0x6b, 0xc1, 0xff],
            &[(1, 1 << 63)],
            &[(0, 1 << 63)],
            0x803,
        ),
    ];
    for (case, (args, high)) in cases.iter_mut().zip([
        (
            json!(["ffffffffffffffff", "ffffffffffffffff", 0]),
            "fffffffffffffffe",
        ),
        (json!(["2", "ffffffffffffffff", 1]), "ffffffffffffffff"),
        (json!(["8000000000000000", "ffffffffffffffff", 1]), "0"),
    ]) {
        case["accesses"] = json!([{ "kind": "multiply_high", "args": args, "result": high }]);
    }
    run_cases(cases);
}

#[test]
fn divisions_use_the_full_dividend_and_commit_only_in_range() {
    let mut cases = vec![
        literal(
            &[0xf6, 0xf9],
            &[(0, 0x112233445566fff9), (1, 3)],
            &[(0, 0x112233445566fffe)],
            2,
        ),
        literal(
            &[0xf7, 0xf9],
            &[
                (0, 0x1122334480000000),
                (1, 0xffffffff),
                (2, 0x99aabbcc00000000),
            ],
            &[(0, 0x80000000), (2, 0)],
            2,
        ),
        literal(
            &[0xf6, 0xf1],
            &[(0, 0x1122334455660100), (1, 1)],
            &[],
            0x8d7,
        ),
    ];
    for case in &mut cases[..2] {
        case["flagMask"] = json!("2");
    }
    cases[2].as_object_mut().unwrap().remove("flagMask");
    cases[2]["expected"]["reason"] = json!(9);
    cases[2]["expected"]["remaining"] = json!("1");
    cases[2]["expected"]["pc"] = json!("1000");
    run_cases(cases);
}

#[test]
fn wide_quotients_and_primitive_failures_precede_every_architectural_write() {
    let mut cases = Vec::new();
    for (signed, high, low, divisor, quotient, remainder) in [
        (false, 1, 0, 2, Some(1 << 63), 0),
        (false, 1, u64::MAX, 2, Some(u64::MAX), 1),
        (
            false,
            u64::MAX - 1,
            u64::MAX,
            u64::MAX,
            Some(u64::MAX),
            u64::MAX - 1,
        ),
        (true, 1, 0, 3, Some(0x5555555555555555), 1),
        (true, u64::MAX, 0, 3, Some(0xaaaaaaaaaaaaaaab), u64::MAX),
        (true, 0, 1 << 63, u64::MAX, Some(1 << 63), 0),
        (true, u64::MAX, u64::MAX, 1 << 63, Some(0), u64::MAX),
        (false, 2, 0, 2, None, 0),
        (true, 0, 1 << 63, 1, None, 0),
        (true, u64::MAX, 1 << 63, u64::MAX, None, 0),
        (true, 1 << 63, 0, u64::MAX, None, 0),
    ] {
        let artifact = compiled_fixture(
            0x1000,
            &[0x48, 0xf7, if signed { 0xf9 } else { 0xf1 }],
            0x1000,
        );
        let writes = quotient
            .map(|q| vec![(0, q), (2, remainder)])
            .unwrap_or_default();
        let mut case = execution_case(
            &artifact.bytes,
            &artifact.entries,
            &[(0, low), (1, divisor), (2, high)],
            0x8d7,
            0x1000,
            1,
            (
                &writes,
                if quotient.is_some() { 2 } else { 0x8d7 },
                if quotient.is_some() { 0x1003 } else { 0x1000 },
                if quotient.is_some() { 1 } else { 9 },
                u64::from(quotient.is_none()),
            ),
        );
        if quotient.is_some() {
            case["flagMask"] = json!("2");
        }
        case["accesses"] = json!([
            {"kind":"divide", "args":[format!("{high:x}"),format!("{low:x}"),format!("{divisor:x}"),i32::from(signed)], "result":format!("{:x}",quotient.unwrap_or(0))},
            {"kind":"divide_failed", "args":[], "result":i32::from(quotient.is_none())}
        ]);
        cases.push(case);
    }
    run_cases(cases);
}

#[test]
fn source_reads_are_read_only_and_win_over_provable_divide_errors() {
    let mut cases = Vec::new();
    for code in [
        vec![0x48, 0xf7, 0x23],
        vec![0x48, 0x0f, 0xaf, 0x03],
        vec![0x48, 0xf7, 0x33],
        vec![0x48, 0xf7, 0x3b],
    ] {
        let artifact = compiled_fixture(0x1000, &code, 0x1000);
        let mut case = execution_case(
            &artifact.bytes,
            &artifact.entries,
            &[(0, u64::MAX), (2, u64::MAX), (3, 0x800000000000)],
            0x8d7,
            0x1000,
            1,
            (&[], 0x8d7, 0x1000, 6, 1),
        );
        case["accesses"] = json!([
            {"kind":"load", "args":["800000000000",8], "result":"0"},
            {"kind":"access_failed", "args":[], "result":1}
        ]);
        cases.push(case);
    }
    run_cases(cases);
}

#[test]
fn byte_products_and_division_boundaries_match_independent_integer_oracles() {
    let modules = [[0xf6, 0xe4], [0xf6, 0xec], [0xf6, 0xf1], [0xf6, 0xf9]]
        .map(|code| compiled_fixture(0x1000, &code, 0x1000).bytes);
    let input = json!({"layout": RunState::descriptor(), "modules": modules});
    let script = r#"
import fs from 'node:fs';
import assert from 'node:assert/strict';
const {layout:l,modules}=JSON.parse(fs.readFileSync(0,'utf8'));
const signed=(n,w)=>n>=2**(w-1)?n-2**w:n;
const guard=0x1122334455660000n, rcx=0x99aabbccddee0000n;
let checked=0;
for(const [operation,bytes] of modules.entries()){
 const memory=new WebAssembly.Memory({initial:1}),d=new DataView(memory.buffer);
 const forbidden=()=>{throw new Error('byte arithmetic called an import')};
 const {instance}=await WebAssembly.instantiate(Uint8Array.from(bytes),{env:{memory,load:forbidden,store:forbidden,access_failed:forbidden}});
 for(let i=1;i<16;i++)d.setBigUint64(l.registers+8*i,0x1122334400000000n+BigInt(i),true);
 const check=(ax,divisor,initialFlags)=>{
  const multiply=operation<2,sgn=operation%2===1;
  let fail=false,expected,overflow=false;
  if(multiply){
   const a=sgn?signed(ax&255,8):ax&255,b=sgn?signed(ax>>>8,8):ax>>>8;
   const product=a*b;overflow=sgn?(product < -128 || product > 127):product>255;
   expected=((product%65536)+65536)%65536;
  }else{
   const n=sgn?signed(ax,16):ax,den=sgn?signed(divisor,8):divisor;
   const q=den===0?0:Math.trunc(n/den),r=n-q*den;
   fail=den===0 || (sgn?(q < -128 || q > 127):(q < 0 || q > 255));
   expected=fail?ax:((q&255)|((r&255)<<8));
   d.setBigUint64(l.registers+8,rcx+BigInt(divisor),true);
  }
  d.setBigUint64(l.registers,guard+BigInt(ax),true);
  d.setBigUint64(l.flags,initialFlags,true);d.setBigUint64(l.rip,0x1000n,true);
  const reason=instance.exports.run(0,1n,0n,0,0),flags=d.getBigUint64(l.flags,true);
  const context=`op=${operation},AX=${ax},D=${divisor},flags=${initialFlags}`;
  assert.equal(reason,fail?9:1,context);
  assert.equal(d.getBigUint64(l.registers,true),guard+BigInt(expected),context);
  assert.equal(flags&~0x8d7n,0n,context);assert.equal(flags&2n,2n,context);
  if(multiply)assert.equal(flags&0x803n,overflow?0x803n:2n,context);
  if(fail)assert.equal(flags,initialFlags,context);
  assert.equal(d.getBigUint64(l.rip,true),fail?0x1000n:0x1002n,context);
  assert.equal(d.getBigUint64(l.remaining,true),fail?1n:0n,context);
  checked++;
 };
 for(const initialFlags of [2n,0x8d7n]){
  if(operation<2){
   for(let a=0;a<256;a++)for(let b=0;b<256;b++)check(a+256*b,0,initialFlags);
  }else{
   for(let divisor=0;divisor<256;divisor++){
    if([0,1,2,3,127,128,255].includes(divisor)){
     for(let ax=0;ax<65536;ax++)check(ax,divisor,initialFlags);
    }else{
     const den=operation===3?signed(divisor,8):divisor;
     const values=new Set([0,1,32767,32768,65535]);
     for(const q of [-129,-128,-127,-1,0,1,126,127,128,254,255,256]){
      for(const r of [0,1,-1,Math.abs(den)-1,1-Math.abs(den)]){
       const n=q*den+r;
       if(operation===3 && n>=-32768 && n<=32767)values.add((n+65536)%65536);
       if(operation===2 && n>=0 && n<=65535)values.add(n);
      }
     }
     for(const ax of values)check(ax,divisor,initialFlags);
    }
   }
  }
 }
 for(let i=operation<2?1:2;i<16;i++)assert.equal(d.getBigUint64(l.registers+8*i,true),0x1122334400000000n+BigInt(i));
}
console.log('checked '+checked+' actual generated-Wasm byte arithmetic cases');
"#;
    run_node(input, script);
}

fn run_node(input: Value, script: &str) {
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
    println!("{}", String::from_utf8_lossy(&output.stdout));
}
