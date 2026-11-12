# processor identity and virtual time

Status: implemented and independently reviewed; [verification](verification.md) records conformance, executed semantic mutations and bounded performance evidence.

## objective and selected profile

Implement CPUID, RDTSC and RDTSCP through the public CPU, with a deterministic per-CPU time bank, the selected TSC MSRs, live CR4.TSD checks and complete retirement/checkpoint/reset behavior. Start from implementation `e785914`. This closes a coherent system/context/decode path; it does not complete the thirteen architectural areas or identify Ring64 as a complete Intel processor.

Use the existing real16/32, protected16/32, v8086, compatibility16/32 and long64 execution profiles and their inherited size/stack variants. Direct CPUID/RDTSC/RDTSCP work in all applicable `linear`, fixed `ia32e-paged` and `physical` contexts, including physical PG0, non-PAE, PAE and IA32e. Preserve the existing fixed versus guest-controlled distinction: linear has fixed TSD=0 and no guest control/MSR instruction plane; fixed-paged and physical profiles use their one existing CR4 bank. This spec does not widen linear RDMSR/WRMSR recognition.

The two new contracts are deliberately private machine choices: conservative positive-capability disclosure and a retired-instruction virtual clock. Neither host CPU identification nor wall time supplies them. [Selection and falsification](review.md) distinguishes architectural source facts from these choices. Existing [state/context](../mode-context-and-decoding/spec.md), [numeric controls](../numeric-execution-controls/spec.md), [paging](../legacy-paging-and-permissions/spec.md), [reset](../reset-and-mode-transitions/spec.md), [debug](../hardware-breakpoints-and-debug/spec.md), [events](../external-interrupts-and-halt/spec.md), [I/O](../port-io-and-string-io/spec.md) and [owner reuse](../context-and-code-reuse/spec.md) contracts remain authoritative except for the specifically admitted instructions, time MSRs and TSD bit.

No configurable CPUID table, host clock/provider callback, named Intel family/model, hardware-cycle/frequency promise, multi-vCPU time synchronization, PMU/RDPMC, TSC_ADJUST/deadline/offset/scaling, SERIALIZE, APIC platform, XSAVE/AVX or new numeric feature gating is included. No changes to README, dependencies or CI policy belong to the implementation.

## immutable identification policy

CPUID is an immutable disclosure profile, identical across instances, contexts, resets, browsers and host architectures. Its twelve-byte vendor string is `Ring64Engine`. No runtime setter or arbitrary leaf callback is required. Only the following records have nonzero output; each record ignores input subleaf ECX, including nonzero/high-bit values. Every other low32 EAX query returns four zeros, including reserved, out-of-range, topology, hypervisor, frequency and xstate leaves. This zero policy is a pinned Ring64 choice, not a claim that every Intel CPU treats invalid leaves identically.

| input low EAX | output EAX | output EBX | output ECX | output EDX |
| ------------- | ---------- | ---------- | ---------- | ---------- |
| `00000000`    | `00000001` | `676e6952` | `656e6967` | `6e453436` |
| `00000001`    | `00000000` | `00000000` | `00000000` | `00000010` |
| `80000000`    | `80000001` | `00000000` | `00000000` | `00000000` |
| `80000001`    | `00000000` | `00000000` | `00000000` | `08000000` |

Vendor bytes concatenate EBX, EDX, ECX, each little endian. Leaf1 EDX bit4 certifies the selected TSC instruction/control contract. Extended leaf1 EDX bit27 certifies RDTSCP and its AUX behavior; RDTSCP must not execute while reporting that bit clear. No invariant-TSC or frequency leaf is exposed. In particular, leaf1 MSR/FPU/MMX/SSE/SSE2/SEP, extended NX/LM, XSAVE/OSXSAVE/AVX and hypervisor feature claims remain clear; no signature or brand string implies a named Intel generation. A later positive family claim needs an explicit family/state/control audit and a deliberate profile revision.

A clear family bit means **no complete-family claim in this incremental private profile**. It does not change inherited instruction admission or assert Intel feature-absence equivalence. This distinction is necessary: existing LFENCE remains executable although the SSE2 disclosure bit is clear, whereas Intel's LFENCE reference associates a clear SSE2 bit with #UD. Partial x87/SSE and existing selected long-mode/MSR paths likewise remain under their existing contracts. Do not add a second global feature-enable mechanism or turn currently valid private-profile operations into #UD to make this table resemble a named CPU. Positive TSC/RDTSCP claims, unlike unclaimed families, must be delivered in full under the selected fixed/controlled profiles.

CPUID consumes **live low32 EAX and ECX**. It replaces full RAX/RBX/RCX/RDX with zero-extended u32 outputs in every mode, including real/protected/v8086. Do not reuse a generic legacy32 write that preserves the raw upper32. R8–R15 and all other state are unchanged apart from the normal instruction-begin/completion effects. EFLAGS.ID does not enable/disable CPUID; test ID0/1 without changing existing flag-import/POPF rules.

CPUID is serializing under the existing synchronous private-memory model: previous guest effects complete before its result, and successor architectural fetch/execution uses current code/context. An explicit unit end/redispatch is a valid realization. Speculative discovery remains observational; it must not read future CPUID inputs as guest state or perform time work. RDTSC is not upgraded to a serializing operation. RDTSCP orders prior operations/loads as applicable to this private synchronous model and makes no new global-store/shared-worker visibility promise. None of these instructions is an x87 waiting operation or a guest-memory operand for data watchpoints.

## virtual time and retirement

Every CPU starts with `tsc=0`, `tscAux=0`. Time is unsigned64 modulo arithmetic. An ordinary successfully retired guest instruction advances it by one. A read samples the clock **before its own retirement**; its successful retirement then advances the clock by one. CPUID, HLT, control writes, clock/AUX reads and ordinary instructions count in this same domain. TSC_AUX writes count normally. The selected TSC write replaces the value at its own retirement, as defined below.

This is a deterministic retired-instruction timebase, not native cycles or elapsed seconds. A long REP advances once when the REP instruction retires, not once per committed element. Zero-count REP also retires once. A partially completed REP with retired0 advances zero despite retained element effects. Failed instructions, pre-begin paging restarts, failed numeric waits, compilation/discovery/probes, cache/admission/resource work, event entry/delivery attempts, host reads/imports, pauses and halted waiting advance zero. Earlier instructions retired before such a boundary still count exactly once. Handler instructions and IRET count normally; automatic frame construction and pending-event bookkeeping do not.

Budget partitioning, repeat allowances, empty calls, stop gates, cache/middle-entry choice, context reuse, source repair and browser scheduling cannot change the clock for the same actual guest instruction trace. A delivered handler adds its actual instructions to that trace. No promise of monotonicity survives an explicit TSC write, host time import, reset or modulo wrap; without those, advancement follows the rule above.

At initial100, `NOP; NOP; RDTSC; MOV EBX,EAX; RDTSCP` yields first sample102 preserved in EBX, second sample104 in EDX:EAX, and final105. AUX is returned in ECX. Use the correct operand prefix for a32-bit MOV in CS.D16 and seed EBX upper bits appropriately. The same program and final full state must agree under one budget5 run, five budget1 runs, mixed splits and cached middle entries. A run containing only non-clock arithmetic must still update a later host time read.

### one authority, live accounting

The public bank has one authoritative owner. Generated execution may temporarily use a biased base internally, but no second independently mutable Core/host counter may compete with it. Public idle reads always see settled architectural time. The existing scalar snapshot prefix176 and numeric layout offsets stay intact; expose any appended bank/layout fields through the existing authoritative descriptor rather than duplicating Rust/TypeScript offsets. Keep the generated run's five-argument ABI.

A source-grounded candidate uses the original generated-run budget argument `B`, live local remaining `R`, and an invocation base `b`. Define `d=B-R`, the instructions already retired in that native invocation. Read `b+d` modulo64 without settling. Any semantic helper needing this value receives the original B and live R (or their exact u64 delta); the existing paging-control import has neither, so its canonical state is insufficient. An internal helper signature may change without changing the five-argument generated-run ABI. At its common normal epilogue settle exactly once to `b+(B-R_exit)`. Thus no tick/check or JS boundary is needed at every guest instruction. Other realizations are allowed only with the same observables and explicit equivalence evidence.

For a successful WRMSR(TSC) writing W at a point with prior delta d, a valid rebase is `b = W-(d+1)` modulo64. The instruction's successful retirement plus eventual epilogue leaves exactly W at that retirement, and later retired work adds normally. Example: writing MAX then RDTSC samples MAX; that read's retirement wraps the clock to0. WRMSR rebases the very same b subsequently used by reads and common publication, not a stale generated-local or duplicate bank. Multiple reads, prefixed work before a write, repeated writes across native entries and final publication must never credit the prefix twice. Preserve existing MSR/control unit boundaries; no removal of their terminators is required.

Do not settle from `core_clear_fault`, JSON diagnostics, `current`, `readState`, `prepareEntry` or context-version changes. Existing I/O calls clear_fault **inside** generated execution while canonical remaining is stale. Every resumable native exit, including data/target/physical faults, debug traps, partial REP, Unsupported, budget/stop and post-work resource boundaries, must pass the common publication exactly once. A fault after a successful TSC write preserves that completed write plus later retired prefix. Fatal native/JS/provider unwinds retain the existing failed-CPU policy rather than exposing a resumable half-settled checkpoint. Public same-CPU time access during execution remains forbidden.

## instructions, controls and faults

| operation | required bytes / input                                      | successful result                                                                      |
| --------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| CPUID     | `0F A2`; low32 live EAX/ECX                                 | literal four-register packet above                                                     |
| RDTSC     | `0F 31`                                                     | full RAX=zero-extended low32 sample, full RDX=zero-extended high32 sample              |
| RDTSCP    | `0F 01 F9`                                                  | RDTSC result plus full RCX=zero-extended AUX                                           |
| RDMSR     | existing `0F 32`; low32 live ECX selects `10` or `c0000103` | TSC sample or zero-extended AUX in EDX:EAX; full RAX/RDX upper32 cleared in every mode |
| WRMSR     | existing `0F 30`; low32 live ECX and low32 EDX:EAX          | TSC replacement or AUX update under rules below                                        |

For RDTSC/RDTSCP, TSD0 permits all CPLs. With PE1 and TSD1, CPL1/2/3 gives #GP(0); v8086 faults regardless of IOPL. Real-address PE0 execution remains allowed even if the physical CR4 bank has TSD1. The linear fixed profile has TSD0. CPUID is not restricted by TSD. TSD refusal uses the existing protection-fault report with vector13/error0, phase `privilege`, no selector; opt-in delivery captures the corresponding fault event. It publishes no output/AUX/time write and retires0. Earlier retired work remains counted; the inherited instruction-begin RF clear and saved fault-frame RF policy remain.

Admit CR4.TSD bit2 in both existing fixed-paged and physical bank validation, guest MOV CR4 and host bank import. Keep it solely in `PagingState.cr4`; do not add a duplicate flag to the time bank. Its value is checked live, not compiled into a clock read. A TSD-only change affects neither translation geometry/permissions nor numeric eligibility: it must not retire published artifacts, alter context identity, reload cached PAE PDPTEs or create a new observer profile. Guest control writes keep their existing completion/dispatch rules. Reserved CR4 bits, family coherence and all other control-write effects remain unchanged.

### selected MSRs

Time MSRs execute only in the **existing MSR-capable profiles**, fixed `ia32e-paged` and `physical` across PG0/legacy/IA32e. Linear retains its pre-begin Unsupported MSR/control frontier. This avoids a new fixed-linear control plane and avoids silently changing unselected runtime-index frontiers. The time bank itself still exists in linear, with host import and direct timestamp instructions.

`IA32_TIME_STAMP_COUNTER` index10 is readable/writable full u64 in the selected profile. A successful write installs W at that instruction's retirement, including W below the old value or at a noncanonical bit pattern. TSC is not an address and must not pass a canonical-pointer check. No historical P6 low32-only write model is promised.

`IA32_TSC_AUX` indexc0000103 is u32. RDMSR returns AUX with RDX0. WRMSR rejects nonzero supplied bits63:32 with #GP(0), publishes no AUX/time change of its own and retires0; it does not silently truncate. Accepted AUX updates are visible to the next cached RDTSCP and do not alter processor identity/topology, descriptors, debug state or translations.

Apply inherited privileged MSR admission, including v8086 refusal, before a selected time access. Selected MSR CPL/v8086 refusal preserves the existing global privilege guard and protection-fault phase `privilege`; selected AUX reserved-value refusal uses semantic phase `target`. Both are vector13/error0/no selector. Retain source reason/metadata and report-versus-pending behavior; do not conflate these two diagnostic phases. Dispatch the selected indices to their semantic owner rather than putting counters among canonical syscall pointer MSRs or requiring the counter to be stored in a paging bank. All unselected MSR index/profile, prefix, privilege and value frontiers remain inherited; no blanket #GP conversion for currently Unsupported valid indices. CPUID.MSR remains clear because this cohort does not certify the complete MSR plane.

### decode and boundary integration

Recognize exact RDTSCP F9 before the existing `0F 01 /7` INVLPG register-form rejection. Preserve F8 SWAPGS and every unselected /7 neighbor, ModRM/required-tail fault and fixed/physical distinction. CPUID/RDTSC consume two opcode bytes, RDTSCP three; no speculative immediate, selector, EA or guest-memory read is added. Operand/address/segment and REX prefixes affect length but not fixed outputs/inputs. F2/F3 are ignored for these three operand-free operations, including repeated/mixed F2/F3 consumed by the inherited last-repeat-wins parser. Repeated66/67 and REX handling also stay inherited. Sole LOCK gives #UD after required decode; repeated LOCK and LOCK combined with F2/F3 retain the parser's pre-begin Unsupported frontier. The15-byte limit remains unchanged. F9 recognition uses raw ModRM fields; ignored long64 REX.B/R must not reinterpret it as a GPR/INVLPG operand. Bytes40..4f are REX only in long64; in other modes their existing INC/DEC instruction meaning and separate retirement remain. Complete required-byte/fetch faults precede execution. No clock read, write, retirement or bank mutation occurs on budget0 or stop-current.

Decode undefined LOCK sources retain inherited decode-fault report/delivery/RF timing. Execution TSD and MSR faults retain their runtime fault timing. Literal `F3 F3 0F A2`, `F2 F3 0F31` and `F3 F2 0F01 F9` must complete with ignored repeat prefixes; test sole LOCK and both orders of LOCK/repeat separately. Numeric EM/TS/NE, pending x87/MXCSR state and partial-family CPUID zeros must not accidentally block these nonnumeric instructions. Execute breakpoints can stop before the read; successful TF/data completion observes installed outputs and one retirement. Internal time-bank/scratch writes are not guest memory watchpoint traffic. SS-deferred debug, queued IRQ/NMI, handler allowances and HLT use their existing arbitration; no new event class or shadow is introduced.

## public bank and lifecycle

Add exported `TimeState { tsc: bigint; tscAux: number }`, synchronous `cpu.readTimeState(): TimeState` and `cpu.setTimeState(state: TimeState): void` for all memory models, following existing bank API naming/export conventions. No constructor option or mutable identity API is needed. Getter results are detached owned values. Setter requires a non-null, non-array object with both fields: primitive unsigned64 bigint TSC, finite integer number AUX in0..ffffffff; normalize negative-zero AUX to0. Reject strings, boxed values, bigints for AUX, numbers for TSC, missing/undefined/null fields and out-of-range values atomically. Capture named fields at most once into owned values using existing bank conventions; do not coerce values or enumerate unrelated properties; no lazy reference to caller state remains. Invalid shape/type/range throws TypeError; lifecycle/generation refusal uses the existing Error convention. Input accessor exceptions propagate unchanged before publication. Exact error wording is not a new contract.

Both methods require idle, non-disposed, non-failed CPU state. A setter's input accessor can run/dispose/reset or mutate the CPU: apply the existing capture-generation discipline, and reject a completed run during capture rather than silently permitting a stale time write. Existing setters that permit a completed run are not a reason to allow it for this bank. Rejected capture publishes no setter-originated change. Effects performed by an accessor remain: there is no rollback of a completed run, reset, disposal or independent bank mutation. Without accessor side effects, rejection leaves the complete CPU state unchanged. Independent CPU instances never share mutable time or AUX.

A host time import changes only the explicit bank, without retirement, callbacks, event cancellation, context-version changes, translation invalidation or recompilation. `setState`, `setContext`, numeric/debug/fast-system/paging bank changes, mapping/backing edits and cache eviction do not reset or recredit time. A full checkpoint includes this bank separately from the unchanged scalar `StateSnapshot`; scalar import resetting transport remaining must not mint or replay ticks. Pending exception/debug/interrupt images keep their captured source lifetime when the time bank is inspected or repaired.

Physical `reset()` returns TSC/AUX to0, keeps immutable CPUID identity, and preserves the existing reset memory/lifecycle/cancellation contract. Linear/fixed-paged reset frontiers remain unchanged. Restoring an old full checkpoint deliberately restores its time, AUX and existing scalar/context/numeric/event state in the predecessor's valid import order; it is not an automatic rollback by `setState` alone. No new in-flight timestamp request, asynchronous provider or public continuation object is added.

## acceptance and adversarial packets

Implement a bounded shared Node/Chrome suite and native owner tests, with independent literal expectations. Required packets include:

1. **Identification literals:** every table row, nonzero/high-bit ECX subleaf, low32 EAX with dirty high32, unknown queries2/7/15/16/0d/40000000/80000007/80000008/ffffffff. Check vendor byte order and full16-GPR/FLAGS/numeric preservation across all inherited profiles. EFLAGS.ID0/1, same CPU after reset/context changes, independent CPUs and Node/Chrome return identical packets. Prove inherited LFENCE and representative numeric/long-mode operations remain admitted despite unclaimed family bits.
2. **Direct samples and partitions:** initial100 and AUX89abcdef; the five-instruction example yields102/104/final105 under all budget partitions, source/target aliases, warm middle entries and debug misses. Repeat with no clock instruction, source fetch/compile refusal, budget0, stop-current/next, no-work resumes and long host pauses. Reads and rejected setters perform no implicit clock advancement; separately invoked accessor effects retain their normal semantics. With original budgets `2^32+1`, `2^63+1` and MAX, stop-bounded `NOP; RDTSC` from100 still samples101/final102: huge unused allowance must not truncate or sign-corrupt B−R. Source operations before a later fault still count once.
3. **Raw outputs/wrap:** initialMAX−1; NOP reaches MAX, RDTSC samples MAX then wraps0, RDTSCP samples0 and AUX, final1. Dirty upper32 of every output register must be zeroed in real/protected/v86/compat/long64. Unchanged registers retain all64 bits. Boundary TSC values0/ffffffff/100000000/MAX distinguish halves; AUX0/ffffffff and nonzero software IDs remain separate from CPUID identity. With TSD0 and initial100, literal `40 0F 31` is one long64 RDTSC sampling100/final101, but INC followed by RDTSC in non-long64 modes samples101/final102; compare FLAGS and separate budget1 resumes too.
4. **TSD matrix:** all CPLs and real/protected/v86/compat/long64, fixed/physical controls and linear fixed0. TSD1 denies only the specified modes/CPLs; CPUID always works. Combine sole LOCK, truncated opcode/F9, execute breakpoint/RF, TSD, numeric-disable state and pending x87 to prove priority. Check complete report, pending event and literal guest #GP frame; guest handler clears TSD, IRETs and retries exactly once. A failed read publishes neither result nor its own tick.
5. **MSR packets:** live low32 ECX comes from dirty preceding generated locals; full low32 EDX:EAX assembles TSC writes without canonical checks. Nonzero retired prefix before WRMSR must land exactly W at its retirement. Test0/MAX/bit47/bit63 values, backward writes, read-after-write across native entries and repeated writes/resumes. AUX upper32 rejection preserves both fields/GPRs and allowance, with phase `target`; CPL/v8086 refusal has phase `privilege`. Earlier retired prefix remains counted in either case; CPL0/1/2/3/v86/real and all MSR-capable families are covered. Linear and unselected MSR frontiers are explicit negative controls.
6. **Accounting exits:** full/partial/zero-count REP and string I/O, committed elements before later fault, waiting numeric fault, source PagingRestart before begin, post-begin source A/D change that still completes a captured transfer, ordinary/far/syscall/IRET boundaries, resource/target-fetch refusal after completed work. Count known guest instructions independently; do not derive expected ticks solely from the production retired result. I/O's mid-unit clear_fault is a required no-double-credit packet.
7. **Debug/events:** completed RDTSC/RDTSCP plus TF exposes outputs and settled one tick before pending #DB; execute breakpoint exposes neither. Old SS-deferred causes, IRQ/NMI after completion, blocked NMI, HLT/wakeup, zero delivery allowance, failed/secondary entry and shutdown add only actual handler instruction retirements. Inspection/checkpoint/import of ready and pending states causes no hidden tick.
8. **Lifetime/validation:** two CPUs, compiler reuse, detached readback, mutation of input objects after import, malformed fields, and accessors that complete a run/reset/dispose the same CPU. An accessor that retires one NOP from TSC100 and then returns valid fields must cause setter rejection while leaving TSC101; accessor reset leaves reset TSC0, and accessor disposal remains disposed. Warm TSD/AUX/TSC changes affect the next cached read without recompilation; context epochs0/MAX−1/MAX, eviction, backing reincarnation and A→B→A code/context changes cannot freeze or duplicate clock state. Physical reset and full checkpoint replay check scalar, bank, memory, numeric, debug and pending-event ownership together.

Use a finite independent BigInt retirement ledger and literal CPUID words that import no production decoder/time helper. A fixed-seed program corpus combines ordinary producers, reads, writes, legal branches, all partition compositions of short programs, modulo carries and fixed expected fault/retirement events. Include at least both default code widths, long64, controlled/fixed memory families and the concrete packets above. The oracle must check both read values and final full bank/state, and compare the reached instruction count independently with RunResult.retired. Native mathematical rebase checks are not emitted-Wasm evidence.

Execute semantic mutants for per-read-only clocks; ticking partial REP/delivery/compile; stale canonical remaining; double epilogue credit; wrong WRMSR own-retirement offset; high32 preservation; host time/identity dependence; AUX truncation; wrong TSD/PE/v86 priority; F9 misclassification; cached CPUID input/TSD/AUX/time; profile-bit numeric gating; setter capture after run/reset; and reset or scalar-import double credit. Count named unchanged semantic assertion failures, never build errors, traps, timeouts or generic engine failures. Restore source/input identity before final verification.

## owners, implementation order and verification

Keep identification/clock meaning with portable x86 semantics; it may have a small local owner chosen from implementation evidence. [Instruction/decode](../../src/x86/instruction.rs), [system decoding](../../src/x86/decode/opcode.rs) and [the F9 consumer](../../src/x86/decode/protection.rs) supply precise selected forms. [CR4/MSR controls](../../src/x86/paging/controls.rs) retain control authority, [state publication](../../src/dbt/wasm/state.rs) owns generated settlement, and [embedding layout](../../src/embedding/layout.rs) remains the transport authority. [Core execution](../../host/core.ts) and [CPU lifecycle](../../host/cpu.ts) coordinate without computing guest clock semantics in TypeScript. Reuse the existing fault/event/debug and artifact owners; no global provider registry, broad system-state object, new package map or unrelated refactor is prescribed.

Preserve real code style: typed preparation/errors before publication, primitive fixed-width values and explicit mode/profile checks. The current translation relation in `src/x86/paging/controls.rs` is:

```rust
pub fn translation_changed(self, other: Self) -> bool {
    (
        self.cr0 & !CR0_NUMERIC,
        self.cr3,
        self.cr4 & !CR4_NUMERIC,
        self.efer & EFER_NXE,
        self.pdpte,
    ) != (
        other.cr0 & !CR0_NUMERIC,
        other.cr3,
        other.cr4 & !CR4_NUMERIC,
        other.efer & EFER_NXE,
        other.pdpte,
    )
}
```

Exclude TSD in both CR4 terms while retaining the complete CR0/CR3/EFER/PDPTE relation. A runtime-only permission bit does not become a translation identity or a second control bank.

Implement in reviewable dependency order: (1) literal profile/time-bank/ledger tests and source-frontier RED; (2) one authoritative transport and common-exit accounting with ordinary/no-clock/partial-work checks; (3) CPUID/direct timestamp decode, live results and exact completion; (4) CR4.TSD and selected MSR routing/admission; (5) host bank/checkpoint/reset/capture lifetime; (6) public matrix, independent oracle, semantic mutants, source reviews and measured performance. All steps belong to one delivery; logical commits do not narrow scope. No implementation/commit/push occurs during this specification-preparation task.

Use existing commands from repository root:

```sh
npm run format:check
npm run lint
npm run typecheck
cargo test --locked
npm run build
npm test
npm run test:browser
npm run check
```

Always validate inputs before bank writes, keep immutable identity separate from mutable time, preserve other owners' fault/progress rules, and run appropriate checks before implementation commits. New dependencies, host-time policies, profile configurability or expanded MSR/ISA claims require an explicit spec change before their implementation; they are not hidden necessities of this cohort. Never alter README, erase failing assertions, conflate Unsupported with #UD, freeze live values into translation keys or use Date.now/performance.now as guest TSC.

Freeze predecessor and final own Core/host/fixtures with exact source/hash identity. New clock behavior has no executable predecessor denominator: characterize CPUID, timestamp reads, reads/writes/AUX/TSD, batched and sparse clock access, helper/serialization boundaries and short resumes separately. Measure creation/first/warm execution, generated/Core/cache/transport bytes, copies/helper crossings, resources and actual work caps. The common-exit accounting has an unavoidable candidate cost per native entry: do not promise an inactive zero-cost path or silently evade the bank contract by enabling time only when a clock instruction is discovered.

Preserve the [call-gate performance protocol](../call-gates-and-privilege-stacks/verification.md): inherited170-row report/eligible matched screens, recovered x87 stack/MMX and five IA32e kernels, ordinary far/call-gate/syscall/IRET and short-resume/context-owner controls. Compare actual guest state/retirement/resource flow while recording expected generated-byte growth; new epilogue bytes are not falsely required to equal the predecessor. Run balanced/reversed and final A/A controls, retain zero/sub-tick samples and undefined ratios, and investigate repeatable regression evidence. No hardware-cycle, wall-clock calibration, p99 or application-throughput conclusion follows from the retired-work clock or a synthetic loop.

Completion requires all selected forms/profiles, exact public bank/lifecycle, the literal/fault/partition packets, native and both public runtimes, independent expectations, executed semantic mutation evidence, full final checks, independent source/claim reviews and bounded measured performance. A CPUID-only placeholder, wall-time clock, lost retirement prefix, partial-REP tick, stale/duplicated bank or unexplained repeatable control regression blocks completion.

## primary sources

The [official Intel SDM portal](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html) was checked during preparation and identifies revision093. Existing local093 snapshots supply the inspected instruction/control text. Architectural sources do not select Ring64's disclosure table, zero-leaf policy, retired-work rate or WRMSR retirement replacement policy.

- [Intel SDM volume2A](https://cdrdv2.intel.com/v1/dl/getContent/671199), CPUID3-203/204; LFENCE3-552 for the feature-absence distinction.
- [Intel SDM volume2B](https://cdrdv2.intel.com/v1/dl/getContent/671241), RDTSC4-559/560, RDTSCP4-561/562, RDMSR and MOV control-register references.
- [Intel SDM volume2D](https://cdrdv2.intel.com/v1/dl/getContent/671143), WRMSR operation and value/privilege exceptions.
- [Intel SDM volume3B](https://cdrdv2.intel.com/v1/dl/getContent/671427), time-stamp counter/TSC_AUX and ordering context; [volume4](https://cdrdv2.intel.com/v1/dl/getContent/671098), selected MSR definitions10/c0000103.
