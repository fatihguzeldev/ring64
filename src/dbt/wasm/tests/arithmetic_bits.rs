use super::*;

fn literal(
    code: &[u8],
    input: &[(usize, u64)],
    flags: u64,
    expected: &[(usize, u64)],
    result_flags: u64,
) -> Value {
    let artifact = compiled_fixture(0x1000, code, 0x1000);
    execution_case(
        &artifact.bytes,
        &artifact.entries,
        input,
        flags,
        0x1000,
        1,
        (expected, result_flags, 0x1000 + code.len() as u64, 1, 0),
    )
}

#[test]
fn carry_arithmetic_uses_all_three_terms_before_narrowing() {
    let mut cases = Vec::new();
    for (code, input, expected, flags) in [
        (
            vec![0x10, 0xc8],
            vec![(0, 0x1122334455667700), (1, 0xff)],
            vec![(0, 0x1122334455667700)],
            0x57,
        ),
        (
            vec![0x18, 0xc8],
            vec![(0, 0x1122334455667700), (1, 0xff)],
            vec![(0, 0x1122334455667700)],
            0x57,
        ),
        (
            vec![0x48, 0x19, 0xc8],
            vec![(0, 0), (1, u64::MAX)],
            vec![(0, 0)],
            0x57,
        ),
        (
            vec![0x10, 0xc8],
            vec![(0, 0x112233445566777f), (1, 0)],
            vec![(0, 0x1122334455667780)],
            0x892,
        ),
        (
            vec![0x18, 0xc8],
            vec![(0, 0x1122334455667780), (1, 0)],
            vec![(0, 0x112233445566777f)],
            0x812,
        ),
    ] {
        cases.push(literal(&code, &input, 0x8d7, &expected, flags));
    }
    run_cases(cases);
}

#[test]
fn all_byte_adc_sbb_pairs_and_carries_match_independent_signed_ranges() {
    let modules =
        [[0x10, 0xc4], [0x18, 0xc4]].map(|code| compiled_fixture(0x1000, &code, 0x1000).bytes);
    let input = json!({ "layout": RunState::descriptor(), "modules": modules });
    let script = r#"
import fs from 'node:fs';
import assert from 'node:assert/strict';
const {layout:l,modules}=JSON.parse(fs.readFileSync(0,'utf8'));
const parity=Array.from({length:256},(_,v)=>v.toString(2).replaceAll('0','').length%2===0);
const signed=v=>v<128?v:v-256;
const guard=0x1122334455660000n;
for(const [operation,bytes] of modules.entries()) {
 const memory=new WebAssembly.Memory({initial:1}),d=new DataView(memory.buffer);
 const forbidden=()=>{throw new Error('register arithmetic accessed memory')};
 const {instance}=await WebAssembly.instantiate(Uint8Array.from(bytes),{env:{
  memory,load:forbidden,store:forbidden,access_failed:forbidden
 }});
 for(let i=1;i<16;i++)d.setBigUint64(l.registers+8*i,0x1122334400000000n+BigInt(i),true);
 for(let carryIn=0;carryIn<2;carryIn++)for(let left=0;left<256;left++)for(let right=0;right<256;right++) {
  const wide=operation===0?left+right+carryIn:left-right-carryIn;
  const result=(wide+256)%256;
  const signedResult=operation===0?signed(left)+signed(right)+carryIn:signed(left)-signed(right)-carryIn;
  const carry=operation===0?wide>255:left<right+carryIn;
  const auxiliary=operation===0?(left%16+right%16+carryIn)>15:left%16<right%16+carryIn;
  const overflow=signedResult < -128 || signedResult > 127;
  const flags=2+Number(carry)+4*Number(parity[result])+16*Number(auxiliary)
   +64*Number(result===0)+128*Number(result>=128)+2048*Number(overflow);
  d.setBigUint64(l.registers,guard+(BigInt(left)<<8n)+BigInt(right),true);
  d.setBigUint64(l.flags,0x8d6n+BigInt(carryIn),true);d.setBigUint64(l.rip,0x1000n,true);
  const reason=instance.exports.run(0,1n,0n,0,0);
  const context=`operation ${operation}, AH=${left}, AL=${right}, CF=${carryIn}`;
  assert.equal(reason,1,context);
  assert.equal(d.getBigUint64(l.registers,true),guard+(BigInt(result)<<8n)+BigInt(right),context);
  assert.equal(d.getBigUint64(l.flags,true),BigInt(flags),context);
  assert.equal(d.getBigUint64(l.rip,true),0x1002n,context);
  assert.equal(d.getBigUint64(l.remaining,true),0n,context);
 }
 for(let i=1;i<16;i++)assert.equal(d.getBigUint64(l.registers+8*i,true),0x1122334400000000n+BigInt(i));
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

#[test]
fn carry_memory_preflight_and_late_store_failure_preserve_incoming_flags() {
    let code = [0x10, 0x0b];
    let artifact = compiled_fixture(0x1000, &code, 0x1000);
    let mut cases = Vec::new();
    for (read_fails, store_fails) in [(true, false), (false, true), (false, false)] {
        let failed = read_fails || store_fails;
        let mut packet = execution_case(
            &artifact.bytes,
            &artifact.entries,
            &[(3, 0x100004000), (1, 1)],
            0x8d7,
            0x1000,
            1,
            (
                &[],
                if failed { 0x8d7 } else { 0x86 },
                if failed { 0x1000 } else { 0x1002 },
                if failed { 6 } else { 1 },
                u64::from(failed),
            ),
        );
        let mut accesses = vec![
            json!({"kind":"load_for_write","args":["100004000",1],"result":"80"}),
            json!({"kind":"access_failed","args":[],"result":u32::from(read_fails)}),
        ];
        if !read_fails {
            accesses.push(json!({"kind":"store","args":["100004000",1,"82"],"result":u32::from(!store_fails)}));
        }
        packet["accesses"] = json!(accesses);
        cases.push(packet);
    }
    run_cases(cases);
}

#[test]
fn wide_carry_arithmetic_matches_mathematical_signed_and_unsigned_ranges() {
    let mut cases = Vec::new();
    for (width, prefix) in [(16, vec![0x66]), (32, vec![]), (64, vec![0x48])] {
        let modulus = 1u128 << width;
        let mask = (modulus - 1) as u64;
        let sign = 1u64 << (width - 1);
        let values = [0, 1, 15, 16, sign - 1, sign, mask - 1, mask];
        for sub in [false, true] {
            let mut code = prefix.clone();
            code.extend([if sub { 0x19 } else { 0x11 }, 0xc8]);
            let artifact = compiled_fixture(0x1000, &code, 0x1000);
            for a in values {
                for b in values {
                    for c in [0u64, 1] {
                        let signed = |v: u64| {
                            if v & sign == 0 {
                                i128::from(v)
                            } else {
                                i128::from(v) - modulus as i128
                            }
                        };
                        let signed_result = if sub {
                            signed(a) - signed(b) - i128::from(c)
                        } else {
                            signed(a) + signed(b) + i128::from(c)
                        };
                        let r = if sub {
                            a.wrapping_sub(b).wrapping_sub(c) & mask
                        } else {
                            a.wrapping_add(b).wrapping_add(c) & mask
                        };
                        let cf = if sub {
                            u128::from(a) < u128::from(b) + u128::from(c)
                        } else {
                            u128::from(a) + u128::from(b) + u128::from(c) >= modulus
                        };
                        let af = if sub {
                            a % 16 < b % 16 + c
                        } else {
                            a % 16 + b % 16 + c > 15
                        };
                        let of = signed_result < -(sign as i128) || signed_result >= sign as i128;
                        let flags = 2
                            + u64::from(cf)
                            + 4 * u64::from((r as u8).count_ones() % 2 == 0)
                            + 16 * u64::from(af)
                            + 64 * u64::from(r == 0)
                            + 128 * u64::from(r & sign != 0)
                            + 2048 * u64::from(of);
                        let input_a = if width == 64 {
                            a
                        } else {
                            0x1122334400000000 | a
                        };
                        let expected = if width == 16 {
                            (input_a & !0xffff) | r
                        } else {
                            r
                        };
                        cases.push(execution_case(
                            &artifact.bytes,
                            &artifact.entries,
                            &[(0, input_a), (1, b)],
                            0x8d6 + c,
                            0x1000,
                            1,
                            (&[(0, expected)], flags, 0x1000 + code.len() as u64, 1, 0),
                        ));
                    }
                }
            }
        }
    }
    run_cases(cases);
}
