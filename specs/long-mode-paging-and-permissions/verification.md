# verification

The imported IA32e profile closes guest root/PTE changes, checked code/data/system access, #PF/CR2 detection, guest handler repair and IRET retry. The default linear model keeps its existing access and decode frontiers. This evidence covers the bounded profile in [the spec](spec.md), not OS boot or complete x86 conformance.

## final runtime

- Runtime correction: `71b52df`; complete literal suite: `9cca5f8`.
- Core Wasm: `b003b2071da14209e36f80346346186a9b9a3107fc9a93ece0fcef98749483af`, 1106336 bytes.
- Performance baseline: `c1380a4`, shipping Wasm `9b28838e4ce5d5c9f37f04d647284c98b5d5711bcffda4081a8f63772b00c5be`, 876391 bytes. Candidate and baseline builds are frozen separately; no shared Cargo target is used across checkouts.
- Production host JavaScript grows from 95214 to 110152 bytes; core growth is 229945 bytes. Generated-code equality does not imply unchanged compiler/runtime download size.

`npm run check` passed: formatter/linter, native and Wasm Clippy, **764 Rust tests, 200 Node tests and 754 shared Chrome scenarios**. The shared suite includes 47 paging scenarios with independent literal page words, error codes, guarded payloads and full state projections.

The public packets cover all page sizes/high physical addresses, hierarchical permissions and lower-fault priority, private physical refusals, sparse numeric images, masked writes, RMW, REP, privilege-stack entry, frozen fault sources, escalation, handler repair, native/cached entries, async installs and finite A-alias restart chains. Native physical-capability tests also assert that D/payload publication performs no new permission probes.

## falsification

Correctness and boundary reviews used separate agents and public generated-Wasm counterexamples. Findings fixed during implementation/review:

- Compatibility MOV CR reads needed explicit narrowing before merging the inherited GPR upper bank.
- A restart needed to prune its invalidated artifact before another cached entry could be selected.
- Paged Long64 memory failures needed to retain the effective SS segment; native code admission needed to reset stale operand provenance to CS.
- A first-byte A alias could redirect an already-read hierarchy before an obsolete lower P0 entry was reached. Required-fetch walks now revalidate their used entry words immediately after A publication.
- Prepared physical capabilities removed repeated private admission from D/payload commit while retaining current-word OR and alias invalidation.
- Context/mapping capture retains the predecessor's completed getter-run ordering; strict run-generation capture applies to the new bank setter.

The final isolated mutation run killed **20/20 mutants through semantic assertions**. Build failures, engine errors and timeouts were not counted. All 47 paging scenarios passed before and after restoration; the restored source matched the parent, and the rebuilt restored Wasm matched the final hash above.

Mutants cover early D publication, frame retranslation, source/target privilege confusion, frozen CR2 reconstruction, secondary CR2/escalation, SS history, physical versus architectural faults, write-intent bits, sparse D effects, SS provenance, physical canonicality, early/ignored hierarchical permissions, large-page PAT, speculative A effects, missing PTE dependencies, alias notification and native REP replay.

## performance evidence

Both Node and Chrome prove exact inherited generated-module bytes, imports, bindings, helper/host-call counts and run resources for **170 report plus 169 matched-delivery workload groups**. Each runtime observes 4285 modules per side, including ordinary and debug-observed artifacts. All previous state offsets, reason-code prefixes and the five-argument generated invocation remain; the frozen PF source adds 16 bytes at offset712, making RunState728 bytes. The bank remains a separate projection.

A bounded reversed cohort and same-build controls established a descriptor publication regression. Restoring one-shot accessed-byte writes and narrow descriptor-byte publication removed about 10.6ns per three-instruction FS reload iteration and 7–8ns per four-instruction LTR iteration on Node; the paired Chrome FS improvement was 8–10ns. These units are complete synthetic helper iterations, not isolated hardware operations.

The final four full matrices contain 9492 paired-side samples. Median later-sample current/baseline ratios across workload rows are Node1.00251/1.00513 and Chrome1.000/1.000 for report/matched delivery respectively. The row-ratio p10–p90 ranges are Node0.9768–1.0413/0.9607–1.0613 and Chrome0.9167–1.0588/0.9267–1.0870; these describe different workloads, not confidence intervals. Three zero-baseline Chrome rows in each profile remain in the raw results with undefined ratios.

The descriptor improvement removes the large repeated cost, not every measured delta: final Node FS deltas are −0.27/−2.08ns per three-instruction iteration, and LTR is +0.21/+3.76ns per four-instruction iteration. Short host/resume rows require their own controls; byte/resource equality does not establish identical core-helper or snapshot latency.

A final fixed three-row reversed/current-build A/A check revisited large single-cohort host/resume observations. The pending-resume +2.54µs/run and IRQ-private-repair +1.15µs/run observations did not repeat; the reversed Node pending row retained −18/+125ns/run in report/matched modes. SS software transitions also varied across signs and clock-floor controls. All raw observations remain in the evidence. These controls do not demonstrate a stable large default-path regression after the descriptor fix, or establish zero overhead.

Twenty current-only paging kernels characterize warm page tables, cold starts, fragmented accesses, root reload/switch, INVLPG, bounded resumes, faults, physical repair and guest handler repair. Warm tables still perform walks; they are not a retained instruction/data TLB. The separate leaf-store pair excludes host reset and measured compilation, but its overlapping samples and Chrome clock floor do not establish precise A/D-update latency.

Raw local evidence is retained under `build/verification`: `paging-check-shipping.log`, `paging-mutations-final.json`, `paging-source-proof.json`, the final observer files, frozen performance matrices and characterization files. The `scripts/paging-*.mjs` tools reproduce those checks with explicit build manifests and work denominators. These synthetic cohorts do not establish p99, hardware-cycle or application-throughput claims.
