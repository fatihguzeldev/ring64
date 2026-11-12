# processor identity and virtual time verification

The selected [specification](spec.md) is implemented: private CPUID disclosure, RDTSC/RDTSCP, deterministic per-CPU retirement time, selected TSC/AUX MSRs, live CR4.TSD and explicit host checkpoint/reset ownership. This completes the selected increment. It does not establish a complete processor family, hardware-cycle timing, application compatibility or exhaustive x86 conformance.

## implementation and ownership

[`src/x86/processor.rs`](../../src/x86/processor.rs) owns literal identity, timestamp privilege admission and modulo-u64 sample/rebase semantics. The embedding routes processor reads and selected MSRs through that authority. The decoder preserves required-byte fetch, prefix and Unsupported frontiers; generated helpers consume current register locals, rather than captured compile-time values.

One appended time bank occupies offset 768, size 16 bytes in the 784-byte RunState. The scalar prefix remains 176 bytes; all preceding numeric offsets and the five-argument generated run ABI remain unchanged. The immutable original allowance B and live remaining allowance R give processor and paging-control helpers the retired prefix B−R. A single common publication epilogue settles that prefix once on every normal/resumable native exit. Fatal unwind follows the existing failed-CPU policy. WRMSR(TSC) rebases the same invocation bank so that its own retirement lands exactly on the supplied value. There is no per-instruction tick helper and no settlement in clear-fault, inspection or compilation paths.

[`host/time.ts`](../../host/time.ts) owns field capture and transport validation; Cpu's existing idle/generation boundary protects publication after potentially reentrant accessors. `readTimeState()` returns detached `{tsc: bigint, tscAux: number}` data. `setState()` does not implicitly restore time. A full checkpoint restores the explicit time bank; physical reset clears both fields and preserves identity. TSD is owned only by PagingState and read live without making time/AUX/TSD part of translation identity. A TSD-only write leaves numeric eligibility, cached PAE PDPTEs and published artifacts intact.

## source and artifacts

The tested implementation/test/driver source is `2f94b0dd881fd4a34b666d64fb98e476effedf86`. Later evidence commits add documentation, recorded evidence and a scoped formatting exclusion for the byte-identical raw archive. [Artifact evidence](verification/artifacts.json) records exact manifests, check-log hashes, source inventory and unchanged-file proof.

| artifact    | production source                          | Core SHA256                                                        | bytes     |
| ----------- | ------------------------------------------ | ------------------------------------------------------------------ | --------- |
| predecessor | `e785914aa60d7bc48359561107508bef7e82c3c2` | `8ad967df3b2f9af4c901c82c42fcad90300a9c7e90cc863ac0e31235af80b1d2` | 1,240,374 |
| final       | `2f94b0dd881fd4a34b666d64fb98e476effedf86` | `a2ac7c44ed8b459b7ac826b44a5d562e2c210234035c73b83c2c9276e99ac260` | 1,246,882 |

Core growth is 6,508 bytes. Production-host hashes are respectively `2f2ccdfa6177c2cd42afb4c811f8e019216e4ebfbaf719668b8ff506dbcf4a84` and `688881a73bd9e66827b56e7041ba3c35815e9ec7e0706fd729a1c2a75961697a`. The predecessor is an exact read/copy freeze of the existing completed predecessor artifact, not a claimed rebuild at the observed spec-only HEAD `e714be2`. Oracle receipts identify source `081dc92`; its Core and complete-host bytes are identical to the final `2f94b0d` artifacts. The intervening change clarified characterization-validation wording.

All 773 tracked/nonignored source files matched before and after the complete timing window, with tree-content SHA256 `92f3e90c0bc743ff0b82e6b339f59f4a28ec6ef9fd04b0fdb504964f1bd9c2ae`. The mutation runner separately restored and checked its complete source inventory. README and dependency manifests/locks are unchanged. Full raw JSON/logs and frozen build trees remain local and ignored; committed indexes retain their paths and SHA256, while CSVs retain raw timing observations. A local path in a receipt is provenance, not a promise that the file is available in a fresh clone.

## checks and falsification

`npm run check` passed formatting, lint, native/Wasm Clippy, **914 native tests, 250 Node tests and 1,015 Chrome scenarios**. The Node count includes one test running the same shared 1,015-scenario registry; these are not disjoint totals. Node was 22.16.0 and Chrome 157.0.8103.79 on Apple M4 Pro / darwin-arm64.

The [independent oracle](../../tests/execution/identity-time/oracle.ts) passed **4,428 cases in each public runtime**: identity 1,145; BigInt ledger 1,843; raw outputs 244; TSD 60; MSRs 1,100; accounting 9; debug 4; lifetime 23. It imports no production decoder or time-arithmetic helper. Literal CPUID words, complete register/FLAGS checks and a separate retired-work ledger check both sampled values and final time. Fixed-seed programs, short-program partition compositions, dirty output halves, modulo carries, huge original budgets and 1,024 write/resume partitions exercise real generated Wasm. The dedicated audit driver selects these eight oracle groups; it does not also run the supplemental boundary file.

The shared suite adds those eight groups plus **13 supplemental boundary scenarios**. Their packets include:

- All five inherited execution modes, both default code widths, real/protected/v8086/compatibility/long64 output rules, and unchanged LFENCE/numeric admission despite unclaimed private-family bits.
- Warm CPL3 TSD0→1→0 reads of both timestamp forms without recompilation; literal fault priority against LOCK/repeat, truncated F9, execute breakpoints/RF, disabled numeric state and pending x87. Selected MSR privilege and reserved AUX-high32 refusals preserve earlier retired prefixes.
- Full/partial/zero-count REP and string I/O, mid-unit clear-fault, pre-begin PagingRestart, post-begin aliases, completed far/gate/syscall/IRET work followed by refusal, and checkpoint replay. Eighteen inherited complex scenario bodies also gained independently authored literal time assertions.
- TF output-before-trap, execute-breakpoint-before-read, nonmatching active comparators, SS deferral, IRQ/NMI/HLT, blocked NMI, delivery allowance and escalation. Delivery work alone adds no ticks; actual handler instructions do.
- Same-CPU identity across physical reset, detached readback, two CPUs, reentrant setter run/reset/dispose, context ABA, epoch 0/MAX−1/MAX, eviction/backing reincarnation and host pauses. The pause packets use 16ms waits to check the clock policy; they are not latency measurements.

Native owner tests additionally prove that TSD-only writes do not reload even an unmapped PDPT; a true CR3 reload is the negative control. The native execution harness compares the bank against authored budgets/remaining allowances rather than adopting production RunResult.retired as its oracle. The [conformance audit](verification/raw/conformance-audit.json) maps selected acceptance packets to source assertions and receipts; finite tests and source review do not prove all possible guest histories.

The exact predecessor returned Unsupported with zero retirement for the three direct forms; [source-frontier RED](verification/raw/source-frontier-red.json) records that boundary. Initial integration failures exposed four stale synthetic Core layout builders. Their fixtures now supply the required time descriptor/helper while retaining malformed extent, cleanup, exact-end and unsigned-pointer checks. Production validation was not weakened.

All **25 deliberate semantic mutants** built/setup successfully, then failed named unchanged assertions. [Definitions](verification/mutation-campaign.json) and [actual diagnostics](verification/raw/mutations.json) preserve patches, argv, source hashes and first failures. No build failure, trap, timeout, engine crash or missing test counted as a kill. The declaration routes 22 rows through emitted/public workflows, but that is not a count of defects caught by guest opcode outputs. Scalar import, reset, completed-run capture and translation-owner retirement can fail at host/native owner assertions after emitted prefix or warmup work. The remaining declared domains are public host-bank, public decode-frontier and native PAE bridge. A lifecycle assertion after emitted work is not itself proof that the wrong value was caught by a later guest read. The frozen-TSD0 mutant approximates a stale warmed-zero assumption; it does not implement a real per-owner permission cache.

Independent reviews covered portable arithmetic and privilege priority, decoder/DBT publication, host capture lifetimes, translation/PDPTE ownership, actual assertion coverage, mutation diagnostics and measurement claims. No known functional acceptance blocker remained after the final full check and receipt reviews.

## performance protocol

All guest/timing jobs were serialized with no overlapping builds, mutations or other guest benchmarks. Ordinary host activity was not eliminated. Each side owns its frozen factory/Core/CPU/backing. [Performance index](verification/performance.json), original plans and execution ledgers identify every artifact and workload. This is bounded synthetic evidence on one host, with no p99, hardware-cycle, application-throughput or population-confidence claim.

The initial plan produced **52 paired reports / 12,714 sample pairs**, plus two new-behavior characterization reports / 264 side rows. The later five-row screen investigation adds 12 reports / 1,020 pairs. Seven causal diagnostic reports and one fresh-instance calibration bring the complete timing-report inventory to 74. The diagnostic and calibration estimates remain separate from the original baseline/current cohorts.

[Raw timing pairs](verification/timing-pairs.csv), [row summaries](verification/timing-summary.csv) and the separate followup CSVs preserve first/early/later values, zeros and undefined ratios. Ratio direction is current/baseline by explicit labels; A/A is the fixed second-label/first-label ratio, independent of execution or creation order. The prose below uses the median of paired elapsed ratios. Side-median ratios are separately labeled in the CSV. No denominator floor, favorable rerun substitution or dropped zero is used. Initial projections contain 19,606 metric observations, including 965 zero denominators/undefined ratios and 997 zero numerators; these are metric-row counts, not distinct pair counts.

Every recorded paired semantic/work/context/numeric/resource/unit projection matched in the initial 12,714 pairs and the additional 1,020 followup pairs. Timing fields, private owner identities, current-only time checks and explicitly recorded generated/cache byte differences are excluded from that comparison. Internal literal guards additionally cover payloads that the raw reports do not serialize. Every inherited individual unit grew 18 bytes; A/A units are unchanged. Multi-unit generated/cache totals can grow by several such epilogues. The [byte-growth evidence](verification/byte-growth.json) preserves those differences instead of demanding predecessor byte equality.

The inherited screen used N=1,001 / samples 9: 170 report rows and 169 eligible matched-delivery rows per runtime. TF stepping remains unavailable in matched mode because it selects events. Fourteen fixed controls used N=100,001 / samples 15, and a predeclared three-row deep cohort used N=1,000,001 / samples 17, both primary/reversed/A/A and report/matched in Node/Chrome. The five-row followup used N=100,001 / samples 17. These requested N values are not uniform actual work: generic short resumes cap at 3,000, gate hit/alias/repair/resume at 257, alignment repair at 10,001, REP repair at 501 and double-fault delivery at 1,001. A zero-retirement delivery row has no per-retired-instruction denominator. Definitions retain actual retirements, elements, calls and attempts.

### recovered x87/MMX and IA32e controls

The recovered loops used N=1,000,001 / samples 17 with 13 later pairs; the five IA32e controls used N=100,001 / samples 18 with 17 warm pairs. Each IA32e sample retires 300,003 instructions. Primary/reversed paired-median ranges are:

| workload          | Node current/baseline | Chrome current/baseline |
| ----------------- | --------------------- | ----------------------- |
| x87 stack churn   | 1.0089–1.0255         | 0.9963–0.9972           |
| mixed MMX/x87     | 0.9987–1.0026         | 0.9978–0.9978           |
| IA32e fetch       | 0.9939–1.0030         | 0.9888–1.0093           |
| IA32e load        | 0.9877–1.0010         | 1.0041–1.0138           |
| IA32e store       | 0.9930–1.0049         | 1.0000–1.0098           |
| IA32e RMW         | 0.9963–1.0013         | 0.9926–1.0050           |
| IA32e system read | 1.0010–1.0087         | 1.0056–1.0101           |

The initial Node x87 shift was +0.20 / +0.56ns per retired instruction, with 11/13 and 13/13 later pairs slower; A/A was 1.0015. Each sample performs 6,000,006 instructions in one native entry. Attributing those milliseconds to a single added bank load/store would exceed the evidence, so the result triggered a causal investigation.

The investigation kept the final Core/host constant and changed only validated generated function-body bytes: omit the 18-byte epilogue, move it after state publication, or use a diagnostic future-biased bank that stops keeping original B live through the loop. Omission intentionally violates the clock contract. The future-biased version was checked only for the two non-timestamp loops and is not a proposed shipping implementation. Optional predecessor captures prove that the omitted x87/MMX modules are byte-identical to their historical generated modules, while the current helper Core remains different.

None demonstrated a repeatable x87 improvement. Variant/as-is medians were 1.0106/1.0109 for omission, 1.0027/1.0069 for relocation and 1.0049/1.0079 for future bias; byte-identical A/A itself was 1.0160. Reversing sample order does not swap the variant's instance/creation role. Fresh compile-only TurboFan disassembly also found **no recurring original-B stack spill in the hot loop**. Frame sizes and register shuffles differ; static shape is not a dynamic timing or cache-miss diagnosis. Exact harnesses, module/assembly hashes and diagnostic samples are retained with their narrower claim ceilings.

One final predeclared calibration used eight distinct fresh CPU pairs per cohort/workload, balanced AB/BA creation order and separately balanced cohort order. It reused compiled Core modules in one Node process; these are not eight independent engines/processes. Each pair contributes the median of five later ratios, then the eight pair medians are summarized. All 64 placements and 576 raw side samples passed the retained semantic/resource guards. x87's baseline/current median was **1.00102**, versus **1.00236 A/A**; pair estimates ranged 0.96855–1.02665. Creation-order groups were 1.00160 and 0.99934. MMX was 0.99376 versus 0.99917 A/A. This challenges a stable artifact-linked regression; it proves neither a speedup nor an exact placement mechanism. Linear-memory offsets do not reveal native backing addresses or hardware cache misses.

The original +0.9–2.6% x87 observations remain in the evidence, unattributed. They did not persist across the final balanced fresh-instance calibration. Together with the unsuccessful code counterfactuals, they do not establish the unexplained repeatable artifact regression that would block the selected increment. No post-hoc percentage threshold is used, and no speculative performance refactor was adopted.

### retained costs and limits

Small entry-heavy costs remain measurable. Chrome's GS-stack syscall control was 1.0159/1.0219, versus 0.9985 A/A: about +1.1/+1.5ms for 10,001 round trips and 40,004/40,005 native entries. Chrome's PAE32 count 1 gate control was 1.0234/1.0349, versus 1.0057 A/A: about +0.4/+0.6ms per sample. The common settlement adds real work per native entry; these whole-artifact measurements do not isolate all of that delta to the epilogue. They are retained costs, not a zero-overhead verdict. IA32e system-read and some load observations likewise retain small positive shifts in the table.

The five-row investigation did not preserve the screen's large losses consistently across modes/orders. It retains smaller observations, including Chrome far-JMP 1.0233/1.0250 versus 0.9767 A/A, and matched double-fault delivery 1.0769/1.0357 versus 1.0323 A/A. The latter has zero guest retirement and remains an attempt-level observation. Short-resume elapsed sums and wall/batch time are distinct metrics; conclusions are not exchanged between them.

New CPUID/timestamp/MSR/TSD behavior has no executable predecessor denominator. The 22-row characterization records ordinary-no-clock, batched/sparse/IA32e/short-resume reads, writes and privilege refusal, with literal output and TimeState checks outside timers. Initial bank setup and verification are excluded from elapsed/wall samples. Chrome zero/sub-tick observations remain zero. Preliminary validation runs establish fixture/guard correctness, not latency. Gate samples also check candidate cumulative TimeState; the older context driver has no equivalent per-sample clock check or dedicated measurement-source guard, so its evidence relies on its existing output/resource guards and the independently matched full source inventory.

Performance acceptance is bounded to this completed investigation. It does not erase retained entry costs or historical shifts, establish universal noise bounds from one A/A result, or promise behavior on other engines, hosts or applications.
