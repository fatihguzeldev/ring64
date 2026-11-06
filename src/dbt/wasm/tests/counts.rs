use super::*;

#[test]
fn count_literals_distinguish_masked_effective_and_full_width_counts() {
    let mut cases = Vec::new();
    for (code, a, c, result, mask, flags) in [
        (
            vec![0xc1, 0xe0, 0x20],
            0x1122334455667788,
            1,
            0x55667788,
            0x8d7,
            0x8d7,
        ),
        (
            vec![0xc0, 0xe0, 1],
            0x1122334455667780,
            1,
            0x1122334455667700,
            0x8c7,
            0x847,
        ),
        (
            vec![0xc0, 0xe8, 1],
            0x1122334455667780,
            1,
            0x1122334455667740,
            0x8c7,
            0x802,
        ),
        (
            vec![0xc0, 0xf8, 1],
            0x1122334455667781,
            1,
            0x11223344556677c0,
            0x8c7,
            0x87,
        ),
        (
            vec![0xc0, 0xe0, 8],
            0x1122334455667780,
            1,
            0x1122334455667700,
            0xc6,
            0x46,
        ),
        (
            vec![0xc0, 0xc0, 8],
            0x1122334455667780,
            1,
            0x1122334455667780,
            0xd7,
            0xd6,
        ),
        (
            vec![0xc0, 0xd0, 9],
            0x1122334455667788,
            1,
            0x1122334455667788,
            0xd7,
            0xd7,
        ),
        (
            vec![0xc0, 0xd0, 10],
            0x1122334455667788,
            1,
            0x1122334455667711,
            0xd7,
            0xd7,
        ),
        (
            vec![0xc1, 0xd0, 0x21],
            0x1122334455667788,
            1,
            0xaaccef11,
            0x8d7,
            0x8d6,
        ),
        (
            vec![0x48, 0xc1, 0xd0, 0x41],
            0x1122334455667788,
            1,
            0x22446688aaccef11,
            0x8d7,
            0xd6,
        ),
        (
            vec![0x66, 0x0f, 0xa4, 0xc8, 16],
            0x1122334455660001,
            0x1234,
            0x1122334455661234,
            0xc7,
            3,
        ),
        (
            vec![0x66, 0x0f, 0xac, 0xc8, 16],
            0x1122334455660001,
            0x1234,
            0x1122334455661234,
            0xc7,
            2,
        ),
    ] {
        let artifact = compiled_fixture(0x1000, &code, 0x1000);
        let mut packet = execution_case(
            &artifact.bytes,
            &artifact.entries,
            &[(0, a), (1, c)],
            0x8d7,
            0x1000,
            1,
            (&[(0, result)], flags, 0x1000 + code.len() as u64, 1, 0),
        );
        packet["flagMask"] = json!(format!("{mask:x}"));
        cases.push(packet);
    }
    run_cases(cases);
}

fn script(input: Value, source: &str) {
    let mut child = Command::new("node")
        .args(["--input-type=module", "-e", source])
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

#[test]
fn every_byte_value_count_and_carry_matches_one_bit_shift_and_rotate_steps() {
    let modules = [0, 1, 2, 3, 4, 5, 7]
        .map(|selector| compiled_fixture(0x1000, &[0xd2, 0xc4 | selector << 3], 0x1000).bytes);
    script(
        json!({"layout":RunState::descriptor(),"modules":modules}),
        r#"
import fs from 'node:fs';
import assert from 'node:assert/strict';
const {layout:l,modules}=JSON.parse(fs.readFileSync(0,'utf8'));
const kinds=['rol','ror','rcl','rcr','shl','shr','sar'];
const parity=Array.from({length:256},(_,v)=>v.toString(2).replaceAll('0','').length%2===0);
function expected(kind,start,raw,flags){
 const k=raw%32;
 if(k===0)return {value:start,flags,mask:0x8d7};
 const rotate=['rol','ror','rcl','rcr'].includes(kind);
 const n=kind==='rol'||kind==='ror'?k%8:kind==='rcl'||kind==='rcr'?k%9:k;
 let value=start,cf=flags%2;
 for(let step=0;step<n;step++){
  const low=value%2,high=Math.floor(value/128);
  if(kind==='shl'||kind==='rol'||kind==='rcl'){
   value=(value*2)%256+(kind==='rol'?high:kind==='rcl'?cf:0);cf=high;
  }else{
   value=Math.floor(value/2)+(kind==='sar'?high:kind==='ror'?low:kind==='rcr'?cf:0)*128;cf=low;
  }
 }
 if(kind==='rol')cf=value%2;
 if(kind==='ror')cf=Math.floor(value/128);
 let mask=rotate?0xd7:0xc6;
 let result=rotate?flags&0xd6:2+4*Number(parity[value])+64*Number(value===0)+128*Number(value>=128);
 if(rotate||kind==='sar'||k<8){mask+=rotate?0:1;result+=cf;}
 if(k===1){
  const high=Math.floor(value/128),second=Math.floor(value/64)%2;
  const of=kind==='sar'?0:kind==='shr'?Math.floor(start/128):kind==='ror'||kind==='rcr'?high^second:high^cf;
  mask+=0x800;result+=of*0x800;
 }
 return {value,flags:result,mask};
}
const guard=0x112233445566005an;
for(const [kindIndex,bytes]of modules.entries()){
 const memory=new WebAssembly.Memory({initial:1}),d=new DataView(memory.buffer);
 const forbidden=()=>{throw Error('register count operation accessed memory')};
 const {instance}=await WebAssembly.instantiate(Uint8Array.from(bytes),{env:{memory,load:forbidden,store:forbidden,access_failed:forbidden}});
 for(let r=2;r<16;r++)d.setBigUint64(l.registers+r*8,0x1122334400000000n+BigInt(r),true);
 for(let carry=0;carry<2;carry++)for(let raw=0;raw<256;raw++)for(let value=0;value<256;value++){
  const flags=0x8d6+carry,want=expected(kinds[kindIndex],value,raw,flags);
  d.setBigUint64(l.registers,guard+BigInt(value)*256n,true);
  const counter=0x8877665544332200n+BigInt(raw);
  d.setBigUint64(l.registers+8,counter,true);
  d.setBigUint64(l.flags,BigInt(flags),true);d.setBigUint64(l.rip,0x1000n,true);
  const reason=instance.exports.run(0,1n,0n,0,0),actualFlags=d.getBigUint64(l.flags,true);
  const context=`${kinds[kindIndex]} AH=${value}, CL=${raw}, CF=${carry}`;
  assert.equal(reason,1,context);
  assert.equal(d.getBigUint64(l.registers,true),guard+BigInt(want.value)*256n,context);
  assert.equal(d.getBigUint64(l.registers+8,true),counter,context);
  assert.equal(actualFlags&BigInt(want.mask),BigInt(want.flags&want.mask),context);
  assert.equal(actualFlags&~0x8d7n,0n,context);assert.equal(actualFlags&2n,2n,context);
  assert.equal(d.getBigUint64(l.rip,true),0x1002n,context);
  assert.equal(d.getBigUint64(l.remaining,true),0n,context);
 }
 for(let r=2;r<16;r++)assert.equal(d.getBigUint64(l.registers+r*8,true),0x1122334400000000n+BigInt(r));
}
"#,
    );
}

#[test]
fn wide_counts_and_double_shifts_match_bit_vectors_and_incoming_aliases() {
    let mut modules = Vec::new();
    for (width, prefix) in [(16, vec![0x66]), (32, vec![]), (64, vec![0x48])] {
        for selector in [0, 1, 2, 3, 4, 5, 7] {
            let mut code = prefix.clone();
            code.extend([0xd3, 0xc0 | selector << 3]);
            modules.push(json!({"width":width,"kind":selector,"length":code.len(),
                "bytes":compiled_fixture(0x1000,&code,0x1000).bytes}));
        }
        for right in [false, true] {
            let mut code = prefix.clone();
            code.extend([0x0f, if right { 0xad } else { 0xa5 }, 0xd0]);
            modules.push(
                json!({"width":width,"kind":if right {9}else{8},"length":code.len(),
                "bytes":compiled_fixture(0x1000,&code,0x1000).bytes}),
            );
            let mut aliased = prefix.clone();
            aliased.extend([0x0f, if right { 0xad } else { 0xa5 }, 0xc9]);
            modules.push(
                json!({"width":width,"kind":if right {9}else{8},"alias":true,"length":aliased.len(),
                "bytes":compiled_fixture(0x1000,&aliased,0x1000).bytes}),
            );
        }
    }
    script(
        json!({"layout":RunState::descriptor(),"modules":modules}),
        r#"
import fs from 'node:fs';
import assert from 'node:assert/strict';
const {layout:l,modules}=JSON.parse(fs.readFileSync(0,'utf8'));
const parity=value=>value.toString(2).replaceAll('0','').length%2===0;
const bitVector=(v,w)=>Array.from({length:w},(_,i)=>Number(v/2n**BigInt(i)%2n));
const number=bits=>bits.reduce((v,b,i)=>v+BigInt(b)*2n**BigInt(i),0n);
function oracle(kind,a,b,width,raw,flags){
 const k=raw%(width===64?64:32);
 if(k===0)return {result:a,flags,mask:0x8d7n};
 if(kind>=8&&k>width)return {mask:2n,flags:2n,undefinedResult:true};
 let vector=bitVector(a,width),cf=Number(flags&1n),mask=kind<4?0xd7n:0xc6n;
 const oldSign=vector[width-1];
 if(kind>=8){
  vector=kind===9?[...vector,...bitVector(b,width)]:[...bitVector(b,width),...vector];
  for(let i=0;i<k;i++){
   if(kind===9){cf=vector.shift();vector.push(0);}
   else{cf=vector.pop();vector.unshift(0);}
  }
  vector=kind===9?vector.slice(0,width):vector.slice(width);mask=0xc7n;
 }else{
  const n=kind<2?k%width:kind<4&&width<32?k%(width+1):k;
  for(let i=0;i<n;i++){
   if(kind===0||kind===2||kind===4){
    const next=vector.pop();vector.unshift(kind===0?next:kind===2?cf:0);cf=next;
   }else{
    const fill=kind===1?vector[0]:kind===3?cf:kind===7?vector[width-1]:0;
    cf=vector.shift();vector.push(fill);
   }
  }
  if(kind===0)cf=vector[0];if(kind===1)cf=vector[width-1];
 }
 const result=number(vector),sign=vector[width-1];
 let output=kind<4?flags&0xd6n:2n+(parity(result%256n)?4n:0n)+(result===0n?64n:0n)+BigInt(sign)*128n;
 if(kind<4||kind===7||kind>=8||k<width){mask|=1n;output|=BigInt(cf);}
 if(k===1){
  const of=kind===5?oldSign:kind===7?0:kind===1||kind===3?sign^vector[width-2]:kind>=8?oldSign^sign:sign^cf;
  mask|=0x800n;output|=BigInt(of)*0x800n;
 }
 return {result,flags:output,mask};
}
for(const module of modules){
 const {width,kind,alias}=module,max=2n**BigInt(width)-1n,high=2n**BigInt(width-1);
 const values=[0n,1n,15n,high-1n,high,high+1n,max-1n,max];
 const memory=new WebAssembly.Memory({initial:1}),d=new DataView(memory.buffer);
 const forbidden=()=>{throw Error('register count operation accessed memory')};
 const {instance}=await WebAssembly.instantiate(Uint8Array.from(module.bytes),{env:{memory,load:forbidden,store:forbidden,access_failed:forbidden}});
 for(let raw=0;raw<256;raw++)for(const value of values)for(const context of [2n,3n,0x8d6n,0x8d7n]){
  const registers=Array.from({length:16},(_,r)=>0x1122334400000000n+BigInt(r));
  const dst=alias?1:0,input=(0x1122334455667788n&~max)|value;
  registers[dst]=input;
  if(alias)registers[1]=(input&~255n)|BigInt(raw);
  else registers[1]=0x8877665544332200n|BigInt(raw);
  registers[2]=BigInt.asUintN(width,0xfedcba98800080ffn+BigInt(raw));
  const a=registers[dst]&max,b=alias?a:registers[2]&max;
  const want=oracle(kind,a,b,width,raw,context);
  registers.forEach((v,r)=>d.setBigUint64(l.registers+r*8,v,true));
  d.setBigUint64(l.flags,context,true);d.setBigUint64(l.rip,0x1000n,true);
  const reason=instance.exports.run(0,1n,0n,0,0),actualFlags=d.getBigUint64(l.flags,true);
  const where=`kind${kind},width${width},raw${raw},value${value},flags${context},alias${alias}`;
  assert.equal(reason,1,where);
  if(want.undefinedResult){
   assert.equal(d.getBigUint64(l.registers+dst*8,true)&~max,registers[dst]&~max,where);
  }else{
   const expected=width===16?(registers[dst]&~max)|want.result:want.result;
   assert.equal(d.getBigUint64(l.registers+dst*8,true),expected,where);
  }
  for(let r=0;r<16;r++)if(r!==dst)assert.equal(d.getBigUint64(l.registers+r*8,true),registers[r],where);
  assert.equal(actualFlags&want.mask,want.flags&want.mask,where);
  assert.equal(actualFlags&~0x8d7n,0n,where);assert.equal(actualFlags&2n,2n,where);
  assert.equal(d.getBigUint64(l.rip,true),0x1000n+BigInt(module.length),where);
  assert.equal(d.getBigUint64(l.remaining,true),0n,where);
 }
}
"#,
    );
}

#[test]
fn count_memory_preflight_and_store_failures_keep_all_incoming_flags() {
    let mut cases = Vec::new();
    for (code, input, width, loaded, stored, flag_mask, output_flags) in [
        (
            vec![0xc0, 0x23, 0],
            vec![(3, 0x100004000)],
            1,
            "80",
            "80",
            0x8d7,
            0x8d7,
        ),
        (
            vec![0xc0, 0x23, 1],
            vec![(3, 0x100004000)],
            1,
            "80",
            "0",
            0x8c7,
            0x847,
        ),
        (
            vec![0xc0, 0x13, 9],
            vec![(3, 0x100004000)],
            1,
            "80",
            "80",
            0xd7,
            0xd7,
        ),
        (
            vec![0x66, 0x0f, 0xa4, 0x0b, 0],
            vec![(3, 0x100004000), (1, 0x8000)],
            2,
            "1234",
            "1234",
            0x8d7,
            0x8d7,
        ),
        (
            vec![0x66, 0x0f, 0xa4, 0x0b, 16],
            vec![(3, 0x100004000), (1, 0x8000)],
            2,
            "1234",
            "8000",
            0xc7,
            0x86,
        ),
    ] {
        let artifact = compiled_fixture(0x1000, &code, 0x1000);
        for (read_fails, store_fails) in [(true, false), (false, true), (false, false)] {
            let failed = read_fails || store_fails;
            let mut packet = execution_case(
                &artifact.bytes,
                &artifact.entries,
                &input,
                0x8d7,
                0x1000,
                1,
                (
                    &[],
                    if failed { 0x8d7 } else { output_flags },
                    if failed {
                        0x1000
                    } else {
                        0x1000 + code.len() as u64
                    },
                    if failed { 6 } else { 1 },
                    u64::from(failed),
                ),
            );
            if !failed {
                packet["flagMask"] = json!(format!("{flag_mask:x}"));
            }
            let mut accesses = vec![
                json!({"kind":"load_for_write","args":["100004000",width],"result":loaded}),
                json!({"kind":"access_failed","args":[],"result":u32::from(read_fails)}),
            ];
            if !read_fails {
                accesses.push(json!({"kind":"store","args":["100004000",width,stored],"result":u32::from(!store_fails)}));
            }
            packet["accesses"] = json!(accesses);
            cases.push(packet);
        }
    }
    run_cases(cases);
}

#[test]
fn count_aliases_and_boundary_gates_read_incoming_banks_without_access() {
    let mut cases = Vec::new();
    for (code, incoming, result, mask, flags) in [
        (
            vec![0xd2, 0xe1],
            0x1122334455667701,
            0x1122334455667702,
            0x8c7,
            2,
        ),
        (
            vec![0xd2, 0xe5],
            0x1122334455668001,
            0x1122334455660001,
            0x8c7,
            0x847,
        ),
        (vec![0xd3, 0xe1], 0x1122334480000001, 2, 0x8c7, 0x803),
    ] {
        let artifact = compiled_fixture(0x1000, &code, 0x1000);
        let mut packet = execution_case(
            &artifact.bytes,
            &artifact.entries,
            &[(1, incoming)],
            0x8d7,
            0x1000,
            1,
            (&[(1, result)], flags, 0x1000 + code.len() as u64, 1, 0),
        );
        packet["flagMask"] = json!(format!("{mask:x}"));
        cases.push(packet);
    }
    let artifact = compiled_fixture(0x1000, &[0xd2, 0x21], 0x1000);
    let mut packet = execution_case(
        &artifact.bytes,
        &artifact.entries,
        &[(1, 0x100004001)],
        0x8d7,
        0x1000,
        1,
        (&[], 0x847, 0x1002, 1, 0),
    );
    packet["flagMask"] = json!("8c7");
    packet["accesses"] = json!([
        {"kind":"load_for_write","args":["100004001",1],"result":"80"},
        {"kind":"access_failed","args":[],"result":0},
        {"kind":"store","args":["100004001",1,"0"],"result":1}
    ]);
    cases.push(packet);
    for (budget, reason, stop) in [(0, 1, false), (1, 2, true)] {
        let mut packet = execution_case(
            &artifact.bytes,
            &artifact.entries,
            &[(1, 0x100004001)],
            0x8d7,
            0x1000,
            budget,
            (&[], 0x8d7, 0x1000, reason, budget),
        );
        if stop {
            packet["stop"] = json!("1000");
        }
        cases.push(packet);
    }
    run_cases(cases);
}
