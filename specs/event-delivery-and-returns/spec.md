# event delivery and returns

## purpose

Connect selected processor-detected exceptions to guest IVT/IDT handlers and the existing IRET path. A guest can repair a divide error, handle a single-step trap or numeric exception, and resume with the correct instruction, flags and stack. Delivery failures distinguish architectural escalation from a repairable private-memory refusal.

This follows [software events and iret](../software-events-and-iret/spec.md), [system flags and instruction boundaries](../system-flags-and-instruction-boundaries/spec.md), [descriptor tables and segment loads](../descriptor-tables-and-segment-loads/spec.md) and [memory map and code validity](../memory-map-and-code-validity/spec.md). Their gate, TSS, IST, privilege-stack, return and private-publication contracts remain the foundation.

The existing implementation already has those consumers and precise divide, protection, numeric and debug outcomes. Paging would additionally require guest control-register authority, physical backing and page walks; x87 special functions would extend a separate numeric surface. This increment closes detection → handler → return before adding either foundation. It does not establish application compatibility or complete exception coverage.

## scope and event sources

Support delivery in imported real, protected16/32, virtual8086, compatibility16/32 and long64 contexts. Select the following sources; source classification belongs to the architectural producer, before transport to the host.

| source                                                         | vector                       | class | exception error code |
| -------------------------------------------------------------- | ---------------------------- | ----- | -------------------- |
| DIV/IDIV divide error                                          | 0, #DE                       | fault | none                 |
| existing TF single-step outcome, including partial REP         | 1, #DB                       | trap  | none                 |
| explicit UD2 `0F 0B`                                           | 6, #UD                       | fault | none                 |
| existing typed protection failures                             | 10/11/12/13, #TS/#NP/#SS/#GP | fault | exact producer code  |
| existing numeric reserved-control `general-protection` outcome | 13, #GP                      | fault | zero                 |
| existing pending x87 checking outcome                          | 16, #MF                      | fault | none                 |
| existing unmasked SIMD numeric outcome                         | 19, #XM                      | fault | none                 |
| escalation selected below                                      | 8, #DF                       | abort | zero                 |

UD2 consumes its two required opcode bytes and faults without retirement. In report mode it retains the existing `unsupported` exit; delivery mode recognizes its selected architectural source. Sole LOCK is invalid for UD2 and produces #UD in delivery mode after its selected required bytes. Other inherited prefix frontiers remain unchanged. This addition does not make unknown opcodes architectural #UD.

Preserve UD2's report-mode pre-begin, pre-translation frontier, including required-byte failures, prefix handling and resource priority. Reaching it must not compile another artifact, clear RF or turn an old Unsupported exit into resource-limit. Delivery-mode recognition still precedes a translation allowance check at that frontier; apply the selected instruction-begin RF effect before capturing its fault image. Discovery must not speculate an event from an unreached successor. Alternating report/delivery runs and retained middle entries must preserve these rules without selecting guest meaning from stale artifact metadata.

Keep generic `invalid-encoding`, `unsupported`, `segment-fault`, `alignment-fault`, linear fetch/data/target faults, `system-memory-fault`, resource limits and engine failures outside the automatic source set. In particular, the current decoder also uses Invalid for the 15-byte length frontier, whose architectural meaning differs from #UD. Segment geometry and mandatory-alignment diagnostics likewise lack this spec's selected vector/error-code provenance. Do not infer a vector from a reason string or blanket-convert these records. A future producer extension must define its architectural classification explicitly.

Private unmapped, permission and address-range failures are not #PF. This contract adds no CR2 or page-fault error code. IRQ/NMI, HLT/wakeup, DR breakpoints, task gates/switching, CR/MSR/reset transitions, feature-enable changes, paging, CET, FRED, VMX and SMM remain separate coverage. Existing software INT instructions still deliver directly under their own contract; their successful entry is not a new automatic exception.

## host contract and bounded progress

Extend `run` with one opt-in option:

```ts
await cpu.run({
  budget: 100n,
  repeatBudget: 1000n,
  exceptionDelivery: { budget: 16n },
});
```

Omission preserves existing report behavior, result reasons and instruction effects. No pending event is created by reporting an ordinary detected exception in that mode. An explicitly undefined option also means omission; null, malformed objects, missing/invalid budgets and values outside unsigned64 reject before admission. Capture each caller-controlled property once, then perform the existing final lifecycle/run-generation check. A successful intervening run invalidates capture even if it completed synchronously.

When present, its required unsigned64 budget bounds automatic entry attempts. Debit one immediately before each attempt, whether it succeeds, finds an architectural entry fault, encounters Unsupported task machinery or meets a private refusal. Capturing a source or selecting its replacement exception is not another attempt. Software INT entry and IRET retain their ordinary instruction accounting and do not debit this allowance. Automatic entry never retires a guest instruction or a repeated element.

Add `deliveryAttempts` and `remainingDeliveryBudget` to results of opted-in runs; their sum equals the supplied allowance. Count attempts, not only successful entries. Retired instructions and completed REP elements keep their existing counters. Zero-retirement handler dispatch is valid only with independently verified event progress; do not weaken the host's general no-progress guard. A cycle whose first handler instruction repeatedly faults must exhaust the delivery allowance even if no instruction retires.

At initial run entry, existing budget0 and stop-at-current-RIP gates prevent all work, including pending delivery. Otherwise a retained event is serviced before probing or executing guest bytes. After a newly detected selected event, stage and service it before post-execution budget/stop gates: a last-allowance completed instruction's TF trap is not lost. With no delivery allowance, return `event-budget` with that pending event intact, without an entry read or write. After successful entry, apply instruction budget and stop-at-handler before fetching handler bytes. A zero instruction allowance after a completed trap can therefore expose a delivered frame and handler RIP while executing no handler instruction.

Append `event-budget`, `pending-exception` and `shutdown` reason IDs without renumbering existing reasons. If a previous opted-in run left an event pending and a later run omits the option, return `pending-exception` after initial budget/stop gates; do not consume it or execute its continuation. A private failure during automatic entry retains its existing typed exit and also leaves the pending event in state. Successfully delivered source diagnostics must not leak into a later unrelated exit.

## pending state and host replacement

Extend the existing scalar snapshot with a detached `event` projection:

```ts
type ExceptionEvent = {
  vector: 0 | 1 | 6 | 8 | 10 | 11 | 12 | 13 | 16 | 19;
  instructionPc: bigint;
  returnPc: bigint;
  savedFlags: bigint;
  errorCode?: number;
};

type EventState =
  | { kind: 'ready' }
  | { kind: 'pending'; exception: ExceptionEvent }
  | { kind: 'shutdown' };
```

The vector fixes the class in the source table; do not add a second mutable class authority. `instructionPc` identifies the originating guest instruction, including after escalation. `returnPc` is the logical continuation to save, not a linear address. Pending state retains selected frame inputs, not captured IDT/TSS bytes or prepared memory writes. Every attempt reads the currently installed tables and selected live TSS fields again. No unbounded exception log or recursive host stack is part of this state.

Construction starts ready. `readState()` and run snapshots always include `event`. `setState()` accepts its complete replacement; omission selects ready, matching the optional interruptibility input convention. Explicit undefined/null or malformed event input rejects. Capture and validate the entire scalar/event input before publication. Validate unsigned64 PCs, `returnPc == state.rip`, unsigned64 saved FLAGS with bit1 required and admitted mask `0x3f7fd7`, VM agreement with the context at publication, and the error-code discriminant: absent for0/1/6/16/19, u16 for10–13, exactly0 for8. Fault/abort saved images require RF1. Outside RF and mode-derived VM, saved FLAGS must equal the imported live scalar flags; changing those flags while retaining an incompatible pending image rejects. Reject mismatches without changing state, event or code ownership. This is a host checkpoint/import capability, not guest exception injection machinery.

Successful `setContext()`, including an equal import, selects ready as it clears interruptibility. A rejected import changes neither. Context replacement and scalar replacement are explicit ways to discard a pending event or leave shutdown; this is host state replacement, not an architectural reset. Restore a full checkpoint by installing context before its scalar/event snapshot. Validate against the context that exists at publication, including successful reentrant setter effects; never against a context cached before caller getters ran.

Memory/mapping/backing operations, numeric-state imports and readbacks preserve pending/shutdown state. This permits private IDT/TSS/stack repair. A caller that wants to change RIP or abandon delivery replaces scalar state with ready; a round-trip preserving pending must keep its return PC consistent. Frame PC/FLAGS remain captured while the current GPRs, stack pointer, numeric state and memory are the live state on the next attempt. Invalid scalar/context imports preserve effects of successful nested host operations, following the existing ordering contract.

Pending state survives `clear_fault`, probe preparation, private suspension, cache eviction, compilation refusal and public run boundaries. It is not a transient diagnostic. Clear it exactly once when entry commits. If entry succeeded but handler translation/compilation cannot proceed, expose ready state at the handler; resumption must not write the frame again. Shutdown is retained until explicit host replacement or disposal and returns `shutdown` without instruction work on subsequent admitted runs; shutdown takes priority over budget/stop because no execution can resume.

## processor entry and saved state

Generalize the existing event owner to accept a processor exception source independently of `SoftwareEventDescriptor`. Processor events bypass software gate-DPL and virtual8086 IOPL admission. They still validate the gate, target code, CPL relationship, presence, selected TSS/IST stack and frame under the inherited rules. IF and STI shadow do not mask these sources. Existing SS-load single-step suppression decides whether #DB is produced; delivery does not recreate a suppressed trap.

In delivery mode, staging #DB defers the producer's report-only shadow clearing until entry commits. Preserve the post-instruction, pre-delivery interruptibility state: normal instruction completion can consume an old shadow, STI can create a new one, and an unfinished REP can retain one. Allowance exhaustion or private entry refusal does not perform the missing delivery's clearing. Report mode retains the predecessor's existing clearing on a reported architectural trap.

For faults, save the faulting logical instruction PC. For #MF, this is the checking WAIT/waiting instruction, not the saved x87 producer pointer. Faulting instructions retain their established destination/retirement/status rules: #XM publishes reportable MXCSR status while preserving the destination; #MF retains deferred x87 state until the handler changes it. For #DB, save the exact existing `resumePc` and `resumeFlags`, including a completed branch/far/IRET destination or an unfinished REP's source PC and completed elements. Do not reconstruct these values from old source bytes or assume every trap retired an instruction.

Prepare the saved architectural FLAGS image with VM derived from context. Fault images set RF1 without setting live RF; partial REP #DB uses its already selected saved RF1. Other #DB images retain the producer's exact resume flags. Preserve the distinction between saved and live RF, and the instruction-specific REP comparison flags. The frame uses captured saved FLAGS; handler live FLAGS derive from the current scalar flags with the entry transformations applied. A failed attempt preserves its live source state and interruptibility; a committed entry clears both shadows and applies the existing entry TF/NT/RF/VM and gate-specific IF changes. Handler instructions do not inherit a synthetic TF completion trap from zero-retirement entry.

In real mode use the inherited fixed16 IVT frame and no error-code slot. Protected entry uses the gate's16/32-bit slots. Virtual8086 processor entry selects32-bit interrupt/trap gates, producing a returnable VM image; a valid16-bit gate remains an Unsupported frontier after gate type/presence checks and before code/TSS access. This does not assign an architectural fault to the excluded form or change the predecessor software-INT profile. IA32e uses qword slots and the existing five-slot, aligned-RSP frame and stack-switch rules. Where an exception has an error code, push it after the saved PC at the gate slot width, zero-extended from its selected value. This adds a tenth slot to a virtual8086 exception frame when applicable. The complete error-code slot participates in geometry, admission and publication. IRET does not remove this slot: the guest handler must remove it before returning.

During processor-exception delivery, use EXT1 where the inherited descriptor/IDT/TSS error-code algorithm incorporates EXT. Preserve explicit hard-zero error cases; do not blindly OR EXT into a producer's existing code. Direct software INT/INT3/INTO keep EXT0 and INT1 keeps EXT1. An architectural failure of those instructions becomes a fault at the source instruction PC; their failed instruction does not retire, and the new exception is then eligible for automatic delivery.

## failed entry, escalation and shutdown

Keep the inherited single private-memory CPU policy: capture reads and pre-admit every selected A-bit and frame write before publication. A failed attempt leaves no half-frame, accessed-byte update or partially installed context. Completed source-instruction effects remain committed. This is Ring64's private admission policy, not a claim about recoverable hardware microcode footprints.

If an attempt encounters a selected architectural protection fault, replace the pending event according to the current event's classification. Keep the originating instruction PC and selected return boundary; use the fault's exact error code and a fault saved image with RF1. For #DF, choose the original return boundary and pre-entry state deterministically for inspection; their hardware values are not a restart guarantee.

| pending entry                     | next architectural entry fault | next state              |
| --------------------------------- | ------------------------------ | ----------------------- |
| benign: #DB/#UD/#MF/#XM           | contributory: #TS/#NP/#SS/#GP  | pending secondary fault |
| contributory: #DE/#TS/#NP/#SS/#GP | contributory                   | pending #DF, error0     |
| #DF                               | contributory                   | shutdown                |

This is the reachable subset of Intel093 Table7-5. There is no page-fault producer in this contract. The general table does not say that every secondary exception makes #DF or every exception during #DF makes shutdown. A private map/geometry/resource/Unsupported refusal does neither: preserve the current pending event, return its precise refusal and permit repair/resume. A failed pending #DF attempt caused only by missing backing remains repairable. A valid unsupported task gate likewise does not fabricate #GP or shutdown.

Once handler entry commits, its delivery chain is over. A fault in handler instruction execution starts a fresh chain; it is not a second fault during the previous entry. Successful IRET uses the existing checked frame path; its own selected faults can enter a fresh chain. A delivered #DF is an abort, even though Ring64 retains a deterministic inspectable frame; tests must not treat IRET from it as architectural recovery.

## generated execution and ownership

The x86 producer owns exception meaning, saved boundary and status effects. The protection/event owner owns entry admission, frame/error code, escalation and publication. The embedding owns captured event state and its transport; the host captures options, coordinates bounded execution and owns compiled artifacts. TypeScript does not interpret x86 selectors, numeric causes or exception classes.

Existing fast generated code must remain free of per-instruction event polling, host calls or table reads. Boundary/exit paths publish all live values before servicing an exception, including GPRs, arithmetic/system FLAGS, raw SP, XMM/MXCSR and x87 effects. Helper output must not be overwritten by stale generated locals. Report and delivery runs can reuse artifacts only when the artifact's source and boundary assumptions remain valid; a mode flag must not silently change the meaning of already generated diagnostic code.

Preserve backing-aware invalidation for A-bit/frame writes and redispatch before handler execution. Table/frame/code aliases retain captured-read and write-order semantics. Context changes retire the affected owners under the existing conservative policy. Entry maps, source dependencies and pending compilations remain attached to their artifact lifetime; an exception or frame does not create another translation registry. Keep the existing five-argument generated invocation and existing numeric offsets unless a concrete implementation requirement is reviewed; consume transport changes through the authoritative layout descriptor.

## acceptance packets

Use independent literal instruction/descriptor/frame packets through actual generated-Wasm execution in Node and Chrome, alongside Rust semantic/decode/transport checks. Compare full scalar/event/context state, allowances, numeric banks, guarded bytes, typed diagnostics and artifact accounting. Shared expected results must not call the decoder or entry implementation being tested.

Packet addresses, bytes, register values and flag words below are hexadecimal; allowances and retirement counts are decimal. Use independently installed valid present/accessed descriptors, sufficient explicit limits and guarded mappings unless a packet denies them. Unlisted registers, numeric banks and bytes remain unchanged.

1. Compatibility: every inherited checked workload without `exceptionDelivery` preserves its reason, state and effects. Old scalar inputs omit event and select ready; detached event readbacks and complete round-trips include ready, pending and shutdown. Validate malformed and getter/reentrant inputs atomically, including a nested equal/changed context import and a nested cached run.
2. Protected32 same-CPL #DE: `F7 F1` at1000, EDX:EAX=0:6, ECX0, ESP8000, CS8, flags202, interrupt gate0 to2000. Frame dwords at7FF4/7FF8/7FFC are1000/8/10202; live flags2. Handler sets ECX2 then IRETD retries DIV and obtains EAX3/EDX0. The failed DIV and entry retire zero; handler MOV, IRET and successful DIV retire three. Contrast CPL3 #DE through a DPL0 gate with CPL3 `CD 00` rejection.
3. Error-code distinction: a same-CPL protected32 #GP(0) from reserved LDMXCSR input, ESP8000/CS8/flags202, places0/1000/8/10202 at7FF0/7FF4/7FF8/7FFC. Handler repairs the input and removes the error slot before IRET retries successfully. Contrast `CD 0D`, #DE and #UD, which add no error slot. Check denied final error slot, guard bytes,16-bit protected gates, inner privilege frames and virtual8086's tenth slot without partial publication.
4. Long64 completed trap: `EB 0E` at1000 with flags302, RSP8000, instruction budget1 and delivery allowance1 saves RIP1010 in the five-qword frame at7FD8 and FLAGS302 at7FE8. Use an interrupt gate; live flags become2. Entry completes before returning budget at the handler, with ready event and zero handler retirements. Leave handler bytes unmapped to prove the post-entry budget gate; an independently resumed run sees a later fetch failure without replaying the frame.
5. Partial REPE/REPNE CMPS/SCAS #DB preserves completed elements, source PC, remaining count and last-element saved flags/RF. Contrast a private repeat-budget suspension's comparison-entry flag policy. Include zero repeat allowance, zero count, final element, MOV/POP SS suppression, LSS and consecutive SS loads. TF1/IF0 STI with delivery allowance0 leaves pending #DB, IF1 and sti:true; successful resumed entry clears shadows. Report mode retains IF1/shadowsfalse. Include private refusal and unfinished REP with an incoming shadow.
6. #MF handler distinguishes producer and checking PCs and clears pending status before return. #XM handler observes reportable MXCSR flags, changes its mask or operand and retries with the original destination preserved. Unrelated numeric state and live predecessor values survive every entry/refusal.
7. UD2 report/deliver contrast, required-byte failure, LOCK, prefixes and retained middle entries. Tight source/instruction/artifact/translation limits cannot replace the inherited report-mode Unsupported or change RF; alternate run modes through reused code and successor frontiers. Generic Invalid length and legal Unsupported forms remain private frontiers in both modes. Private mapping, segment geometry and mandatory SIMD alignment failures must not accidentally enter #PF/#UD/#GP handlers.
8. Real IVT, protected16/32, virtual8086 exit/return and compatibility→long64→IRET: verify source/return PCs, flags/VM, exact slot width, same/inner CPL, TSS field limits, live TSS edits without LTR, GDT edits without reloading TR, IST1/7 and raw SS/SP caches. Processor events bypass software gate-DPL/IOPL checks while retaining target protection. Virtual8086 selects a32-bit gate; valid16-bit gates preserve pending at the specified Unsupported frontier.
9. #DE entry fails with #NP or #GP → #DF; #DB entry fails with the same error → secondary handler without premature #DF. Deny the secondary entry to reach #DF. Verify descriptor/IDT/TSS error codes including EXT1, explicit hard-zero cases and #DF's zero slot. A fault after a handler's first instruction begins is a fresh chain.
10. A contributory fault during #DF entry yields retained shutdown without frame writes or retirement; repeated runs remain shutdown until explicit host replacement. A private missing IDT/TSS/frame mapping during #DF instead retains pending #DF. Unsupported task gates do not escalate. Do not use a returning #DF handler as a recovery oracle.
11. Allowance0 stages a selected event then returns event-budget without an attempt. Allowance1 can replace a failed contributory event with pending #DF before suspension. Repair missing IDT/frame backing and resume without re-executing a completed trap. Initial budget0/stop prevents delivery; pending plus omitted option returns pending-exception. Handler-first-instruction fault loops terminate by delivery allowance with zero retirement.
12. Round-trip pending state after changing tables/mappings/numeric state; equal context import cancels it; failed imports preserve it. Shutdown replacement is a host operation. Verify saved PC/FLAGS are frozen while live operands/stack use the repaired state; reject mismatched RIP/VM/error-code images and a CF/DF/IOPL edit inconsistent with the pending saved image. Saved RF1 with live RF0 remains valid and does not leak RF into handler live flags.
13. An accessed-byte or frame write aliases executable backing, a handler/middle entry or the source instruction. No stale bytes execute. After successful entry, force translation resource refusal, eviction or stale asynchronous publication, then resume once. Frame writes are not replayed; owner/source counts remain bounded and stale diagnostics cannot reappear. A rejected WebAssembly compilation retains the inherited failed-CPU lifecycle: verify the entry/frame was already committed before rejection, then that reads/runs reject and only disposal remains available. It is not a resumable resource refusal.

## verification and performance

Use existing Rust, TypeScript and generated-Wasm test conventions; keep each expectation beside its behavior owner and register shared execution scenarios through the current suite/runners. Maintain the Rust→embedding→host dependency direction in `agents/architecture.md`; no new dependency, speculative framework or fixed source tree is required.

For implementation verification run `cargo test --locked`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm test` and `npm run test:browser`; `npm run check` is the complete formatting, lint, Clippy, Rust, build and Node/Chrome gate. For spec-only edits use `npx prettier --check specs/index.md specs/event-delivery-and-returns/spec.md` and check local links; no runtime claim follows from those checks.

Compare inherited checked kernels against source1eb3886 on identical Node/Chrome inputs in default report mode and exception-enabled runs with no detected event. Characterize delivered #DE/#GP/#DB/#MF/#XM, repaired private refusal, escalation/shutdown, partial REP, allowance-one resumes, context changes and executable aliases separately. Automatic delivery is current-only where the old build only reports; manual host emulation is not an equivalent baseline. Record attempt counts, translation/compile/instantiation, first completion, later reuse, native entries/dispatches and generated/cache bytes. Investigate material regressions with balanced/reversed samples and same-build controls; synthetic event latency does not establish application throughput.

Implementation verification must follow the state/capture contract through its consumers, then source-aware entry/error slots, pending delivery and accounting, escalation, and independent conformance/performance checks. The checkpoints describe complete behavior, not a prescribed file layout. Scope changes to source classification or host semantics update this spec before implementation.

## references

- [Intel SDM volume3A, revision093](https://cdrdv2-public.intel.com/929359/253668-093-sdm-vol-3a.pdf), §§7.5–7.6,7.10–7.15 and Tables7-4/7-5: exception classes, saved boundaries, IDT entry, error slots, EXT, #DF and shutdown. The no-page-fault subset and private admission/resume rules above are explicit Ring64 limits.
- [Intel SDM volume3B, revision093](https://cdrdv2-public.intel.com/929360/253669-093-sdm-vol-3b.pdf), §§20.3.1.1/20.3.1.4 and23.1.4/23.3.1: saved RF, single-step/REP and real/virtual8086 handling. A pending event's host import/cancellation is a Ring64 embedding contract.
- [Intel SDM collection](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html), revision093 volume2B UD2; volume2A INT/IRET and volume2D WAIT; the linked predecessor specs govern the selected numeric instruction and private diagnostic profiles.
