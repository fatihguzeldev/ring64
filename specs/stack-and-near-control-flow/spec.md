# stack and near control flow

extend [initial execution](../initial-execution/spec.md), [long-mode addressing](../long-mode-addressing/spec.md), [integer conditions](../integer-conditions/spec.md) and [integer memory](../integer-memory/spec.md) with 64-bit stack operations and near calls, returns and register-indirect jumps. retain the imported long-mode context, fixed RX code/RW RAM, 48-bit canonical addresses, instruction boundaries, limits and artifact ownership.

## admitted forms

| operation        | encoding          | operand                                                            |
| ---------------- | ----------------- | ------------------------------------------------------------------ |
| PUSH             | `50+rd`           | full r64 source                                                    |
| POP              | `58+rd`           | full r64 destination                                               |
| PUSH immediate   | `6A ib`, `68 id`  | imm8 or imm32, sign-extended to 64 bits                            |
| CALL relative    | `E8 cd`           | rel32, sign-extended and added to complete `next_pc` modulo `2^64` |
| CALL register    | `FF /2`, `mod=11` | full r64 target                                                    |
| JMP register     | `FF /4`, `mod=11` | full r64 target                                                    |
| RET              | `C3`              | target at the current stack top                                    |
| RET with cleanup | `C2 iw`           | the same return, then unsigned imm16 byte cleanup                  |

each new form admits no prefix or one REX prefix. stack-address size, stack slot size and near target width are 64 bits, including when `REX.W=0`. `REX.B` extends the opcode register in `50+rd/58+rd` and the r/m register in `FF /2,/4`. `REX.R` never extends a `/digit` selector; the remaining unused REX fields are ignored. immediate PUSH, E8 and RET have no encoded register to extend. every consumed prefix contributes to the complete instruction length and return address.

existing `EB/E9` and Jcc prefix coverage is unchanged. memory-indirect CALL/JMP, memory PUSH/POP, the alternate `FF /6` and `8F /0` PUSH/POP encodings including their register forms, 16-bit stack operands, far transfers, flags/segment stack operations, ENTER/LEAVE, legacy prefixes and repeated REX prefixes remain outside coverage. CET/shadow-stack/IBT state and checks are outside this imported context. unsupported is not a claim of architectural invalidity.

the bounded byte source supplies the complete encoding before operand or target checks. E8 requires exactly four displacement bytes; C2 requires exactly two cleanup bytes; PUSH immediates require one or four bytes. FF requires ModR/M: an unsupported selector or `mod != 11` returns unsupported there, without reading SIB/displacement bytes. opcode 8F remains unsupported without requesting its ModR/M. incomplete admitted encodings return the existing required-byte fetch diagnostic, including at the u64 domain end.

## stack and transfer effects

the stack uses ordinary guest memory and register bank RSP. there is no separate allocated stack, saved call-depth authority or calling-convention alignment requirement. read and write the selected eight bytes little-endian through the existing memory owner; POP/RET require only read permission, so readable code and adjacent readable spans can supply a stack word.

let `sp` be the incoming full RSP and `next` the complete instruction's `next_pc`. stack-pointer arithmetic wraps modulo `2^64`. only actual memory spans and control targets are validated; a raw RSP or popped register value may be noncanonical or unmapped.

- PUSH captures its register or sign-extended immediate value before changing RSP. form `slot = sp - 8`, validate/write the full slot, then commit RSP=`slot` and RIP=`next`. PUSH RSP stores the old RSP.
- POP reads a word at `sp`, then commits RSP=`sp+8`, the destination bank=`word` and RIP=`next`. for POP RSP, the loaded word is the final RSP, not the loaded word plus eight. no stack bytes are cleared.
- CALL captures its complete target before changing RSP, including CALL RSP's old register value. validate target canonicality, form `slot = sp-8` and validate/write `next` into that slot. commit RSP=`slot` and RIP=`target` only after the required checks and write succeed. CALL preserves every other bank. a zero relative displacement still pushes the return address.
- RET reads the current word at `sp` and validates that word as the target. commit RIP=`word` and RSP=`sp+8+cleanup`, with cleanup zero for C3 and zero-extended imm16 for C2. only the original eight-byte word is read; skipped cleanup bytes are not accessed or preflighted. the resulting RSP is not itself an access. the return word remains in memory.
- JMP register captures and validates its full target, then commits RIP=`target`. RSP and memory are untouched; an unusable stack pointer does not prevent the jump.

all these instructions preserve the complete admitted flag word, including AF, and all banks not named by their effects. each successful instruction retires once and consumes one budget unit. a controlled failure leaves that instruction unretired at its original RIP and preserves all incoming banks, flags and memory. effects of earlier completed instructions remain committed.

RET's source is the current guest stack word, including host writes while idle and guest writes through ordinary memory instructions. it can return without a preceding CALL or to a target different from an earlier CALL's continuation. no call/return pairing, function-entry alignment or hidden return stack may reject such a target or silently replace it.

## failures and observation

retain budget, stop, reached fetch/decode and translation/resource admission priority before execution-time checks. after admission, this flat-span embedding selects the following diagnostic order:

- PUSH: the full eight-byte slot's write checks.
- POP: the full eight-byte incoming stack word's read checks.
- CALL: target canonicality, then the full slot's write checks.
- RET: the full incoming word's read checks, then the loaded target's canonicality.
- JMP register: target canonicality.

CALL's competing-target/stack diagnostic priority above is an explicit embedding policy, not a claim about Intel/AMD hardware exception precedence. the existing within-span range/canonical/mapping/permission order remains authoritative for each stack access. no decrement underflow or increment/cleanup overflow fault is added: wrap pointer arithmetic first, then check an actual access's full span, whose bytes may not wrap.

stack access failures return `data-fault` with instruction pc, actual operand start, width eight, read/write kind, cause and first failing address. a noncanonical transfer target returns `target-fault` with the faulting instruction pc, actual full target as address/first failing address, width zero and execute/noncanonical. register and RET targets must reach diagnostics from their executed values; decoding the instruction after exit cannot recover a runtime target.

fault metadata belongs only to the current exit. successful, budget, stop, resource-limit and unsupported exits carry no leftover target/access fault. a later fetch or data failure reports its own metadata, not a previous transfer's target.

a canonical target commits the transfer even if it is unmapped, in NX RAM or at unsupported/truncated code. the next reached boundary checks budget, stop and fetch/decode in the existing order. CALL's saved word/RSP and RET's advanced RSP remain committed across that boundary; a subsequent fetch failure cannot roll them back. stopped or faulted execution resumes from the published state without a second push or pop.

## discovery and ownership

direct CALL contributes its canonical static target and continuation `next_pc` as discovery candidates. register CALL contributes its static continuation, without guessing its callee. CALL executes only the callee edge; discovering a continuation does not execute it. RET and register JMP terminate their static discovery path; there is no implicit fallthrough or operand-RAM/register read during discovery. other known incoming edges can still admit code after them. future fetch/coverage failures remain frontiers, not earlier guest exits.

known static CALL edges remain inside the admitted generated execution function. dynamic targets require validation and an execution path for any admitted guest pc, including cache misses, evicted targets and targets inside another instruction's bytes. a byte-range hit is not an instruction entry: use a matching admitted entry or decode from the actual pc through the dispatcher. entry indices and aliases retain their artifact owner. cached execution must consume current RSP, target registers and RAM, without assuming a predecessor CALL ran.

x86 owns stack/transfer effects and widths; memory owns access policy; DBT owns discovery, routing and precise publication. embedding carries runtime target diagnostics, and TypeScript coordinates compilation/cache/lifecycle. this spec does not choose transport fields, return prediction, chaining or a guest-call-to-Wasm-call mapping. a general dispatcher is a valid dynamic-target baseline; native-entry count one is not required for a RET or register-indirect edge. implementations must support deep guest calls and resumable exits without relying on unbounded host recursion.

## verification

cover decoder records, generated Wasm execution and the complete public path in shared Node/Chrome cases. use independent literals and checked arithmetic, not ring64's decoder/lowering to produce expected results. run `npm run check` for implementation acceptance.

cover all sixteen register selections, REX ignored fields, source/RSP/target aliases, immediate sign boundaries, unsigned cleanup `0/0x7fff/0x8000/0xffff`, complete instruction lengths and every required-byte truncation. include unusable stack/target inputs behind incomplete encodings or unsupported forms. require exact flags for imported `2`, each single admitted flag and `0x8d7`, including reused artifacts and failure/resume boundaries.

### literal results

unless overridden, each packet is a separate exact code image at `0x1000`, RAM is 64 bytes of `a5` at `0x4000`, RSP=`0x4020`, flags=`0x8d7`, budget one, no stop, and explicit limits sufficient to admit/retain it. initialize other bank `i` to `0x1122334400000000+i`, then apply row overrides. `top` specifies the eight bytes at the incoming RSP. success returns `budget`, retired one/remaining zero and no fault. check every bank and RAM byte, including code/guards; flags never change. only the stated register/slot changes occur.

| bytes               | overrides                                      | result                                                                           |
| ------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------- |
| `50`                | rax=`0x1122334400000000`                       | RSP=`0x4018`, RIP=`0x1001`, qword at `0x4018`=`0x1122334400000000`               |
| `54`                | none                                           | RSP=`0x4018`, RIP=`0x1001`, qword at `0x4018`=`0x4020`                           |
| `4f 54`             | r12=`0x0123456789abcdef`                       | RSP=`0x4018`, RIP=`0x1002`, qword at `0x4018`=`0x0123456789abcdef`               |
| `4f 6a 80`          | none                                           | RSP=`0x4018`, RIP=`0x1003`, qword at `0x4018`=`0xffffffffffffff80`               |
| `47 68 00 00 00 80` | none                                           | RSP=`0x4018`, RIP=`0x1006`, qword at `0x4018`=`0xffffffff80000000`               |
| `58`                | top=`0xfedcba9876543210`                       | rax=`0xfedcba9876543210`, RSP=`0x4028`, RIP=`0x1001`, RAM unchanged              |
| `5c`                | top=`0x800000000000`                           | RSP=`0x800000000000`, RIP=`0x1001`, RAM unchanged                                |
| `4f 5c`             | top=`0xfedcba9876543210`                       | r12=`0xfedcba9876543210`, RSP=`0x4028`, RIP=`0x1002`, RAM unchanged              |
| `e8 0b 00 00 00`    | none                                           | RSP=`0x4018`, RIP=`0x1010`, qword at `0x4018`=`0x1005`                           |
| `4f e8 00 00 00 00` | none                                           | RSP=`0x4018`, RIP=`0x1006`, qword at `0x4018`=`0x1006`                           |
| `ff d0`             | rax=`0x1010`                                   | RSP=`0x4018`, RIP=`0x1010`, qword at `0x4018`=`0x1002`                           |
| `ff d4`             | none                                           | RSP=`0x4018`, RIP=`0x4020`, qword at `0x4018`=`0x1002`; no early NX-target fetch |
| `47 ff d4`          | r12=`0xffff800000001010`                       | RSP=`0x4018`, RIP=`0xffff800000001010`, qword at `0x4018`=`0x1003`               |
| `47 ff e4`          | r12=`0xffff800000001010`, RSP=`0x800000000000` | RIP=`0xffff800000001010`, all banks and RAM unchanged                            |
| `c3`                | top=`0x1010`                                   | RSP=`0x4028`, RIP=`0x1010`, RAM unchanged; no matching CALL required             |
| `4f c2 00 80`       | top=`0x1010`                                   | RSP=`0xc028`, RIP=`0x1010`, RAM unchanged; no cleanup-span access                |

also POP from an RX stack: code `58 10 10 00 00 00 00 00 00` at `0x1000`, RSP=`0x1001`, ordinary RAM. require rax=`0x1010`, RSP=`0x1009`, RIP=`0x1001`, exact flags and unchanged memory. verify POP/RET reads crossing adjacent readable spans. stack readability must not be replaced with write intent.

### faults and arithmetic boundaries

for the following one-instruction failures retain default setup except listed overrides. require retired zero/remaining one, original RIP, every bank/flag/RAM byte unchanged and complete fault metadata. `target` denotes `(target-fault,address,width=0,execute,noncanonical,first failing address=address)`; `data` denotes `(data-fault,operand address,width=8,access,cause,first failing address)`.

| packet and overrides                           | expected diagnostic                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `ff d0`, rax=`0x800000000000`, RSP=`0x7000`    | target at `0x800000000000`; the bad stack does not replace this embedding's selected target diagnostic |
| `ff d0`, rax=`0x1010`, RSP=`0x7000`            | data `(0x6ff8,write,unmapped,0x6ff8)`                                                                  |
| `50`, RSP=`0x1008`                             | data `(0x1000,write,permission,0x1000)`                                                                |
| `c3` or `c2 ff ff`, RSP=`0x7000`               | data `(0x7000,read,unmapped,0x7000)`; no guessed return target                                         |
| `c3` or `c2 ff ff`, top=`0x800000000000`       | target at `0x800000000000`; RSP and cleanup remain uncommitted                                         |
| `47 ff e4`, r12=`0x800000000000`, RSP=`0x7000` | target at `0x800000000000`; no stack access                                                            |
| `50`, RSP=1                                    | data `(0xfffffffffffffff9,write,address-range,0x10000000000000000)`                                    |
| `58`, RSP=`0x7ffffffffffc`                     | data `(0x7ffffffffffc,read,noncanonical,0x800000000000)`                                               |

also exercise valid high and unaligned stack slots, a failed slot with an accessible prefix and inaccessible suffix, and a mixed RAM/code store span without changing any prefix bytes. with RAM ending at u64 max, PUSH from RSP=0 succeeds into `0xfffffffffffffff8`, and POP/RET from that slot can advance RSP to zero. with a valid readable word at `0x7ffffffffff8`, POP to another bank or RET can advance RSP to `0x800000000000` without faulting. C2 may likewise leave a noncanonical or unmapped RSP. distinguish all these from a failing eight-byte operand span.

place complete `4f e8 00 00 00 00` at `0xfffffffffffffffa`: next/target zero, pushed return word zero and one successful retirement. a required encoding byte beyond u64 max instead retains the inherited range-fetch failure.

with code/RIP at `0x7ffffffffff0` and RSP=`0x7000`, `e8 0b 00 00 00` fails at target `0x800000000000` before checking the bad stack. replacing the displacement with zero makes target `0x7ffffffffff5` canonical: require data-fault `(0x6ff8,8,write,unmapped,0x6ff8)` instead. both preserve all state and memory and retire zero.

### calls, changed targets and resumption

use exact code `e80b000000b901000000eb1400000000ba02000000c3` at `0x1000`. CALL reaches `0x1010`; the callee writes edx=2 and returns to `0x1005`; the continuation writes ecx=1 and jumps to `0x1020`. with default state, budget six and stop `0x1020`, require `stop`, retired five/remaining one, RSP=`0x4020`, rcx=1, rdx=2, flags unchanged and saved word `0x1005` still at `0x4018`. all other banks/RAM stay unchanged. budget five instead returns budget at the same final state.

with sufficient limits, require the first artifact's entry set `{0x1000,0x1005,0x100a,0x1010,0x1015}`, instruction count five and distinct source-byte count eighteen. separately run only the first two executed instructions: budget two returns at `0x1015`, rdx=2, RSP=`0x4018`, saved word=`0x1005`, with one native entry and zero dispatches; the static callee edge stays internal. this does not constrain the later dynamic RET route.

for register CALL use `ffd0b901000000c3b802000000c3`, rax=`0x1008` and budget one. require the first artifact's entries `{0x1000,0x1002,0x1007}` and source-byte count eight; do not discover `0x1008` from imported RAX. execution still commits the actual call to `0x1008`, saved word `0x1002` and RSP=`0x4018` before budget exit.

restart, run only the CALL, and require RSP=`0x4018`, RIP=`0x1010`, saved word `0x1005`. while idle replace only that word with `0x100a`. resume with budget four/stop `0x1020`: retired three/remaining one, RSP restored, rdx=2, rcx retains its incoming bank, and the patched word remains `0x100a`. the target must not be replaced with a remembered `0x1005`. repeat with guest code modifying the saved word and with unmatched RET entry.

separately stop immediately after CALL/RET and resume; repair a failed CALL stack address or RET word/stack address while idle, then resume the same instruction. require exactly one eventual push/pop and preserve earlier stores. reuse one register-indirect artifact with different imported target registers and RSP values; reuse a RET artifact after changing only RAM's return word. include cache hits, eviction/reinstallation and middle/overlapping instruction entries with fresh state.

retain a C3 artifact and use the same incoming RSP in successive failing runs: word `0x800000000000`, then word `0xffff7fff12345678`. require each actual target in both diagnostic address fields, original RIP/RSP, retired zero/remaining one and exact state/RAM preservation. patch the word to `0x1010`: budget one succeeds, pops once and carries no fault. reimport the original RET pc with RSP=`0x7000`: require its read/unmapped data-fault, then separately budget zero and a reached stop at that RET pc, each with no fault. repeat the distinct-target failures with retained register CALL/JMP artifacts. stale or fixed target metadata must not pass these checks.

at canonical unmapped and NX targets distinguish budget exhaustion, a reached stop, and a subsequent fetch failure. force a one-instruction translation frontier: an exhausted per-run translation cap must not replay a completed CALL/RET or mask a reached fetch/decode failure; a resource refusal before an unexecuted instruction leaves its stack effects absent. verify these with prefix effects and exact per-run counts, not only final balanced RSP.

use the normal call program with empty caches, `maxInstructions=1`, `maxTranslationsPerRun=1` and budget two. after the CALL require resource-limit at `0x1010`, retired one/remaining one, RSP=`0x4018`, saved word `0x1005` and no callee effect. independently import RET pc `0x1015` into a fresh instance with word `0x1005` at `0x4018`, RSP=`0x4018` and the same limits/budget. require resource-limit at `0x1005`, retired one/remaining one and RSP=`0x4020`. resume each published state with budget one: execute its MOV once without another push/pop, preserving stack bytes and exact flags.

## performance

compare unchanged integer/Jcc/addressing/memory workloads before/after with identical bytes, inputs, finite limits, observation policy and complete outputs. characterize the new encodings separately. cover call-heavy loops, nested/deep calls, multiple callers sharing a callee, stable/changing register targets, patched/unmatched returns and short resumed runs. workloads must expose return words and distinguish the executed paths; a balanced final RSP or idempotent accumulator alone is insufficient.

measure first completion and early/later reuse windows with matched warmup, balanced repeats and normal browser settings. retain separate translation/browser compilation/instantiation costs, artifact/cache bytes and native-entry/dispatch counts. checks validate full banks, flags, RSP/RIP, stack bytes/guards, exits and counts outside timing; trace capture work inside timing must match. shared-process first completion is not independent cold evidence, and a later window alone does not establish a native tier.

compare routing candidates on the same guest bytes and observable stack/exit contract; report predicted hits/misses and state publication costs separately where measured. helper-call count is not an architectural requirement. preserve exact behavior when a predicted target is wrong or a stop/fault interrupts the apparent call/return pair. neither an earlier prototype nor one conventional call loop selects return prediction, a state ABI, tail chaining or ordinary Wasm calls. resolve repeatable regressions outside observed variation before acceptance.

## references

- intel SDM 093US: volume 2A sections 2.2.1.2/2.2.1.7 and table 2-4, CALL pp. 3-121–126 and JMP pp. 3-504–505; volume 2B POP pp. 4-398–400, PUSH pp. 4-522–524 and RET pp. 4-569–571; volume 3A sections 7.5–7.6 for fault restart. instruction effects and the embedding diagnostic priority above are separate contracts.
- [AMD APM volume 3, revision 3.37](https://docs.amd.com/api/khub/documents/j44LvPXzuuXgM0WyHKQfeQ/content), CALL (Near), POP, PUSH and RET (Near); [volume 2 sections 8.1.2–8.1.3](https://docs.amd.com/api/khub/documents/sD1_QL~h4Afq2_tvzxqqSQ/content) for fault/restart state. these do not establish Ring64's competing-failure diagnostic order as universal hardware precedence.
