# integer memory

extend [initial execution](../initial-execution/spec.md), [long-mode addressing](../long-mode-addressing/spec.md) and [integer conditions](../integer-conditions/spec.md) with memory operands for the existing integer operations. execution context, address expressions, flags, instruction boundaries, limits and artifact ownership continue to apply.

## admitted forms

new admission requires a memory ModR/M operand (`mod != 11`). `m` below is a 32- or 64-bit memory operand; `r` has the same data width. operand order matters for SUB and CMP.

| operation | memory first             | register first           | immediate to memory    |
| --------- | ------------------------ | ------------------------ | ---------------------- |
| ADD       | `01 /r`: `m += r`        | `03 /r`: `r += m`        | `81 /0 id`, `83 /0 ib` |
| SUB       | `29 /r`: `m -= r`        | `2B /r`: `r -= m`        | `81 /5 id`, `83 /5 ib` |
| CMP       | `39 /r`: compare `m - r` | `3B /r`: compare `r - m` | `81 /7 id`, `83 /7 ib` |
| AND       | `21 /r`: `m &= r`        | `23 /r`: `r &= m`        | `81 /4 id`, `83 /4 ib` |
| OR        | `09 /r`: `m \|= r`       | `0B /r`: `r \|= m`       | `81 /1 id`, `83 /1 ib` |
| XOR       | `31 /r`: `m ^= r`        | `33 /r`: `r ^= m`        | `81 /6 id`, `83 /6 ib` |
| TEST      | `85 /r`: test `m & r`    | —                        | `F7 /0 id`             |

CMP and TEST write no operand. all other memory-first and immediate-to-memory forms write memory; register-first forms write the register. existing admitted register forms remain unchanged. `03/2B/3B` with `mod=11` remain unsupported, not invalid encodings.

retain default 32-bit operands, one optional REX prefix, `REX.W` for 64 bits and the existing 64-bit address forms. `REX.R` extends a register operand, not a `/digit` selector. `REX.B/X` retain their existing base/index and special-form rules. unused REX fields remain ignored.

`83` sign-extends imm8 to the data width. `81` and `F7 /0` consume four immediate bytes: the 32-bit pattern for a 32-bit operation, sign-extended for a 64-bit operation. no imm64 form is added. TEST has no admitted imm8 form. `81/83 /2,/3` and `F7 /1..7` remain unsupported; this does not classify those encodings as architecturally invalid.

8/16-bit operands, accumulator-special encodings, new arithmetic families, operand/address-size overrides, segment overrides, LOCK/REP and additional prefix combinations remain outside coverage.

## decode and addresses

read required ModR/M, SIB, displacement and immediate bytes through the bounded instruction source, in encoding order. an admitted form missing any required byte returns the existing fetch failure before a data access, even if its operand would fail or its result would be unchanged. an unsupported group selector returns unsupported after ModR/M without reading an address tail or immediate.

use the existing address expression and full 64-bit register terms, independently of data width. calculate effective addresses modulo `2^64`; validate the resulting complete access span. RIP-relative addressing uses the complete instruction's `next_pc`, including every immediate byte after the displacement. the data operand's end may not wrap the address domain.

read address terms and register operands from the instruction's incoming state. a register destination may alias the base or index; its 32-bit write must not affect the address used for that instruction. a memory destination may use its source register in the address. discovery never reads operand RAM or specializes on imported register values or RAM contents.

## access and commit

classify each memory operand by its required access:

- register-first operations, CMP and TEST require `read` across the full operand span. code is readable, and reads may cross adjacent code/RAM spans.
- a modifying memory destination requires `write` across the full span before reading operand backing storage. in this fixed private-memory context every writable span is also readable. classify every operand-access failure for these forms as `write`.

apply the memory owner's existing order: full-span u64 range, full-span canonicality, then mappings and permissions in ascending guest-address order. the first disallowed write byte wins over a later unmapped byte. this extends the embedding's access policy; it does not specify hardware exception delivery or precedence. a read-then-write implementation that reports a later read failure instead is not equivalent.

even an unchanged result requires the full access: `or [address],0`, `and [address],-1`, `add [address],0` and a zero/equal-value source cannot skip memory validation or the required write permission.

after successful checks, compute with the width-limited operands and the existing arithmetic/logical flag rules. register destinations follow the existing zero-extension rule for 32-bit writes. memory destinations write exactly four or eight little-endian bytes and preserve every register bank. CMP and TEST preserve all register banks and all operand bytes, including the upper half of a register named by a 32-bit operand.

successful ADD/SUB/CMP define all six arithmetic flags. successful AND/OR/XOR/TEST have the existing undefined-AF contract; every other admitted flag bit remains valid. undefined AF applies only to a completed logical writer. on any operand failure preserve the entire incoming flag word exactly, including AF, all register banks and all memory. leave RIP at the faulting instruction, retire zero for it and preserve its budget unit. effects of earlier completed instructions remain committed.

a successful instruction retires once, consumes one budget unit and advances to its complete `next_pc`. existing budget/stop/fetch/resource priority and resumability apply. failed accesses report the original operand address, full width, access kind, cause, first failing address and faulting instruction pc. no host-side recalculation of guest flags or reinterpretation of access failures is added.

instruction/operand meaning belongs to x86; span validation and access permission belong to memory; Wasm lowering preserves both contracts. this spec does not prescribe a load/store/helper sequence, a new host ABI or an inline memory path.

## verification

verify decode, generated execution and the complete public path in shared Node/Chrome cases. expected values must be independent of the decoder and lowering under test. run `npm run check` for implementation acceptance.

cover every table encoding at both widths, both noncommutative operand orders, all register banks, REX.R/B/X combinations, ignored group-selector extension, every existing address family and source/base/index/destination aliases. distinguish disp8/disp32 signs, no-base SIB, no-index versus R12 index, RBP/R13 zero displacement and RIP-relative operands with trailing imm8/imm32. verify 32-bit data with high guest-address bits and access ending at the last u64 address; guard surrounding bytes against over-wide stores.

for logical results compare defined flags under `0x8c7`, and validate the full concrete word under the existing `0x8d7` mask with bit 1 set. failed logical instructions and preserving successors retain the actual AF value exactly, including across exits and resumes. a later flag writer follows its own flag contract. initialize AF=1 in fault cases so an eager logical update cannot hide behind masking. arithmetic flags are always compared exactly.

### literal results

unless overridden, each row is a separate exact code image at `0x1000`, with budget one, flags `0x8d7`, no stop and explicit limits large enough to admit and retain it. initialize bank `i` to `0x1122334400000000+i`, then apply overrides. RAM is 64 bytes of `a5` at `0x4000`; write the row's little-endian operand at `0x4010`, and set rbx=`0x4010`. a different RAM base moves that operand to `base+0x10` unless its address is explicit. `mem32/mem64` below specifies only the operand bytes; all other RAM bytes remain guards.

success returns `budget`, retired one/remaining zero and RIP advanced by the packet length. assert all banks, flags and every RAM byte; only the stated destination changes. logical flag values below are under `0x8c7`; arithmetic values are exact.

| bytes                  | overrides                                                                                      | result                                                                 | flags          |
| ---------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------- |
| `48 03 03`             | rax=`0x7fffffff00000000`, mem64=`0x100000000`                                                  | rax=`0x8000000000000000`; RAM unchanged                                | `0x886`        |
| `01 03`                | rax=1, mem32=`0xffffffff`                                                                      | mem32=0; all banks unchanged                                           | `0x57`         |
| `29 1b` / `2b 1b`      | RAM base=`0x100004000`, operand explicitly at `0x100004000`, rbx=`0x100004000`, mem32=`0x4001` | first: mem32=1, rbx unchanged; second: rbx=`0xffffffff`, RAM unchanged | `0x2` / `0x97` |
| `4f 01 4c a5 f8`       | r13=`0x4000`, r12=6, r9=1, mem64=`0xffffffffffffffff`                                          | mem64=0; all banks unchanged                                           | `0x57`         |
| `4c 83 03 ff`          | mem64=0                                                                                        | mem64=`0xffffffffffffffff`; REX.R does not change `/0`                 | `0x86`         |
| `48 81 2b ff ff ff ff` | mem64=0                                                                                        | mem64=1                                                                | `0x13`         |
| `48 83 23 ff`          | mem64=`0x8000000000000001`                                                                     | mem64 unchanged; flags still updated                                   | `0x82`         |
| `4d 09 0c 24`          | r12=`0x4010`, r9=1, mem64=`0x8000000000000000`                                                 | mem64=`0x8000000000000001`                                             | `0x82`         |
| `44 33 4b fc`          | rbx=`0x4014`, r9=`0xaabbccdd80000103`, mem32=`0x80000103`                                      | r9=0; RAM unchanged                                                    | `0x46`         |
| `48 31 03`             | rax=`0xffffffffffffffff`, mem64=`0xffffffffffffffff`                                           | mem64=0; rax unchanged                                                 | `0x46`         |
| `39 03` / `3b 03`      | rax=`0x1122334400000002`, mem32=1                                                              | both preserve all banks and RAM                                        | `0x97` / `0x2` |
| `48 f7 03 ff ff ff ff` | mem64=`0x8000000000000000`                                                                     | all banks and RAM unchanged; imm32 is sign-extended                    | `0x86`         |

the following exact code/RAM layouts distinguish the complete RIP-relative base from the cursor immediately after displacement. retain the same incoming flags/bank initialization, budget and limits. all banks and RAM remain unchanged except where stated:

| code at `0x1000`                   | adjacent RAM operand                   | result                                                                                           |
| ---------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `83 0d 00 00 00 00 00`             | dword 1 at `0x1007`                    | successful OR, defined flags `0x2`, RIP=`0x1007`; budget wins before a subsequent fetch from RAM |
| `48 83 3d 00 00 00 00 01`          | qword 1 at `0x1008`                    | CMP flags=`0x46`, RIP=`0x1008`                                                                   |
| `48 81 3d 00 00 00 00 01 00 00 00` | qword 1 at `0x100b`                    | CMP flags=`0x46`, RIP=`0x100b`                                                                   |
| `48 f7 05 00 00 00 00 ff ff ff ff` | qword `0x8000000000000000` at `0x100b` | TEST defined flags=`0x86`, RIP=`0x100b`                                                          |

### failures and boundaries

each failure below uses the same bank/flag initialization, budget one and sufficient limits; override code location, RAM and rbx as stated. require `data-fault`, retired zero/remaining one, original RIP and exact unchanged banks, flags and memory. the diagnostic tuple is `(operand address, width, access, cause, first failing address)`.

| code/layout                                                           | rbx                  | diagnostic tuple                                                                                       |
| --------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------ |
| code at `0x1000`: `48 83 0b 00 01 00 00 00 00 00 00 00`; ordinary RAM | `0x1004`             | `(0x1004,8,write,permission,0x1004)`; OR of readable qword 1 with zero still requires write permission |
| code at `0x2004`: `48 83 0b 00`; RAM at `0x2000`: `11 22 33 44`       | `0x2002`             | `(0x2002,8,write,permission,0x2004)`; permission wins before later unmapped `0x2008`                   |
| code at `0x2004`: `48 83 3b 00`; same four RAM bytes                  | `0x2002`             | `(0x2002,8,read,unmapped,0x2008)`; CMP requires no write permission                                    |
| `48 03 03`; ordinary RAM                                              | `0x7000`             | `(0x7000,8,read,unmapped,0x7000)`                                                                      |
| `48 f7 03 00 00 00 00`; ordinary RAM                                  | `0x7000`             | `(0x7000,8,read,unmapped,0x7000)`; TEST with zero still requires a readable operand                    |
| `48 01 03`; RAM at `0x4000`: `11 22 33 44 55`                         | `0x4002`             | `(0x4002,8,write,unmapped,0x4005)`; no prefix bytes are stored                                         |
| `01 03`; ordinary RAM                                                 | `0x7ffffffffffe`     | `(0x7ffffffffffe,4,write,noncanonical,0x800000000000)`                                                 |
| `48 01 03`; ordinary RAM                                              | `0xfffffffffffffffe` | `(0xfffffffffffffffe,8,write,address-range,0x10000000000000000)`                                       |

also use code `85 03` at `0x1000`, RAM `34 12` at `0x1002`, rbx=`0x1000`, rax=`0x11223344ffffffff`. TEST reads dword `0x12340385` across RX code/RAM, succeeds with defined flags `0x2`, preserves all banks and memory, including rax's upper half, and advances to `0x1002`.

truncate admitted register/memory and immediate/memory forms at every required SIB/displacement/immediate byte. include a noncanonical or unmapped operand so fetching the complete encoding must win. separately verify unsupported selectors, prefixes and `03 c0`/`2b c0`/`3b c0` return unsupported without data access or an invented invalid-encoding result.

run code `48 89 03 48 01 16` at `0x1000` with RAM sixteen zero bytes at `0x4000`, rax=2, rbx=`0x4000`, rdx=3, rsi=`0x7000`, flags=`0x8d7` and budget three. the store completes, then ADD faults: RIP=`0x1003`, retired one/remaining two, exact flags unchanged, RAM's first qword=2. report write/unmapped at `0x7000`, width eight. while idle, replace that qword with 10 and change only rsi to `0x4000`; resume with budget one. require qword=13, flags=`0x2`, RIP=`0x1006`, retired one/remaining zero and no replay of the store. separately restart the original case with budget one/no stop, and with budget three/stop `0x1003`. expect budget/retired one/remaining zero and stop/retired one/remaining two respectively, each at `0x1003` with qword=2, exact flags=`0x8d7` and no fault, before checking ADD's operand.

reuse retained code after independently changing RAM values and address/source registers. include successful and faulting middle entries with no executed predecessor and explicit cache evidence that the artifact was reused. require exact imported flags, including AF=1, at the faulting entry. verify fresh operands, exact boundary counts and preservation of earlier effects when a later instruction fails or translation limits force a frontier.

## performance

compare unchanged arithmetic/Jcc, MOV/addressing and logical workloads before/after using identical guest bytes, inputs, limits, observations and checked outputs. characterize new register-destination reads, modifying memory destinations and read-only CMP/TEST separately. use live flag consumers before any loop counter overwrites flags, changing operand values, address/source aliases, live register pressure and short resumed runs. check full banks, all RAM/guards, defined flags and exact exits/counts outside timing.

retain matched warmup/use histories, balanced repeated samples, first completion and early/later reused windows, separate guest translation/browser compilation/instantiation cost, artifact size and native-entry/dispatch counts. first completion after shared engine history is not an independent cold sample; short-run trace retention must match between compared versions. resolve repeatable regressions outside observed variation before acceptance. new encodings unsupported by the old core have no old executable baseline; a MOV/ALU/MOV guest sequence is different work, not a same-byte lowering comparison.

existing local-state execution and internal known edges remain the baseline. helper/inline access, RMW lowering and flag optimizations require evidence under these same semantics; this spec does not select their winner.

## references

- intel SDM 093US: volume 2A section 2.2.1.2 (REX fields), section 2.2.1.6 (complete next-instruction RIP), ADD, AND and CMP entries; volume 2B OR, SUB and TEST entries; volume 2D XOR entry and table A-6. the inherited specs define the selected execution context and embedding access policy.
