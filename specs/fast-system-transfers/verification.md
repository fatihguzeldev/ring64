# fast system transfers verification

## source and executable identity

The implementation closes the [selected spec](spec.md) in the imported `ia32e-paged` profile. It adds all four fast transfers, SWAPGS, guest-consumed MSRs and the separate seven-word bank. EFER remains paging-owned; FS/GS bases remain loaded-context state. The default linear profile retains its previous unsupported frontiers.

Runtime source is complete through `97d68ba`; the clean delivery/evidence source snapshot is `39a63a215d95caee8810ebf9499bded9eb92fffc`. Their runtime inputs are identical. Final benchmark artifacts were frozen before the documentation commit, rather than reading a mutable build directory during measurement.

| item                      | baseline                                                           | final                                                              |
| ------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| source                    | `8a7ee067bb9d036b4d19434458706490506ce44a`                         | `39a63a215d95caee8810ebf9499bded9eb92fffc`                         |
| core Wasm SHA256          | `b003b2071da14209e36f80346346186a9b9a3107fc9a93ece0fcef98749483af` | `af835f3d514ee7abc6fa63db6545c6c1af6a87bd3e158151e996d70bb808d017` |
| core Wasm bytes           | 1,106,336                                                          | 1,122,118 (+15,782; 1.43%)                                         |
| production host JS bytes  | 110,152                                                            | 113,829 (+3,677; 3.34%)                                            |
| RunState bytes            | 728                                                                | 728                                                                |
| generated entry arguments | 5                                                                  | 5                                                                  |

Final production-host SHA256 is `c2efa3517c804f2b0e95ded18b874173d1d760ec841124e28678d24963c05f05`; aggregate host SHA256, including compiled host tests, is `2b17994870e5412ebfd5f925effd146d0427d7253fdf936778fe868bd5758259`. The bank has 56 logical bytes in private Core state; it does not extend scalar/run snapshots or add a per-instruction projection. Private Core layout may change even though RunState does not.

Baseline artifacts are preserved at `/tmp/ring64-fast-baseline-8a7ee06`; final artifacts are in `build/verification/fast-system-performance-build-final-39a63a2`. The baseline check rejects an incorrect source/core/host identity, including the older paging harness's `c1380a4` default.

## checks and independent review

The complete `npm run check` passed after the runtime corrections: 787 Rust tests, 214 Node tests and 787 Chrome common scenarios. Two final test-only delivery scenarios then passed format, typecheck, lint, TypeScript compilation, all 214 Node tests and 789 Chrome common scenarios. No Rust or production host change followed the full gate. The final common suite contains 35 fast-system scenarios, with additional table-driven mode/value/fault combinations inside them. Node version was22.16.0 and Chrome was157.0.8103.39.

Three review axes examined correctness, boundaries and performance. A fourth independent delivery/ownership audit checked the completed feature and evidence drivers. Review found one production diagnostic defect: CPL-based #GPs were reported with phase `target`. A literal CPL3 SYSRET packet failed against the frozen pre-fix Wasm (`42e39475a80d37152ec88ffa6baf0f3bd4b62af8d7a69717b9fe683d0aa82b91`), then passed against the final Wasm. The x86 owner now returns distinct Undefined/Privilege/Target/Unsupported outcomes; embedding maps their provenance without redoing admission checks. MSR failures retain their existing control-owner contract.

The constructor was also simplified to parse fast-system state from the existing mapped-image metadata capture. No measured speedup is attributed to that cleanup.

| acceptance packet           | concrete proof                                                                                                                                                                                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1: bank/lifecycle           | [capture tests](../../host/fast-system.test.ts), [public API tests](../../host/fast-system-api.test.ts), [real-core tests](../../host/fast-system-core.test.ts): omission, complete capture, hostile getters, nested runs/disposal, detached snapshots, wrong-model rejection and independent pending sources                   |
| 2: MSR views                | [owner tests](../../src/x86/fast_system/tests.rs), [guest faults/views](../../tests/execution/fast-system/faults.ts): ten selected indices, both submodes, ignored high GPR bits, CPL priority, reserved fields and canonical boundaries                                                                                        |
| 3: SYSCALL64 loop           | [guest transfers](../../tests/execution/fast-system/transfers.ts): nine guest WRMSRs plus IRET establish user state; SWAPGS/GS selects a real kernel stack with PUSH/POP, guarded work and a complete SYSRET64 return                                                                                                           |
| 4: SYSENTER pairs           | guest transfers cover Long64, compatibility16/32 and both return widths with SCE0; [review correctness](../../tests/execution/fast-system/review-correctness.ts) also executes CPL1/2 entry                                                                                                                                     |
| 5: return widths            | owner, guest and review packets cover full versus truncated pointers, unchanged SYSRET RSP, exact flag masks, ignored prefixes, REX cancellation and live newly written return operands                                                                                                                                         |
| 6: synthetic caches         | poisoned table/stack packets compare every CS/SS field, null/TI/wrap/raw-STAR-SS outcomes and preserved inappropriate data caches; review correctness consumes the synthetic compatibility SS through PUSH                                                                                                                      |
| 7: FS/GS authority          | native WRMSR→FS load and SWAPGS→GS store, compatibility high-base readback, descriptor/null FS/GS reload and later SWAPGS prove one loaded-base authority                                                                                                                                                                       |
| 8: own fault/repair         | actual guest #UD handler programs SCE and IRET retries SYSCALL; guest #GP handler repairs RCX and retries SYSRET; public diagnostic tests distinguish privilege from target faults                                                                                                                                              |
| 9: committed target failure | guest faults distinguish architectural #PF from final private-X refusal and resume without replay; [delivery review](../../tests/execution/fast-system/review-delivery.ts) checks all four return forms with actual TSS RSP0/IST #PF frames, and source-CPL SYSRET #GP via IST while RSP already points at user storage         |
| 10: debug/events            | [boundary packets](../../tests/execution/fast-system/boundaries.ts) check resulting-TF rules, RF capture, SS-deferred history, execute breakpoints and IRQ/NMI before post-budget gates; [boundary review](../../tests/execution/fast-system/review-boundaries.ts) checks actual CPL3 #DB frames and split-fetch refusal/repair |
| 11: currentness/resume      | [currentness packets](../../tests/execution/fast-system/currentness.ts) check retained middle entries, guest SCE writes, captured-core pending-compile base/bank changes and guest CR3 changes before returning to user data; repeated handler compilation refusal cannot replay a completed entry                              |
| 12: inherited consumers     | the full inherited suite, raw numeric guards and a dirty-XMM-before-SYSCALL path remain green; byte/import/helper/resource/layout observation and unchanged-source proof are separate evidence below                                                                                                                            |

These tests use public Cpu and actual generated Wasm in Node and Chrome, plus Rust owner tests. Their literal expected frames, selectors, words and flag masks are not produced by the implementation's transfer/cache builder. They establish the selected finite profile, not every combination of x86 state or every processor's implementation-defined behavior.

## mutation sensitivity and restoration

There are 23 accepted semantic counterfactuals. They cover compatibility SYSCALL, SCE omission and accidental SYSENTER gating, RF/R11 capture, saved next RCX, SYSRET flags/RSP, SYSEXIT operand routing, raw STAR SS, canonicality, forbidden metadata/target probes, synthetic SS inhibition, SYSENTER_CS width/null tests, FS/GS publication, stale native and pending-compile bases, resulting TF, completion ordering, source CPL and replay of a committed entry.

Two isolated batches share the exact final source projection and shipping Wasm hash. The projection hashes `src/**`, `host/**`, `Cargo.toml` and `Cargo.lock`; it excludes `tests/execution/**`, whose separately captured scenario snapshots grew from 33 to 35. Their untouched before/after suites passed 33/33 and 35/35 respectively; every accepted result is a fixture assertion failure. Input hashes, parent projection and restored Wasm match. The second batch's unmutated Wasm is byte-identical to the shipping Wasm.

The initial batch attempted 21 variants and produced 19 semantic kills. An invented GDT-limit check was inactive in its selected poisoned-table fixture; a retirement-accounting variant produced an engine error. Neither was counted. Revised actual GDT probing and committed-entry replay variants produced assertion failures; the follow-up also proved the SCE/SYSENTER and pending-compile cases. Thus 25 experiments yielded 23 accepted kills and 2 explicitly excluded initial experiments. The committed driver contains the 23 effective variants; the excluded raw records are retained rather than relabeled.

Local evidence: `build/verification/fast-system-mutation-summary.json`, the original `fast-system-mutations-final.json` and `fast-system-mutations-followup.json`, logs and per-mutant source edits/build hashes under their recorded `/tmp` evidence directories. Mutation builds use a private Cargo target and never patch the working checkout or its shipping build.

## performance evidence

All measurements below use the clean final39a snapshot and exact shipping Wasm, on Apple M4 Pro, Node22.16.0 and Chrome157.0.8103.39. There was no overlapping build, mutation or other latency experiment. Seven primary samples and 15 control samples retain first/early/later windows; later medians use 3 and 11 samples respectively. Ratios are current/baseline, summarized without workload weighting. The percentile ranges are workload distributions, not confidence intervals.

| cohort                             | finite ratios / groups | median ratio | p10–p90         |
| ---------------------------------- | ---------------------- | ------------ | --------------- |
| inherited report, Node             | 170 / 170              | 1.00165      | 0.97353–1.03667 |
| inherited report, Chrome           | 167 / 170              | 1.00000      | 0.93940–1.05000 |
| inherited matched delivery, Node   | 169 / 169              | 1.00037      | 0.97062–1.02917 |
| inherited matched delivery, Chrome | 166 / 169              | 1.00000      | 0.94118–1.04762 |
| inherited paging pairs, Node       | 20 / 20                | 0.99654      | 0.96116–1.02452 |
| inherited paging pairs, Chrome     | 20 / 20                | 1.00000      | 0.66667–1.02564 |

All inherited stored outputs, work/resource values, module bytes/imports, actual helper bindings/call counts, old state offsets and entry signatures matched in both runtimes. Each observer checked 359 inherited groups, 2 EFER controls and 11 separately counted new-feature helper inventories. The latter require literal helper work, not equality with an old implementation of unsupported instructions.

Seven Chrome rows in each full mode contain zero samples; three ratios per mode are undefined. Both paging leaf rows also contain zero run samples. These raw clock-floor observations are retained, including finite zero ratios. They cannot support precise one-tick leaf-update or private-refusal cost claims.

The fixed 16-row inherited control set ran one reversed comparison and one same-final-build A/A in each mode/runtime, with 15 samples. EFER's two added controls ran normal/reversed/A/A on both runtimes. No new union of rows or additional resampling followed the controls. The results establish no repeatable broad inactive-path slowdown; they do not establish zero overhead. Material retained uncertainty is:

- Unchanged EFER WRMSR's three-instruction Node cycle measured 1305.46→1317.36ns normally and 1271.39→1303.83ns in reversed order: about 12–32ns/cycle, or 0.9–2.6%. Same-build A/A measured 1321.82→1309.26ns. Chrome was 1370→1370ns normally and 1390→1360ns reversed. A small Node-specific cycle cost remains possible; this does not isolate the helper body.
- Report-mode Node `event-db-budget-one-resume` measured 2086.96→2113.26ns/run in the full matrix, 1955.19→2150.21ns reversed, and 2014.72→2040.55ns in A/A. Matched delivery's +7/+8ns contrasts with +23ns in A/A. The larger reversed report spike is preserved rather than averaged away.
- Chrome matched `debug-private-idt-repair` measured 3592.82→4690.62ns/run (+1.10µs, 30.6%). Node matched was 4888.98→4413.47ns; Chrome report was 3792.41→3792.41ns. This final-only row was outside the already frozen controls. Its residual is unresolved; unchanged source/artifact observations do not explain it away.
- Warm1GiB LOAD/LOOP showed about+2.0% Node/+1.6% Chrome in the paired20 cohort, approximately+13/+10ns per two-instruction cycle, without dedicated per-row A/A. Node report REP copy showed+1.18ns/element while matched/Chrome were flat or faster. These observations also prevent a universal no-regression claim.

New-feature kernels have independent literal state/memory/frame/helper guards and no old supported-instruction latency baseline. Representative later elapsed values are:

| kernel                               | retired instructions / defined cycle | Node µs/cycle | Chrome µs/cycle |
| ------------------------------------ | ------------------------------------ | ------------- | --------------- |
| SYSCALL/SYSRET64 loop                | 4                                    | 207.26        | 91.09           |
| GS stack-handover loop               | 12                                   | 367.56        | 222.77          |
| kernel CR3 round trip                | 8                                    | 337.52        | 212.87          |
| guest target-#PF repair              | 7                                    | 292.68        | 183.17          |
| private target repair, two run calls | 2                                    | 159.17        | 102.97          |
| selected RDMSR/DEC/JNZ               | 3                                    | 1.3395        | 1.3999          |

These are complete defined cycles. Their time includes generated translation, browser compilation and instantiation inside Cpu.run; it is not an isolated instruction/helper latency. The driver requests 10001 iterations, capping context-changing rows at 101 cycles while retaining 10001 selected-MSR cycles. Per-cycle host rearming/repair and guards are outside summed run elapsed and separately retained in wall timing. Initial per-sample CPU/RAM/context/bank/scalar/numeric setup and compilation of the reusable core module are outside both timers.

Context changes still retire existing owners: 101 simple round trips perform 203 compilations/native entries and 202 dispatches for 404 retired instructions; GS/CR3 variants perform 405 compilations. Translation and browser compilation dominate this characterization. The selected-MSR loop separately uses one compilation, 10001 cache hits and 10002 native entries. These results establish neither retained transfer-artifact reuse nor application throughput.

The complete results and raw references are `build/verification/fast-system-performance-final-summary.json` and `fast-system-analysis-final-39a63a2.json`: 20 final comparison-cohort files, 2 active-kernel files, 2 observers, source proof and all preliminary files. Preliminary source4765/42e measurements remain distinguishable from the final39a/af835 measurements. The unresolved costs above are retained in the final summary, not silently replaced by earlier favorable samples.

The inventory is deliberately separated: 170 inherited report and 169 matched-delivery groups; 20 previously current-only paging kernels now paired against the baseline; 2 additional old-supported EFER controls; 11 new-feature kernels characterized without an unsupported old-instruction latency baseline. Group counts describe the inventory, not an exhaustive coverage claim.

The final source proof checks 16 unchanged whole files, 4 unchanged sections, 14 unchanged benchmark inputs and 13 explicit owner anchors. In particular Cpu.run/snapshot, inherited helpers, RunState and benchmark inputs are distinguished from the changed Core binary. The compiled-module observer independently checks actual generated bytes/imports, bindings, calls and work/resource results.

Record timing with exact source/hash/runtime, guarded outputs and explicit work denominators. Keep raw zero/sub-tick samples. The fixed reversed/A/A control set is selected once from the full inherited comparison; do not repeatedly enlarge it in response to noise. These synthetic measurements do not establish hardware cycles, p99, application throughput or OS boot.

## repeatable commands

`npm run check` is the complete repository gate. The last test-only extension can also be checked with `npm run format:check`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm test` and `npm run test:browser`. Before a build or measurement, check for an existing matching process and avoid overlapping latency measurement with builds or tests.

The following assumes the recorded source checkout, frozen baseline and final snapshots are present, and the live main build matches the final snapshot. The source-proof command deliberately rejects a differing live core/host build. Later documentation-only commits do not change those executable inputs. `--snapshot` refers to the immutable artifact directory above; use a new output tag for a new experiment.

```sh
node scripts/fast-system-source-proof.mjs --snapshot build/verification/fast-system-performance-build-final-39a63a2
node scripts/fast-system-observer.mjs --snapshot build/verification/fast-system-performance-build-final-39a63a2 --include-fast --iterations 101 --output build/verification/fast-observer-node.json
node scripts/fast-system-observer.mjs --snapshot build/verification/fast-system-performance-build-final-39a63a2 --include-fast --iterations 101 --browser --output build/verification/fast-observer-chrome.json
node scripts/fast-system-performance.mjs --snapshot build/verification/fast-system-performance-build-final-39a63a2 --tag repeat --iterations 100001 --samples 7
node scripts/fast-system-paging.mjs --snapshot build/verification/fast-system-performance-build-final-39a63a2 --tag repeat-node --iterations 10001 --samples 7
node scripts/fast-system-paging.mjs --snapshot build/verification/fast-system-performance-build-final-39a63a2 --tag repeat-chrome --browser --iterations 10001 --samples 7
node scripts/fast-system-paging.mjs --snapshot build/verification/fast-system-performance-build-final-39a63a2 --tag repeat-efer-node --msr-controls --iterations 10001 --samples 15
node scripts/fast-system-characterize.mjs --snapshot build/verification/fast-system-performance-build-final-39a63a2 --tag repeat-node --iterations 10001 --samples 7
node scripts/fast-system-characterize.mjs --snapshot build/verification/fast-system-performance-build-final-39a63a2 --tag repeat-chrome --browser --iterations 10001 --samples 7
node scripts/fast-system-mutations.mjs --work /tmp/ring64-fast-mutation-repeat --evidence /tmp/ring64-fast-mutation-repeat-evidence
```

Paired inherited drivers support `--reverse` and `--aa`; EFER controls use the same pairing driver with `--msr-controls`. The new-feature driver has no before/after mode. Raw evidence is local under ignored `build/verification` and the recorded `/tmp` directories; the drivers, guest kernels and this bounded result record are versioned.
