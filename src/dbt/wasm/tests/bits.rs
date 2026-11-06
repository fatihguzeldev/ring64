use super::*;

#[test]
fn bit_literals_distinguish_readonly_writes_zero_scans_and_source_parity() {
    let mut cases = Vec::new();
    for (code, a, c, result, mask, flags) in [
        (
            vec![0x0f, 0xba, 0xe0, 0x20],
            0x1122334455667788,
            1,
            0x1122334455667788,
            0x43,
            0x42,
        ),
        (
            vec![0x0f, 0xba, 0xe8, 3],
            0x1122334455667788,
            1,
            0x55667788,
            0x43,
            0x43,
        ),
        (
            vec![0x0f, 0xbc, 0xc1],
            0x1122334455667788,
            0,
            0x1122334455667788,
            0x8d7,
            0x46,
        ),
        (
            vec![0x0f, 0xbd, 0xc1],
            0x1122334455667788,
            0,
            0x1122334455667788,
            0x8d7,
            0x46,
        ),
        (
            vec![0x0f, 0xbc, 0xc1],
            0x1122334455667788,
            0x100,
            8,
            0x8d7,
            2,
        ),
        (
            vec![0x0f, 0xbd, 0xc1],
            0x1122334455667788,
            0x100,
            8,
            0x8d7,
            2,
        ),
        (
            vec![0x0f, 0xbc, 0xc1],
            0x1122334455667788,
            0x180,
            7,
            0x8d7,
            6,
        ),
        (
            vec![0x0f, 0xbd, 0xc1],
            0x1122334455667788,
            0x180,
            8,
            0x8d7,
            6,
        ),
        (
            vec![0x0f, 0xbc, 0xc0],
            0x100000000,
            1,
            0x100000000,
            0x8d7,
            0x46,
        ),
        (
            vec![0x48, 0x0f, 0xbc, 0xc1],
            0x1122334455667788,
            0x100000003,
            0,
            0x8d7,
            2,
        ),
        (
            vec![0x48, 0x0f, 0xbd, 0xc1],
            0x1122334455667788,
            0x100000001,
            32,
            0x8d7,
            6,
        ),
        (
            vec![0x0f, 0xc8],
            0x1122334455667788,
            1,
            0x88776655,
            0x8d7,
            0x8d7,
        ),
        (
            vec![0x48, 0x0f, 0xc8],
            0x1122334455667788,
            1,
            0x8877665544332211,
            0x8d7,
            0x8d7,
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

#[test]
fn bit_scans_and_swaps_match_independent_indices_parity_and_byte_order() {
    let mut modules = Vec::new();
    for (width, prefix) in [(16, vec![0x66]), (32, vec![]), (64, vec![0x48])] {
        for (kind, opcode) in [(0, 0xa3), (1, 0xab), (2, 0xb3), (3, 0xbb)] {
            for alias in [false, true] {
                let mut code = prefix.clone();
                code.extend([0x0f, opcode, if alias { 0xc0 } else { 0xc8 }]);
                modules.push(json!({"family":"bit","kind":kind,"width":width,"alias":alias,"length":code.len(),"bytes":compiled_fixture(0x1000,&code,0x1000).bytes}));
            }
        }
        for reverse in [false, true] {
            for alias in [false, true] {
                let mut code = prefix.clone();
                code.extend([
                    0x0f,
                    if reverse { 0xbd } else { 0xbc },
                    if alias { 0xc0 } else { 0xc1 },
                ]);
                modules.push(json!({"family":"scan","reverse":reverse,"width":width,"alias":alias,"length":code.len(),"bytes":compiled_fixture(0x1000,&code,0x1000).bytes}));
            }
        }
    }
    for width in [32, 64] {
        for bank in 0..16 {
            let mut code = Vec::new();
            if width == 64 || bank >= 8 {
                code.push(0x40 | if width == 64 { 8 } else { 0 } | if bank >= 8 { 1 } else { 0 });
            }
            code.extend([0x0f, 0xc8 + (bank & 7)]);
            modules.push(json!({"family":"swap","width":width,"bank":bank,"length":code.len(),"bytes":compiled_fixture(0x1000,&code,0x1000).bytes}));
        }
    }
    let input = json!({"layout":RunState::descriptor(),"modules":modules});
    let source = r#"
import fs from 'node:fs';
import assert from 'node:assert/strict';
const {layout:l,modules}=JSON.parse(fs.readFileSync(0,'utf8'));
const parity=v=>v.toString(2).replaceAll('0','').length%2===0;
for(const module of modules){
 const {width,family,kind,alias,reverse}=module,max=2n**BigInt(width)-1n,sign=2n**BigInt(width-1);
 const values=[0n,1n,15n,0x100n,0x180n,sign-1n,sign,sign+1n,max-1n,max,0x100000001n&max,0x100000003n&max];
 if(family==='scan')for(let bit=0;bit<width;bit++)values.push(2n**BigInt(bit));
 const memory=new WebAssembly.Memory({initial:1}),d=new DataView(memory.buffer),forbidden=()=>{throw Error('register bit operation accessed memory')};
 const {instance}=await WebAssembly.instantiate(Uint8Array.from(module.bytes),{env:{memory,load:forbidden,store:forbidden,access_failed:forbidden}});
 const checks=(family==='bit'?256:1);
 for(const value of values)for(let index=0;index<checks;index++)for(const flags of [2n,3n,0x8d6n,0x8d7n]){
  const registers=Array.from({length:16},(_,r)=>0x1122334400000000n+BigInt(r)),dst=family==='swap'?module.bank:0;
  registers[dst]=(0x1122334455667788n&~max)|value;
  if(family==='scan')registers[alias?0:1]=(0x8877665544332211n&~max)|value;
  if(family==='bit'&&!alias)registers[1]=0xfedcba9800000000n|BigInt(index);
  const original=registers[dst],expected=[...registers];let expectedFlags=flags,mask=0x8d7n;
  if(family==='bit'){
   const pos=Number((alias?original:registers[1])%BigInt(width)),weight=2n**BigInt(pos),old=original&max;
   const selected=(old/weight)%2n;
   const next=kind===1?old+(selected===0n?weight:0n):kind===2?old-(selected===1n?weight:0n):kind===3?old+(selected===0n?weight:-weight):old;
   if(kind!==0)expected[0]=width===16?(original&~max)|next:next;
   expectedFlags=(flags&0x42n)|selected;mask=0x43n;
  }else if(family==='scan'){
   const bits=value.toString(2),ones=bits.replaceAll('0','').length;
   if(value!==0n){
    const index=reverse?bits.length-1:bits.length-bits.lastIndexOf('1')-1;
    expected[0]=width===16?(original&~max)|BigInt(index):BigInt(index);
   }
   expectedFlags=2n+(ones%2===0?4n:0n)+(value===0n?64n:0n);
  }else{
   const hex=value.toString(16).padStart(width/4,'0').match(/../g).reverse().join('');expected[dst]=BigInt('0x'+hex);
  }
  registers.forEach((v,r)=>d.setBigUint64(l.registers+r*8,v,true));d.setBigUint64(l.flags,flags,true);d.setBigUint64(l.rip,0x1000n,true);
  const reason=instance.exports.run(0,1n,0n,0,0),actualFlags=d.getBigUint64(l.flags,true),where=`${family},kind${kind},w${width},value${value},idx${index},alias${alias}`;
  assert.equal(reason,1,where);for(let r=0;r<16;r++)assert.equal(d.getBigUint64(l.registers+r*8,true),expected[r],where);
  assert.equal(actualFlags&mask,expectedFlags&mask,where);assert.equal(actualFlags&~0x8d7n,0n,where);assert.equal(actualFlags&2n,2n,where);
  assert.equal(d.getBigUint64(l.rip,true),0x1000n+BigInt(module.length),where);assert.equal(d.getBigUint64(l.remaining,true),0n,where);
 }
}
"#;
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
fn bit_memory_indices_adjust_before_checked_access_and_flags_commit() {
    let mut cases = Vec::new();
    for (code, input, address, width, value, flags) in [
        (
            vec![0x0f, 0xa3, 0x0b],
            vec![(3, 0x100004004), (1, 0xfeedbeefffffffff)],
            "100004000",
            4,
            "80000000",
            0x43,
        ),
        (
            vec![0x0f, 0xba, 0x23, 0xff],
            vec![(3, 0x100004000)],
            "100004000",
            4,
            "80000000",
            0x43,
        ),
        (
            vec![0x66, 0x0f, 0xba, 0x23, 0xff],
            vec![(3, 0x100004000)],
            "100004000",
            2,
            "8000",
            0x43,
        ),
        (
            vec![0x0f, 0xa3, 0x0b],
            vec![(3, 0x800000000000), (1, 0xffffffe0)],
            "7ffffffffffc",
            4,
            "1",
            0x43,
        ),
        (
            vec![0x0f, 0xa3, 0x0b],
            vec![(3, 0x7ffffffffffc), (1, 32)],
            "800000000000",
            4,
            "1",
            0x43,
        ),
        (
            vec![0x0f, 0xa3, 0x09],
            vec![(1, 0x100004020)],
            "100004824",
            4,
            "1",
            0x43,
        ),
        (
            vec![0x48, 0x0f, 0xa3, 0x0b],
            vec![(3, 0), (1, u64::MAX)],
            "fffffffffffffff8",
            8,
            "8000000000000000",
            0x43,
        ),
    ] {
        let artifact = compiled_fixture(0x1000, &code, 0x1000);
        for fails in [false, true] {
            let mut packet = execution_case(
                &artifact.bytes,
                &artifact.entries,
                &input,
                0x8d7,
                0x1000,
                1,
                (
                    &[],
                    if fails { 0x8d7 } else { flags },
                    if fails {
                        0x1000
                    } else {
                        0x1000 + code.len() as u64
                    },
                    if fails { 6 } else { 1 },
                    u64::from(fails),
                ),
            );
            if !fails {
                packet["flagMask"] = json!("43");
            }
            packet["accesses"] = json!([
                {"kind":"load","args":[address,width],"result":value},
                {"kind":"access_failed","args":[],"result":u32::from(fails)}
            ]);
            cases.push(packet);
        }
    }
    for (opcode, stored) in [(0xab, "1"), (0xb3, "0"), (0xbb, "1")] {
        let code = [0x0f, opcode, 0x0b];
        let artifact = compiled_fixture(0x1000, &code, 0x1000);
        for (read_fails, store_fails) in [(true, false), (false, true), (false, false)] {
            let failed = read_fails || store_fails;
            let mut packet = execution_case(
                &artifact.bytes,
                &artifact.entries,
                &[(3, 0x100004000), (1, 32)],
                0x8d7,
                0x1000,
                1,
                (
                    &[],
                    if failed { 0x8d7 } else { 0x42 },
                    if failed { 0x1000 } else { 0x1003 },
                    if failed { 6 } else { 1 },
                    u64::from(failed),
                ),
            );
            if !failed {
                packet["flagMask"] = json!("43");
            }
            let mut accesses = vec![
                json!({"kind":"load_for_write","args":["100004004",4],"result":"0"}),
                json!({"kind":"access_failed","args":[],"result":u32::from(read_fails)}),
            ];
            if !read_fails {
                accesses.push(json!({"kind":"store","args":["100004004",4,stored],"result":u32::from(!store_fails)}));
            }
            packet["accesses"] = json!(accesses);
            cases.push(packet);
        }
    }
    run_cases(cases);
}

#[test]
fn scans_use_read_permission_and_preserve_the_full_bank_on_zero_or_failure() {
    let mut cases = Vec::new();
    for (code, width, loaded, result, flags) in [
        (vec![0x0f, 0xbc, 3], 4, "0", 0x1122334455667788, 0x46),
        (vec![0x0f, 0xbd, 3], 4, "0", 0x1122334455667788, 0x46),
        (vec![0x66, 0x0f, 0xbd, 3], 2, "ffff", 0x112233445566000f, 6),
        (vec![0x48, 0x0f, 0xbc, 3], 8, "100000003", 0, 2),
        (vec![0x48, 0x0f, 0xbd, 3], 8, "100000001", 32, 6),
    ] {
        let artifact = compiled_fixture(0x1000, &code, 0x1000);
        for fails in [false, true] {
            let mut packet = execution_case(
                &artifact.bytes,
                &artifact.entries,
                &[(0, 0x1122334455667788), (3, 0x100004000)],
                0x8d7,
                0x1000,
                1,
                (
                    &[(0, if fails { 0x1122334455667788 } else { result })],
                    if fails { 0x8d7 } else { flags },
                    if fails {
                        0x1000
                    } else {
                        0x1000 + code.len() as u64
                    },
                    if fails { 6 } else { 1 },
                    u64::from(fails),
                ),
            );
            packet["accesses"] = json!([
                {"kind":"load","args":["100004000",width],"result":loaded},
                {"kind":"access_failed","args":[],"result":u32::from(fails)}
            ]);
            cases.push(packet);
        }
    }
    run_cases(cases);
}
