# integer conditions

extend [initial execution](../initial-execution/spec.md) and [long-mode addressing](../long-mode-addressing/spec.md) with register logical operations, TEST and all sixteen flag-based short/near Jcc conditions. their execution context, memory policy, instruction boundaries, exits, limits and artifact ownership continue to apply.

## admitted forms

all logical forms below require `mod=11`. `r/m` therefore names a register; memory forms remain unsupported.

| operation | register/register | immediate/register     |
| --------- | ----------------- | ---------------------- |
| AND       | `21 /r`, `23 /r`  | `81 /4 id`, `83 /4 ib` |
| OR        | `09 /r`, `0B /r`  | `81 /1 id`, `83 /1 ib` |
| XOR       | `31 /r`, `33 /r`  | `81 /6 id`, `83 /6 ib` |
| TEST      | `85 /r`           | `F7 /0 id`             |

`21/09/31` write the ModR/M r/m register; `23/0B/33` write the ModR/M reg register. TEST reads both operands and writes neither. group-immediate forms use the r/m register as their operand.

retain default 32-bit operands and one optional REX prefix; `REX.W` selects 64 bits. `REX.B` extends r/m and `REX.R` extends an operand in the reg field. a `/digit` selector uses only the three encoded reg bits, ignoring `REX.R`. `REX.X` is unused here. ignored fields do not make an admitted form unsupported.

`83` sign-extends imm8 to the operand width. `81` and `F7 /0` consume exactly four immediate bytes: imm32 is the 32-bit pattern for a 32-bit operation and is sign-extended for a 64-bit operation. TEST has no admitted imm8 form.

Jcc admits unprefixed `70+cc rel8` and `0F 80+cc rel32`, including the existing JNZ forms. operand/address-size overrides, REX-prefixed branches, 8/16-bit logical operations, accumulator-special encodings, memory logical operations, SETcc, CMOVcc and counter-based branches remain outside coverage. `F7 /1` is unsupported; this contract does not classify it as architecturally invalid or admit an undocumented TEST alias.

required-byte reads use the bounded instruction source. an admitted form's missing immediate/displacement byte is a fetch failure, including when a branch condition would be false. a ModR/M that already identifies an unsupported memory form or selector returns unsupported without fetching an address tail or immediate. unsupported coverage does not calculate an operand address or perform a data access.

## results and flags

read register operands through their selected 32- or 64-bit views before writing any destination. calculate AND, OR or XOR at that width. a 32-bit write clears the bank's upper half; a 64-bit write replaces the full bank. source/destination aliases use the pre-instruction values.

TEST computes the same temporary result as AND for flags, then discards it. every register bank remains unchanged, including the upper half of a tested 32-bit register.

for all four operations:

- `CF=0`, `OF=0`.
- `ZF=1` iff the width-limited result is zero; `SF` is its most significant bit.
- `PF=1` iff the low result byte has even parity.
- `AF` is architecturally undefined. no fixed value or preservation guarantee is added for this writer.

the published flag word remains concrete and valid under the existing `0x8d7` mask with bit 1 set. undefined AF permits either bit value, not extra flag bits or omission of state. later instructions that preserve flags must preserve the actual value produced, including AF. ADD/SUB/CMP retain their fully defined flag contract. this spec does not select a new flags optimization or transport representation.

## conditions and transfers

condition nibble `cc` has the following meaning; mnemonic aliases select the same condition. boolean comparisons below compare flag values, not their unequal bit positions in the packed word.

| cc  | names           | taken iff          |
| --- | --------------- | ------------------ |
| `0` | JO              | `OF=1`             |
| `1` | JNO             | `OF=0`             |
| `2` | JB / JC / JNAE  | `CF=1`             |
| `3` | JAE / JNB / JNC | `CF=0`             |
| `4` | JE / JZ         | `ZF=1`             |
| `5` | JNE / JNZ       | `ZF=0`             |
| `6` | JBE / JNA       | `CF=1 or ZF=1`     |
| `7` | JA / JNBE       | `CF=0 and ZF=0`    |
| `8` | JS              | `SF=1`             |
| `9` | JNS             | `SF=0`             |
| `a` | JP / JPE        | `PF=1`             |
| `b` | JNP / JPO       | `PF=0`             |
| `c` | JL / JNGE       | `SF != OF`         |
| `d` | JGE / JNL       | `SF = OF`          |
| `e` | JLE / JNG       | `ZF=1 or SF != OF` |
| `f` | JG / JNLE       | `ZF=0 and SF = OF` |

Jcc preserves all register banks and every admitted flag, including AF. a false condition advances to the complete instruction's `next_pc`. a true condition uses `(next_pc + sign-extended displacement) mod 2^64`. validate canonicality only for the taken target. a noncanonical taken target leaves the branch unretired at its original pc, with complete target-fault metadata. a canonical target commits the branch; the next boundary checks budget, stop and fetch in the existing order.

discovery may inspect both static successors without executing either. imported flags are invocation inputs; cached code and middle entries must select the current condition without inheriting an unexecuted predecessor's flags. known admitted edges stay inside the generated execution function. unsupported or truncated future code cannot fail an earlier reached prefix.

logical operations and successful branches retire once. budget, stop, reached decode and resource admission retain their existing priority. all new Jcc forms use the existing target-failure contract, including diagnostic address and faulting instruction pc; adding a condition must not lose metadata currently supplied for JNZ.

## verification

run decoder checks, generated-Wasm checks with forbidden data-access imports, and complete shared Node/Chrome cases. expected values come from literal arithmetic and independently checked condition tables, not the decoder or lowering under test. verify all admitted encodings at both widths, all sixteen register banks, both register directions, aliases and immediate sign boundaries. identity results still update flags and apply destination-width rules: `or eax,0` and `and eax,-1` are not general no-ops.

logical expected flags compare under `0x8c7` (the admitted mask without AF), while also checking the complete word's validity and bit 1. compare every other state field and all RAM exactly. do not globally mask AF: after observing a logical producer's concrete output, require exact preservation through MOV, LEA, Jcc, faults and resumed suffixes. independently import AF=1 for preserving-instruction cases so an implementation that always selects AF=0 at logical writers cannot hide a consumer that clears it. later fully defined arithmetic restores exact full-flag expectations. two valid implementations need not choose the same AF at a logical writer.

unless overridden below, cases have separate code images containing exactly the listed bytes, pc `0x1000`, budget one, flags `0x8d7`, and RAM `00` at `0x4000`. initialize bank `i` to `0x1122334400000000+i`, then apply overrides. supply explicit limits large enough to admit and retain the case; no stop is requested. each packet in the table succeeds with budget/retired one/remaining zero and rip advanced by its full length. only the stated destination changes; all RAM is unchanged. the last column is the defined flag expectation under `0x8c7`.

| bytes                   | input overrides                                  | result                                                              | flags  |
| ----------------------- | ------------------------------------------------ | ------------------------------------------------------------------- | ------ |
| `45 21 c8` / `45 23 c1` | r8=`0x1122334480000103`, r9=`0xaabbccddffffffff` | r8=`0x80000103`, r9 unchanged                                       | `0x86` |
| `4d 09 c8` / `4d 0b c1` | r8=`0x8000000000000000`, r9=`0x101`              | r8=`0x8000000000000101`, r9 unchanged                               | `0x82` |
| `4d 31 c8`              | r8=`0xffffffff000000ff`, r9=`0xffffffff`         | r8=`0xffffffffffffff00`, r9 unchanged                               | `0x86` |
| `45 31 c0`              | r8=`0x1122334400000000`                          | full r8=zero                                                        | `0x46` |
| `45 85 c0`              | r8=`0x1122334400000000`                          | all banks unchanged                                                 | `0x46` |
| `85 c0`                 | rax=`0x1122334400000100`                         | all banks unchanged; parity uses the low byte                       | `0x06` |
| `83 c8 00`              | rax=`0x1122334480000100`                         | rax=`0x80000100` despite an unchanged low result                    | `0x86` |
| `48 83 c8 00`           | rax=`0x123456789abcdef0`                         | rax unchanged; flags still replaced                                 | `0x06` |
| `48 83 e0 80`           | rax=`0x123456789abcdef0`                         | rax=`0x123456789abcde80`                                            | `0x02` |
| `48 81 e0 00 00 00 80`  | rax=`0x123456789abcdef0`                         | rax=`0x1234567880000000`                                            | `0x06` |
| `48 81 c8 00 00 00 80`  | rax=zero                                         | rax=`0xffffffff80000000`                                            | `0x86` |
| `4f f7 c0 00 00 00 80`  | r8=`0x100000000`                                 | all banks unchanged; imm32 sign-extension and ignored selector bits | `0x06` |

for every condition, reuse each short/near artifact across all 64 admitted flag words: fixed bit 1 plus every combination of CF/PF/AF/ZF/SF/OF. use short displacement `0x0e` or near displacement `0x0a` at pc `0x1000`, so the taken target is `0x1010` and fallthrough is `0x1002` or `0x1006`. budget one must retire the branch and publish the literal pc with every flag and bank unchanged; no target fetch occurs. include mixed condition codes within one unit: `7c 02 72 02`, imported flags `0x3`, budget two must return budget at `0x1006` after two retirements.

test signed and unsigned producer/consumer distinctions with `39 c8 7c 02` and `39 c8 72 02`: rax=`0x1122334480000000`, rcx=1, budget two. CMP preserves both full banks and produces exact flags `0x816`; JL reaches `0x1006`, JB falls through to `0x1004`. also cover negative rel8/rel32 boundaries, high instruction addresses, target arithmetic wrapping, and an instruction ending at the final u64 byte. required bytes themselves never wrap. truncated `0F`, every rel32/immediate byte, unsupported prefixes/memory/selectors and `F7 /1` must retain distinct reached outcomes.

### producer paths and observations

use `740431c0eb0383c8017405ba22000000b933000000` at `0x1000`, with default banks and RAM above. admit every entry. with budget five, imported flags `0x2` produce rax=0, rcx=`0x33`, unchanged rdx and defined flags `0x46`; imported flags `0x42` produce rax=1, rcx=`0x33`, rdx=`0x22` and defined flags `0x2`. both end at `0x1015`. then enter the same cached unit at `0x1009` with fresh banks: flags `0x52` and budget two skip the rdx write; flags `0x12` and budget three write edx=`0x22`. both write ecx=`0x33`, finish at `0x1015`, compile nothing, and preserve all imported flags exactly.

use `85c07403488b16488903` at `0x1000`, rax=`0x1122334400000000`, rbx=`0x4000`, rsi=`0x7000`, flags `0x883`. RAM at `0x3ff8` is `1011121314151617a0a1a2a3a4a5a6a7f0f1f2f3f4f5f6f7`; `0x7000` is unmapped. budget three retires TEST, JE and the store, ends at `0x100a`, preserves every bank and writes `0000000044332211` into the middle eight RAM bytes with guards unchanged; defined flags are `0x46`. budget three with stop `0x1007` returns stop after two retirements with RAM unchanged; budget two with that stop returns budget at the same pc.

use `4889034883e001488b16` with the same guarded RAM, rax=`0x1122334400000002`, rbx=`0x4000`, rsi=`0x7000`, flags `0x883`, budget four. the load faults at `0x1007`: retired two, remaining two, rax=0, rdx unchanged, defined flags `0x46`; the earlier store remains `0200000044332211`. fault address/first failing address are `0x7000`, width eight, read/unmapped. replace the middle RAM word with `0807060504030201`, import the published state changing only rsi to `0x4000`, and resume with budget one. require rdx=`0x0102030405060708`, rip=`0x100a`, exact preserved flags and host-written RAM, with no replay of the earlier store or producer.

### target and admission priority

at `p=0x7ffffffffff0`, `09c0780c` performs OR eax,eax then JS to `0x800000000000`. with rax=0 and budget two, retire both and finish at `p+4`, defined flags `0x46`; the unused target causes no failure. with rax=`0x1122334480000000`, the producer writes rax=`0x80000000`, defined flags `0x86`, then the branch returns target-fault at `p+2`, retired one/remaining one. report instruction pc `p+2`, target/first failing address `0x800000000000`, width zero, execute/noncanonical. budget one or a reached stop at `p+2` returns before evaluating the branch.

at the same p, use prefix `31c0` followed in separate images by truncated `0f8408` or complete `0f8408000000`. RAM is `00` at `0x4000`; code ends at the listed final byte; caches start empty. set `maxInstructions=1`, `maxTranslationsPerRun=1`, budget three and other explicit limits large enough for either single-instruction artifact. after the XOR, rax=0, defined flags `0x46`, rip=`p+2`, retired one/remaining two. the truncated branch returns fetch-fault for the required byte at `p+5`, execute/unmapped; the complete branch returns resource-limit before evaluating its condition or target. resume the complete case with budget one: target-fault at `p+2`, retired zero/remaining one, target metadata as above and every published flag preserved exactly.

## performance

compare unchanged ADD/SUB/CMP/JNZ and memory-containing loops before/after with identical guest bytes, inputs, limits, exits and complete outputs. characterize new logical/Jcc code separately: identity operations with live flags, signed/unsigned and parity consumers, different producers joining at one consumer, live register pressure, and short resumed runs. new unsupported-old encodings have no old executable baseline.

retain normal browser settings, matched warmup/use histories, balanced repeated samples, first completion and early/later reused windows, translation/browser compile/instantiate costs, emitted bytes and native-entry/dispatch counts. use runs long enough to separate execution from timer/setup noise; first-use samples sharing an engine/cache are not independent cold comparisons. a later window alone does not establish the browser's native tier. isolate and resolve repeatable regressions outside observed variation before acceptance.

alternative lowerings must execute the same bytes and observations. compare architecturally defined flags, valid AF and exact preservation within each execution; different legitimate AF choices at a writer do not invalidate a timing comparison. every other bank, RAM byte, exit and count must agree. native entries count host-to-generated invocations, not internal helper calls. preserve the existing local-state path; this coverage extension does not require lazy flags, predicate fusion, a new IR or a changed host ABI.

## references

- intel SDM 093US: volume 2A, AND pp. 3-60–61 and Jcc pp. 3-499–503; volume 2B, OR pp. 4-163–164 and TEST pp. 4-721–722; volume 2D, XOR pp. 6-40–41 and table A-6; volume 2A section 2.2.1.2 for REX operand/opcode-extension fields.
