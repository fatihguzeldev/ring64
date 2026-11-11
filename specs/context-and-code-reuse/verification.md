# context and code reuse verification

## delivered behavior and ownership

Generated artifacts now survive nondestructive context publication. The existing Rust source-owner ID also owns an immutable full normalized `ExecutionContext`, the observed/plain profile, pending epoch and publication state. The existing host artifact cache retains bounded same-PC variants, including middle entries, under one artifact/byte cap and LRU. Incompatible owners remain dormant; dead owners never revive.

`core_publish` validates newly compiled work after browser instantiation and before cache installation. Context changes cancel unpublished owners, including at saturated epochs, without killing published artifacts. `core_activate` is consumed as a checked admission. Rejected candidates neither execute nor count as cache hits/native entries; lookup scans and private restarts are bounded separately from compilation and paging work.

All seven publisher paths use the common context-publication boundary. Their existing instruction completion, debug/external-event arbitration and dispatch boundaries remain intact. Paging fences remain destructive, including same-value guest CR3 reload; CR2, SCE-only changes and noncanonical Long64 INVLPG do not acquire new fences. Dormant code/PTE/backing aliases remain watched. No ISA, root/TLB reuse, new public option or cross-CPU cache is added.

An owner-local positive context proof avoids repeating full equality while that context remains current. It is established only after the shared full-match predicate and source activation succeed; publication alone cannot establish it. Every actual context publication clears published proofs while cancelling pending owners, independently of the numeric epoch, including `MAX`. Live observation and `Image::activate` are still checked on every admission. The proof belongs to its owner and disappears on release/fence/disposal. The positive-proof optimization adds no generated-body poll or host/Core call; cold installation uses the new publication gate.

## frozen builds

| observation            | baseline                                                           | shipping                                                           |
| ---------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| runtime source         | `c956811ea40e94d6bf683f6e105839d1a383ffef`                         | `0dec62a1c95878f6a6b744201861c9c574c61288`                         |
| core SHA256            | `af835f3d514ee7abc6fa63db6545c6c1af6a87bd3e158151e996d70bb808d017` | `bc0f715fff9bcceac715359804103041deb1fd4038197f3d547fb708fada7be4` |
| core bytes             | 1,122,118                                                          | 1,116,930 (−5,188; −0.46%)                                         |
| production host SHA256 | `c2efa3517c804f2b0e95ded18b874173d1d760ec841124e28678d24963c05f05` | `67f3732f0839e72575f5dce326dc1eac11fc206eb06f76ff12bd609fed1d1091` |
| production host bytes  | 113,829                                                            | 116,273 (+2,444; +2.15%)                                           |
| RunState               | 728 bytes                                                          | 728 bytes; existing offsets/reasons preserved                      |
| generated entry        | five arguments                                                     | five arguments                                                     |

The baseline and shipping snapshots are `build/verification/context-reuse-baseline.json` and `context-reuse-candidate-proof.json`; shipping was frozen from a clean detached `0dec62a` checkout into `context-reuse-performance-build-0dec62a`. Later evidence-script/documentation commits must not be substituted for a different runtime build. The isolated baseline rebuild, mutation restorations and shipping file all match the recorded hashes. No source in x86 instruction semantics, memory validity, Wasm instruction lowering or RunState layout changed in this vertical.

## correctness and adversarial review

The shipping `npm run check` passed format/lint, native and Wasm Clippy, **799 Rust tests, 225 Node tests, and 830 common execution scenarios in Chrome157.0.8103.39**. Node's common execution runner exercises the same830 scenarios. Evidence: `build/verification/context-reuse-check-shipping-proof.log` and `browser.json`.

The41 new shared scenarios cover14 imported mode/size profiles, FS A/B/A at one PC, dynamic scalar/numeric/debug/bank inputs, all five fast-transfer loop forms, every context writer, far/INT/IRET loops, host/guest dormant code and PTE aliases, backing incarnation and X revocation, exact paging fences/nonfences, global capacity/LRU/churn, pending context/root ABA, async source/profile changes, browser failure cleanup, getter/busy ordering and committed boundary repair. Five fast forms execute101 warm cycles under `maxTranslationsPerRun=1`, with actual browser compile/instance counters guarded. Ordinary short resumes and warmed direct middle entries are included.

Independent review added three boundary packets and a pending-paging-fence packet: early NMI unblock after failed warmed IRET/private stack refusal; committed IRQ frame followed by target stop/quota; changed consumed IDT bytes without entry replay; and pending root A→B→A that kills both pending and installed owners before fresh execution. Full scalar/context/paging/fast-system/numeric state and guarded memory are asserted where applicable. Four additional Rust proof tests prime admission before all seven actual publisher wrappers at epochs0/`MAX`, and challenge live profile, source/alias death, release, fences, failed source admission and pending ABA.

Preserved old cache-retirement expectations were deliberately updated to dormant ownership in inherited mode, protection, software-event and reentrant-import tests. Their guest state/frame/fault assertions remain exact. The inherited event benchmark's old mandatory compilation churn assertion was replaced with entry attribution/accounting; actual guest bytes, work and context/frame guards were preserved.

The preserved preimplementation AF/old-host control produced35 genuine mechanism failures across38 compatible new packets; three existing invariant controls already passed. Two actual-Core hook packets were explicitly excluded from that old-host replay because class identities differ. This source/runtime control is distinct from static review and final mutation evidence.

Four subagents contributed implementation or independent correctness, boundary and performance reviews. Findings included installed-but-unactivated lifetime, completed-writer arbitration, old retirement oracles, missing pending paging-fence proof and several measurement/classifier flaws; each was resolved before delivery. Native Clippy also exposed the need to compile ownership with the embedding's Wasm/test scope. Review alone is not counted as runtime evidence.

## mutation sensitivity and restoration

Final-source evidence is `build/verification/context-reuse-mutation-summary-shipping-b.json` with raw `context-reuse-mutations-shipping-b.json`: **23/23 distinct valid assertion kills**, separated into **8 public Cpu/generated-Wasm, 12 native owner and 3 host cache-owner** experiments. No final-source experiment is excluded or survived. Public, native and host results are not interchangeable evidence levels.

Targets include omitted FS/CPL facts, installed epoch keys, pending ABA, late-context publication, unpublished admission, release leaks, ignored activation refusal, dormant pruning, an unconverted FS-MSR publisher, dynamic bank/history errors, global LRU/count/byte caps, dormant writes, PTE read dependencies, backing recreation, destructive fences and R/X source domains. New proof-specific mutations bypass live observation, omit source activation or omit proof clearing during the actual guest FS_BASE WRMSR. The latter reads old`1111222233334444` instead of new`5555666677778888` at the reached consumer; pending cancellation and epoch publication remain intact in that mutant.

The final-source batch passes123 public scenarios before and after, restores source/tests exactly and rebuilds the exact shipping Wasm. Native panic assertions are verified against unchanged oracle source/hash; host results require a real `ERR_ASSERTION` cause and original test stack/hash. Engine crashes, build errors, empty filters, signals/timeouts and opaque reporter failures cannot count as kills. The wrong-X metadata mutation proves rejection of a legitimate R-only configuration, not stale-artifact execution.

Earlier `e299dc5` evidence remains separate:20 valid distinct kills across29 preserved experiments, with one premature dormant-pruning experiment and eight opaque-classifier results excluded and corrected by followups. It is not relabeled as final B proof. The committed [mutation driver](../../scripts/context-reuse-mutations.mjs) records exact patches, source/oracle identities and restorations in isolated `/tmp` trees/targets.

## structural performance proof

Untimed observers on both Node and Chrome compare **391 groups per runtime**:170 report,169 matched delivery,20 paging,2 EFER,11 previously delivered fast-transfer kernels,7 source-preserving reuse loops and12 population controls. They preserve full run results, unchanged-context generated module byte/import sets, helper bindings/work, entry arities, RunState offsets/reasons and non-cache work/resource counts. Intentional compilation/cache counts and their dependent metadata/probe/reason-adapter calls are retained separately. Observer inputs are hashed before/after; all16 input sources stayed unchanged.

After finite warm-up, the next101 cycles have **zero actual Rust compile, browser compilation and instantiation calls**, not merely zero reported compilation counters:

| warm packet                     | retired work               | native entries | additional compilations |
| ------------------------------- | -------------------------- | -------------- | ----------------------- |
| SYSCALL/SYSRET64                | 404 instructions           | 203            | 0                       |
| SYSRET32                        | 707 instructions           | 203            | 0                       |
| SYSENTER/SYSEXIT32              | 404 instructions           | 203            | 0                       |
| SYSENTER/SYSEXIT64              | 404 instructions           | 203            | 0                       |
| GS-based stack handover         | 1,212 instructions         | 405            | 0                       |
| budget-one round trip           | 404 instructions /404 runs | 404            | 0                       |
| active debug slot without match | 404 instructions           | 203            | 0                       |

Owners/bytes stabilize, guest work and native boundaries remain, and repeated short resumptions reuse code. The unchanged inherited fast driver's whole-RAM/code/table reset is retained for its separate paired cohort. No zero-compilation claim applies across those source rewrites or CR3 fences. Default first-candidate population controls independently assert one activation per native entry and zero extra compile/probe/publish/context/profile polls, outside the observer's intentionally variable ownership-call projection.

Raw final observers: `build/verification/context-reuse-observer-shipping-{node,chrome}.json`. They are instrumentation, not latency measurements. Population controls preserve exact GPR/FLAGS/RIP/data and resource guards; the separate warm loops also guard complete numeric/debug/context/bank/RAM state. Core linear-memory bytes are allocator-reserved Wasm memory, not total browser/native-module RSS or an exact per-component allocation count.

## performance investigation and measurement protocol

The preliminary clean `e299dc5` study retained all42 fixed Node/Chrome files: forward, reversed order and current-build A/A over the inherited and new cohorts. It exposed repeatable Node PUSHF/POPF16 costs of roughly8–12ns per defined instruction despite large synthetic round-trip gains. Those rows were investigated rather than averaged into the overall median.

Two single-variable isolated counterfactuals used the same four predeclared rows, both runtimes, report/matched modes, both orders and15 samples. Removing only the extra owner-map liveness lookup did not consistently explain/recover that cost and was rejected. B instead cached a positive full-context admission proof until actual context publication; Node PUSHF/POPF16 paired improvements replicated at5.6–8.1ns/instruction. PUSHF/POPF64 remained order-sensitive. All960 timing snapshots per counterfactual preserved state/context/numeric/resource/unit observations. Each unmodified rebuild matched e299 exactly; B additionally passed799 native and123 public scenarios. These bounded counterfactuals do not establish universal zero overhead.

Preserved investigations: `build/verification/context-reuse-owner-alive-counterfactual-e299/` and `context-reuse-proof-b-counterfactual-e299/`; preliminary study/analysis `context-reuse-study-e299-final.json` and `context-reuse-analysis-e299-final.json`. The final shipping study repeats the original fixed inventory instead of substituting or expanding favorable rows.

Timing separates cold translation/browser compile/instantiation, first completion, warm execution, short resumes, context switches and global-cap populations. Seven paired replicates are run in alternating orders, reversed controls and current A/A. Source-preserving reuse replicates contain two consecutive measured batches on the same primed CPU, labeled early/later warm batches; independent replicates are not cache-aging observations. `elapsedMs` sums actual awaited `Cpu.run`; `batchWallMs` includes rearming/assertion/aggregation and population miss-context selection. Actual definitions/row caps supply denominators: a requested100001 does not turn capped10001-iteration rows into100001-work measurements. Raw zero/sub-tick samples and undefined ratios remain recorded.

## final timing results and limits

The shipping study completed all33 serial jobs and42 fixed comparison files, with forward/reversed/current-A/A controls on both runtimes. Analysis contains782 per-runtime/workload rows, each retaining its three orders. Medians below are ratios of per-row warm/rearmed elapsed medians; group medians are diagnostics rather than application-throughput claims.

| inherited cohort            | Node forward / reversed | Chrome forward / reversed |
| --------------------------- | ----------------------- | ------------------------- |
| 170 report groups           | 1.00078 /1.00088        | 1.00000 /1.00000          |
| 169 matched-delivery groups | 1.00189 /0.99640        | 1.00000 /1.00000          |
| 20 paging kernels           | 1.00171 /1.01283        | 0.99719 /1.00000          |

Source-preserving warm loops give the following **microseconds per complete round trip**, after finite priming. Both early/later batches remain represented; these are synthetic101-cycle guests, not OS/application results.

| warm packet       | Node baseline → shipping | Chrome baseline → shipping |
| ----------------- | ------------------------ | -------------------------- |
| SYSCALL/SYSRET64  | 185.77 →4.82             | 95.54 →3.96                |
| GS stack handover | 334.19 →15.43            | 214.85 →14.85              |

Reversed ratios are0.0272/0.0402 for simple Node/Chrome and0.0457/0.0686 for GS. The separately rearmed inherited fast kernels still rewrite all source RAM: simple forward costs178.67→16.86µs on Node and101.98→6.93µs on Chrome; reversed Node cold/rearmed cost is more variable. Compilation/cache and elapsed improvements do not imply fewer native boundaries, hardware cycles, p99 or whole-application speedups.

The original repeatable Node PUSHF/POPF16 penalty is reduced, with remaining shipping paired differences6.60/1.27ns per defined instruction in report mode and3.20/0.75ns in matched mode (forward/reversed). Corresponding current A/A90th absolute paired differences are7.32/6.94ns. PUSHF/POPF64, software-event and EFER controls remain order/noise-sensitive. This is not a universal zero-overhead verdict.

Remaining costs and uncertainty are retained explicitly:

- **Paging software entry/IRET:** Node median differences are+0.241/+0.270µs per cycle; paired medians+0.113/+0.213µs versus A/A90th absolute paired difference0.169µs. Exact work, module/helper and entry observations remain invariant. This residual is not claimed solved.
- **Source churn:** executable-frame aliasing still recompiles1001 units on each side; Node paired differences are approximately+3.16/+4.14µs per automatic-entry attempt, with an A/A absolute paired envelope7.30µs. No retained-source benefit is claimed when the guest writes its own executable sources.
- **CR3 control:** both builds perform405 compilations/405 native entries/404 dispatches per101 round trips. Node paired differences+25.4/+19.5µs per cycle coexist with A/A90th absolute paired difference43.5µs; Chrome+8.91/+10.89µs versus15.84µs. Destructive-root reuse remains out of scope, and cold registration/publication is not free.
- **Private IDT/debug:** the predecessor's historical Chrome+1.10µs matched residual remains historical evidence. Against this spec's newer baseline, shipping matched Chrome paired differences+0.349/+0.050µs are below the measured A/A0.699µs envelope. This does not retroactively resolve that earlier result.
- **EFER:** the Node unchanged-WRMSR cycle's forward/reversed paired differences are+12.94/−14.31ns, while raw median differences are+150.47/−11.99ns and A/A contains a large tail. The cycle includes three defined instructions. No stable latency regression or improvement is established by that cohort.

Same-PC population lookup deliberately remains bounded linear scanning. At128 retained contexts, a successful last-candidate one-instruction run makes128 activation attempts and255 validity queries; first-candidate use makes1 activation and128 finish-prune validity queries. Rejected candidates do not touch recency or report hits. The resulting short-run costs are material and are not concealed by the fast-loop group median:

| population control            | Node baseline → shipping µs/run | Chrome baseline → shipping µs/run |
| ----------------------------- | ------------------------------- | --------------------------------- |
| 1 context, first candidate    | 3.42 →3.93                      | 3.96 →2.97                        |
| 128 contexts, first candidate | 1.51 →4.92                      | 1.98 →4.95                        |
| 128 contexts, last candidate  | 1.44 →29.20                     | 1.98 →42.57                       |
| 128 contexts, genuine miss    | 70.03 →98.67                    | 43.56 →85.15                      |

The baseline cannot retain that context population and ends priming with one owner; the shipping build retains128. These controls characterize the new capacity/search tradeoff, not equal-cache-size throughput. Across reversed orders the shipping last-candidate costs remain roughly27.6µs Node/41.6µs Chrome. No constant-time lookup claim is made. Cap eviction, source invalidation and pruning work are included; larger context populations require a deliberate index/performance decision if a real workload makes this cost important.

Ownership overhead is separate from generated code: the population fixture retains1→128 assumption/source owners and1→128 one-entry aliases; one extra pending owner can exist during bounded installation. Its generated cache grows653→83,584 bytes. The observed reserved Core linear memory grows1,179,648→1,376,256 bytes on both runtimes, including allocator/source bookkeeping. The source backing remains watched while dormant; code writes and every eviction/release were independently checked. These counts are bounded by retained/in-flight ownership and are not a claim that `maxCachedBytes` caps total Rust, JavaScript or native compiled-module memory.

Chrome's short runs remain quantized. Forward/reversed/A/A studies retain71/76/59 zero elapsed samples and2/3/3 undefined warm-median ratios across the fixed files. No such sample is dropped to manufacture a ratio; small absolute differences, especially population and empty-loop controls, cannot support nanosecond precision from that clock.

## durable local evidence and reproduction

Final study inventory, exact arguments/logs, raw clocks/counters and normalized rows are `build/verification/context-reuse-study-proof-final.json` and `context-reuse-analysis-proof-final.json`. The preserved run/analysis scripts are `context-reuse-run-shipping.mjs` and `context-reuse-analyze.mjs`; the study records the driver hash. All42 filenames are derivable from that inventory. Preliminary e299 and both counterfactuals remain separate with their original hashes and results.

The committed harnesses are [paging performance](../../scripts/paging-performance.mjs), [paired inherited/reuse controls](../../scripts/fast-system-paging.mjs), [literal reuse/population kernels](../../scripts/context-reuse-kernels.mjs), [untimed observer](../../scripts/fast-system-observer.mjs) and [baseline guard](../../scripts/context-reuse-support.mjs). For example, with the recorded snapshots present:

```sh
node scripts/paging-performance.mjs --snapshot build/verification/context-reuse-performance-build-0dec62a --baseline /tmp/ring64-context-baseline-c956 --tag context-reuse-repeat --iterations 100001 --samples 7
node scripts/fast-system-paging.mjs --context-reuse --reuse-controls --snapshot build/verification/context-reuse-performance-build-0dec62a --baseline /tmp/ring64-context-baseline-c956 --iterations 101 --samples 7 --output build/verification/context-reuse-repeat-warm-node.json
node scripts/fast-system-observer.mjs --context-reuse --include-fast --snapshot build/verification/context-reuse-performance-build-0dec62a --iterations 101 --output build/verification/context-reuse-repeat-observer-node.json
```

Apply `--browser`, `--reverse` and `--aa` as recorded by the study; `--msr-controls`, `--fast-controls` and `--population-controls` select the other fixed cohorts. Mutation reproduction uses the committed driver in an isolated `/tmp` copy with `--expected-wasm bc0f715fff9bcceac715359804103041deb1fd4038197f3d547fb708fada7be4`. Recorded evidence establishes the tested imported profiles and bounded engine behavior; boot, broader ISA coverage, host-matrix guarantees and application throughput remain unclaimed.
