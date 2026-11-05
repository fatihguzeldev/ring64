# initial execution

## purpose

build ring64's first executable path from guest machine-code bytes to verified architectural state:

```text
guest bytes + execution context
  -> decode
  -> bounded translation unit
  -> generated wasm
  -> browser compilation and execution
  -> complete state and exit reason
```

the execution path covers execution context/registers, decode, scalar arithmetic/flags, memory access and control flow.

## execution model

implement a baseline guest-to-wasm dbt in rust. use cargo and a pinned stable rust toolchain, building the core for native tests and `wasm32-unknown-unknown`. use `wasm-encoder` for runtime code generation and a small typescript host for browser compilation, instantiation and public execution.

there are two compilation steps. rustc/llvm builds ring64's decoder, translator and helpers into the core wasm. at runtime, that core emits separate wasm modules implementing guest instructions; the browser compiles those modules to host machine code. guest translation does not invoke llvm.

the contract covers the execution context and instruction forms below; it does not define a complete cpu profile or public state abi.

compile on first encounter when no reusable artifact exists, independent of observed reuse. use one baseline execution path, with no interpreter or hotness threshold.

## initial execution context

execute host-supplied 64-bit state using long-mode instruction encodings with default 32-bit operands, optional `REX.W` 64-bit operands and 64-bit address size. reset, mode-entry sequences and other operating modes are outside this contract.

- expose all sixteen raw 64-bit gprs and `rip`. `eax` and the other 32-bit register names are views of those banks; a 32-bit destination write clears the bank's upper half. `cmp` never writes its register operand.
- expose arithmetic flags `CF`, `PF`, `AF`, `ZF`, `SF`, `OF`, with reserved bit 1 set. imported flags admit these bits only; flag controls, debug execution and pending events are outside this imported context. instructions preserve every admitted flag they do not modify.
- use flat linear addresses with 48-bit canonical-address validation. registers may contain any 64-bit value; validate values when used as addresses or control targets, not merely because they occupy a register.
- supply one copied, immutable read/execute code span and one disjoint private read/write, non-executable ram span. guest data loads may read either span; stores to code and instruction fetches from ram fail with a permission cause. reads across adjacent supplied spans are allowed after checking the entire operand. guest addresses remain full 64-bit values; checked translation produces offsets into small wasm32 backing storage. high guest addresses must not be truncated or passed through a lossy js number.

spans are nonempty; `base + length - 1` must fit in u64 and the entire addressed range must be canonical. a span ending at address `0xffffffffffffffff` is valid. reject malformed or overlapping spans as host-input errors.

gprs, rip and optional stop are exact unsigned 64-bit values. imported rip may contain any such value; validate it as an instruction address only if fetch is reached. this permits importing a state published after sequential execution reaches a noncanonical pc. flags admit only mask `0x8d7` and require bit 1. instruction budgets/counts are unsigned 64-bit values transported without loss. malformed or out-of-range arguments fail before execution; valid arguments follow the boundary priority below.

the host may import/read state and read/write ram while idle. code and mapping identity are fixed for the cpu instance; replacing them requires a new instance. reject concurrent runs, state/memory observation or mutation, and disposal while execution or browser compilation is pending. neither original input buffers nor returned snapshots may provide a mutable alias to owned code, ram or state. execution state is private, with no shared memory, mmio or host callbacks from guest instructions.

this is an explicitly limited embedding context. it does not implement guest page walks, segment protection, privilege transitions, interrupt delivery or hardware exception delivery.

## instruction forms

implement only the following forms. data-operation widths are 32 and 64 bits; one optional rex prefix supplies width and extended-register selection. the branch forms below are unprefixed. unsupported prefix combinations and other valid forms remain implementation coverage gaps.

apply rex fields only where the encoding uses them. in particular, `REX.R` does not extend the `/0,/5,/7` opcode selector, and `REX.X` is ignored without sib. unused fields do not make an otherwise admitted form unsupported. `mod=00,r/m=101` remains rip-relative even with `REX.B`; it is an unsupported form.

| instruction                            | admitted encodings and operands                                                                                                                                                                                        |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mov` immediate to register            | `B8+rd id` for r32/imm32; `REX.W B8+rd iq` for r64/imm64. `REX.B` selects extended registers.                                                                                                                          |
| `mov` register/register                | `89 /r`, `8B /r`, `mod=11`.                                                                                                                                                                                            |
| `mov` load/store                       | `89 /r`, `8B /r`, base-register addressing with no displacement, signed disp8 or signed disp32. no sib or rip-relative forms yet. encodings requiring sib remain unsupported; base `rbp/r13` uses a displacement form. |
| `add`, `sub`, `cmp` register/register  | respectively `01 /r`, `29 /r`, `39 /r`, `mod=11`.                                                                                                                                                                      |
| `add`, `sub`, `cmp` immediate/register | `81 /0,/5,/7 id` and `83 /0,/5,/7 ib`, `mod=11`. imm8 is sign-extended to operand width; imm32 is sign-extended for a 64-bit operation.                                                                                |
| direct `jmp`                           | `EB rel8`, `E9 rel32`.                                                                                                                                                                                                 |
| `jnz` / `jne`                          | `75 rel8`, `0F 85 rel32`; branch iff `ZF=0`.                                                                                                                                                                           |

no memory arithmetic, 8/16-bit register writes, operand/address-size overrides, segment/lock/rep prefixes, indirect transfers, call/return, stack operations, fp or vector instructions are added here. recognizing an opcode does not imply support for all of its forms.

addition/subtraction wrap at operand width. flags follow that width, including carry/borrow, signed overflow, low-byte parity and auxiliary carry. mov and branches preserve flags. next instruction addresses wrap to 64 bits; relative targets add the signed displacement with the same wrapping. validate a conditional target only when the branch is taken.

form effective addresses by wrapping the 64-bit base plus the sign-extended displacement. validate the resulting complete 4/8-byte span, not the raw base register alone. the operand span itself may not wrap the 64-bit address domain or cross the canonical-address hole. loads/stores use little-endian byte order.

access failure reporting has a fixed logical order: reject a span whose last addressed byte overflows u64; then reject a noncanonical span; then check mappings and permissions in ascending guest-address order. report the first unmapped or disallowed byte with that cause. include the operand start and width; for range/noncanonical failures report the first byte violating that check, using `2^64` as the diagnostic first-outside-domain value when needed. no backing access occurs before successful preflight. this is the embedding's policy, not hardware exception precedence.

## decode and discovery

the decoder produces compact typed instruction records with start/next pc, operation, widths and operands. a general optimizing ir or a second interpreter is not required.

keep these outcomes distinguishable: a decoded implemented form; a required byte unavailable; a form outside implementation coverage; a verified architectural invalid encoding; and an internal error. an unfamiliar opcode or prefix is not evidence of architectural invalidity. these outcomes do not implement delivery of a guest `#UD` or `#PF`.

the required bytes of one instruction do not wrap the address domain. an incomplete encoding requiring a byte at `2^64` produces a range fetch failure. a complete instruction whose last byte is at `0xffffffffffffffff` still has next pc zero.

translation starts at the requested guest pc. use bounded discovery of reachable instruction entries and static branch successors inside the immutable code span. one translated unit may contain multiple basic blocks and emits one execution function in a wasm module; helper functions are permitted. known edges stay inside that execution function; other targets publish state and return to the runtime dispatcher. discovery limits bound the unit without requiring page alignment.

an internal target must equal an admitted instruction entry. a jump into another instruction's bytes requires decoding from the actual target pc; byte-range membership alone is insufficient. if discovery does not admit that entry, dispatch there normally.

discovery has no guest state or operand-memory effects. unavailable or unsupported code beyond the reached instruction terminates discovery or becomes a reached exit; it must not fail an earlier valid execution prefix. exceeding discovery bounds must preserve a usable prefix or produce a controlled resource outcome, without a zero-progress dispatch loop.

## generated execution and observation

keep useful gprs in wasm locals during a translated invocation. compute the six arithmetic flags eagerly into local state. memory layout and the js/wasm transport abi remain internal.

at every reached instruction boundary, check remaining instruction budget first, then an optional requested stop pc, then reached instruction fetch/decode/coverage. only a supported decoded form proceeds to any required translation/resource admission and execution-time operand checks. immutable code/context may prove fetch/decode checks without re-reading bytes. instruction accounting is exact at these boundaries.

- budget zero and an already-reached stop return before translation or resource admission. budget wins a tie with stop. stop compares the actual reached rip; it does not stop at a byte merely scanned during discovery.
- a successful instruction commits its effects and next pc, retires once and consumes one budget unit.
- for these scalar forms, finish required checks before committing the instruction's destination, flags or store. a failed ram access leaves that instruction unretired and preserves earlier completed effects.
- check the entire load/store span, permissions and canonical address range before accessing backing storage. a failed store changes no bytes. this rule applies to the scalar forms listed above.
- a taken branch to a canonical but unmapped target completes. the next boundary can return budget, stop or fetch failure in that order. a taken noncanonical target fails at the branch without committing it; an untaken `jnz` does not validate its unused target.
- every controlled public exit publishes all sixteen banks, flags and rip, plus reason and exact retired/remaining counts. counts are per public run: `retired = supplied budget - remaining`. access failures identify the faulting instruction pc, guest operand address, width, access kind, cause and failing address under the policy above. fetch failures identify the required byte and range/noncanonical/unmapped/permission cause.
- reasons distinguish budget, stop, unsupported coverage, verified invalid encoding, fetch failure, target failure, data-access failure and declared resource refusal. metadata distinguishes their causes; these are semantic outcomes, not a prescribed transport enum.
- rust panics, malformed generated wasm, unexpected browser compilation rejection and wasm traps are engine failures. they are not simulated guest exceptions or declared-limit refusals. a failure settles the active run and marks the instance failed; only disposal is then permitted, without a promise that architectural state was published. controlled exits leave the instance resumable.

budget-one execution uses this same generated path. resuming from a published state must execute the suffix exactly once. stop is an embedding observation boundary, not an x86 halt instruction. instruction budget is neither a cycle count nor a wall-clock responsiveness guarantee.

## runtime and code reuse

the host coordinates one active run, translating and awaiting browser compilation only when a target has no usable artifact. compilation retires no guest instructions. imported gprs/flags, ram contents, remaining budget and requested stop are invocation inputs, not translation constants. reuse must remain correct when any of them changes. values proven by executed guest instructions or immutable code are legitimate specialization facts; entry into the middle of a unit must not inherit facts from an unexecuted predecessor.

on a cache miss, probe only the reached instruction's required bytes, at most the x86 15-byte instruction limit, before resource admission. a reached fetch/coverage/invalid outcome wins over exhausted translation limits. operand-data faults are evaluated during execution, after admission. bounds on source bytes below constrain the admitted unit, not this bounded diagnostic probe. diagnostics from discovery beyond the reached instruction cannot fail the reached prefix early.

reuse depends on code-image identity, the fixed execution-context identity and guest entry pc. an artifact owns its installed entry mappings; eviction removes those still pointing to it, preserving any newer owner's mappings. pending browser compilation may publish only to its still-valid owner/image/context. the fixed, idle-only lifetime rules above prevent concurrent replacement.

the harness supplies explicit finite positive limits for admitted instruction count and distinct source bytes per unit, emitted wasm bytes per artifact, cached artifact count/bytes and translation attempts per public run. limits have no implicit defaults. a unit too large to fit even an empty cache returns resource refusal; do not evict forever. attempts include unsuccessful admissions and reset on each public run; cache hits consume none. tests use small limits to exercise refusal and eviction. values are implementation budgets, not architectural limits.

resource exhaustion returns a distinct outcome with the completed state. do not discard prior execution, silently relax limits or retry forever. removing references does not establish immediate browser-native-code reclamation.

## literal integrated case

entry is `0x1000`; flags are `0x2`. for this fixture, register order is `rax, rcx, rdx, rbx, rsp, rbp, rsi, rdi, r8..r15`; initialize bank `i` to `0x1122334400000000+i`, overriding rbx with `0x0000000100004000`. map 24 ram bytes at `rbx-8` with literal contents `1011121314151617a0a1a2a3a4a5a6a7f0f1f2f3f4f5f6f7`; the middle eight bytes are the destination.

| pc     | bytes        | instruction      |
| ------ | ------------ | ---------------- |
| `1000` | `b800000000` | `mov eax, 0`     |
| `1005` | `b903000000` | `mov ecx, 3`     |
| `100a` | `4801c8`     | `add rax, rcx`   |
| `100d` | `4883e901`   | `sub rcx, 1`     |
| `1011` | `75f7`       | `jnz 100a`       |
| `1013` | `488903`     | `mov [rbx], rax` |
| `1016` | —            | requested stop   |

the three loop iterations produce `(rax,rcx)=(3,2),(5,1),(6,0)`. completion has rip `0x1016`, rax `6`, rcx `0`, flags `0x46`, and exactly 12 retired instructions. the destination becomes `0600000000000000`; every other register and ram byte remains unchanged. budget 13 with that stop returns stop/retired 12/remaining 1; budget 12 returns budget at the same pc.

after budget 5 from the initial state, require rip `0x100a`, rax `3`, rcx `2`, flags `0x2`, and unchanged ram. resume with budget 8 and stop `0x1016`: require stop, retired 7 and remaining 1, with the same final state as uninterrupted execution. other banks and all guard bytes remain unchanged at each observation.

this literal is a path test, not a workload recognizer or a performance acceptance target.

## verification

verify the following through the real host/core/generated-wasm path:

1. exact decode/length/operand cases and actual generated execution for every admitted form and width, including extended registers, ignored rex fields, signed immediates and displacement boundaries. decoder-only success cannot satisfy instruction execution coverage.
2. literal 32-bit zero-extension and 64-bit wrapping cases; carry/borrow, signed overflow, auxiliary carry, parity, zero and sign; cmp preserving the complete operand bank; mov/branch preserving flags.
3. complete register and guarded memory assertions for the integrated case, taken/untaken branches, overlapping instruction entries and a target outside the current translated unit. with sufficient bounds, inspect unit metadata to establish that the integrated loop executes internal multi-block edges rather than one module per instruction or host-side simulation.
4. high guest addresses, exact load/store widths, readable code, non-executable ram, out-of-range operands and no partial failed store; earlier completed stores survive a later failure.
5. budget zero/one/exact/short, stop ties and sequential resumes at each instruction boundary. stop before reachable unsupported/truncated code, then resume into its failure; also test unreachable bad code. an exhausted translation-attempt limit must not hide a reached fetch/coverage result.
6. prove actual artifact reuse while changing input gprs, flags, ram, budget and stop, with no added compilation. use input-dependent code as well as the integrated literal. test identical entry pcs in different cpu images, overlapping-entry eviction, small-limit refusal, recompilation, pending-run rejection and failed-instance disposal, with no stale entry or zero-progress loop.

the following adversarial anchors supplement the integrated case. flags start at `0x2` unless stated; assert the complete state and memory, including unchanged banks. each single-instruction case uses budget one, so successful execution returns budget at next pc.

| falsifier                                                                      | independent expected distinction                                                                                                                                                                 |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `45 39 c8`; r8=`1122334400000000`, r9=`aabbccdd00000001`                       | `cmp r8d,r9d` preserves both complete banks; flags=`0x97`. no upper-half clearing from a synthetic subtraction destination.                                                                      |
| `48 81 c0 ff ff ff ff`; rax=0                                                  | rax=`ffffffffffffffff`, flags=`0x86`; the immediate is sign-extended.                                                                                                                            |
| `48 83 e8 ff`; rax=0                                                           | rax=1, flags=`0x13`; subtracting sign-extended -1 has unsigned borrow.                                                                                                                           |
| `4c 83 c0 01`; rax=0                                                           | rax=1, flags=`0x2`; rex.r does not change `/0` into another opcode selector.                                                                                                                     |
| `48 83 c0 00`; rax=`0x100`                                                     | rax remains `0x100`, flags=`0x6`; adding zero changes flags, and parity uses only the low byte.                                                                                                  |
| `8b 43 fc`; rbx=`0000800000000000`; ram bytes `78563412` at `00007ffffffffffc` | rax=`0000000012345678`; the noncanonical raw base is allowed because the resulting four-byte access is canonical.                                                                                |
| code `b8 b9 03 00 00 00` at `1000`                                             | entry `1000` yields rax=`0x3b9`, rip=`1005`. fresh state at entry `1001` yields rcx=3, rip=`1006`, with rax untouched. an artifact covering the byte range is not proof of an instruction entry. |
| `75 0e` at `00007ffffffffff0`                                                  | with flags=`0x42`, retire once to `00007ffffffffff2`; with flags=`0x2`, target failure at the original pc, retired zero. the unused noncanonical target cannot fault.                            |
| five-byte `b8 00 00 00 00` at `fffffffffffffffb`                               | code ends at the last u64 address and next rip is zero; importing this span is valid.                                                                                                            |
| the same five bytes at `00007ffffffffffb`                                      | budget one publishes rip=`0000800000000000`; reimporting that state is allowed. positive execution without a matching stop then returns a noncanonical fetch failure, with no retirement.        |
| code `8b 03` at `1000`, ram bytes `34 12` at `1002`, rbx=`1000`                | load crosses both readable spans: rax=`000000001234038b`, rip=`1002`, flags unchanged. the next positive execution at `1002` fails execute permission.                                           |

also distinguish valid high mappings from unmapped addresses sharing their low 32 bits, allow a read across adjacent code/ram spans, and reject mixed-permission stores without changing any byte. combine address-range or canonical failures with mapping failures to verify the declared cause priority.

native rust tests cover decode, actual pure helpers and emitted-module validation. node can provide a fast generated-wasm loop; browser execution is required to establish the complete deployment path. use independently authored literals and arithmetic expectations, not answers computed by ring64's own decoder/emitter. no test-only interpreter is required.

record translation, browser compilation/instantiation, first completion for one-shot code, reused execution and emitted/cache bytes. preserve artifact hashes, tool versions, finite limits and browser/engine version with these observations. report first-use and reused execution costs separately.

## references

- [intel software developer manuals](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html): volume 1 sections 3.4.1.1 and 3.5; volume 2 entries for mov, add, sub, cmp, jmp and jcc. these own instruction meaning.
- [rust wasm target](https://doc.rust-lang.org/rustc/platform-support/wasm32-unknown-unknown.html) and [wasm-encoder](https://docs.rs/wasm-encoder/): build and emission mechanisms.
- [v64 direct-template compiler](https://github.com/speedyHKjournalist/v64/blob/87d26deb9a77c2e98b4b684f39cc72ba9065d76a/docs/ir-design.md): implementation reference.
