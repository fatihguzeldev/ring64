# call gates and privilege stacks verification

The selected [specification](spec.md) is implemented: legacy 16/32 and IA32e 64 gate CALL/JMP, same/conforming and inner transfers, every legacy parameter counts 0–31, matching RETF, prospective stack access, paging, actual debug operands and existing context/event owners. This completes the selected increment, not an architectural vertical or native-hardware conformance claim. Overlapping-stack expectations follow Ring64's private capture-before-payload profile. They do not establish Intel progressive-alias or microcode partial-store equivalence; permitted earlier page A/D effects remain. README, dependencies, host code, decoding and DBT lowering are unchanged.

## source and artifacts

The final implementation/test/driver tree is `d23245255cbb732c631e55ea7852fbd3d47cd672`. The complete check ran on those source bytes before the commits recording them; subsequent evidence commits do not change executable inputs. Frozen artifacts and their source manifests are retained locally:

| artifact    | frozen directory                                 | Core SHA256                                                        | bytes     |
| ----------- | ------------------------------------------------ | ------------------------------------------------------------------ | --------- |
| predecessor | `build/verification/call-gates-baseline-ec50133` | `670a46f37d8cec0f4b0868b63285354a587cdc82723b2a5c90dc978e7b5f7416` | 1,179,084 |
| final       | `build/verification/call-gates-final-d232452`    | `8ad967df3b2f9af4c901c82c42fcad90300a9c7e90cc863ac0e31235af80b1d2` | 1,240,374 |

Both use production-host SHA256 `2f2ccdfa6177c2cd42afb4c811f8e019216e4ebfbaf719668b8ff506dbcf4a84` and complete-host hash `a3945ddb4b62f434ee59a5056df0525eb96ae21ada4c1e6e81404924c38319b3`. Core growth is 61,290 bytes. Binary size does not establish latency.

The predecessor freeze honestly records spec-only commit `ec50133` plus dirty `cfg(test)` registration/new gate tests. Its production inputs and exact Core are the pre-feature `43dad55` artifact; it is not described as a clean checkout. The final freeze records a clean tree. [Artifact evidence](verification/artifacts.json) preserves manifests, hashes, test counts and the source-diff proof for unchanged README/dependencies/host/DBT/numeric code.

## checks and falsification

`npm run check` passed formatting, lint, native/Wasm Clippy, **888 native tests, 239 Node tests and 994 Chrome scenarios**. The shared public suite adds 52 gate scenarios with matrix profiles inside them. Chrome was 157.0.8103.79; Node was 22.16.0 on Apple M4 Pro, darwin/arm64. The native domain includes 512 frame/return combinations, 1,024 privilege/conformance combinations, exact traffic phases and every one of 35 destination refusals.

The [independent public oracle](../../scripts/call-gates-audit.mjs) passed **1,041 cases and 2,080 guest calls in each runtime**, including 1,024 legacy width/count/SS.B/TSS/source-CS.D combinations. Expectations use separate literal descriptor bytes and frame arithmetic, complete RAM, raw register/numeric state and context comparisons. Seventeen additional wrap/alias/memory/IA32e cases include two negative touched-stack-span cases. B16 oracle segments deliberately use expanded limits: they do not claim every wrapped frame can RETF through a strict limitFFFF cleanup gap. The inherited unwrapped cleanup-geometry refusal remains.

The exact final Core also passed **2,200 rational/raw80 arithmetic cases, 6,480 I/O cases and 2,496 raw-store cases**. Gate/IO/raw-store drivers check post-run integrity; the arithmetic driver records the bytes consumed, supplemented by the frozen/live Core check after the full window. These older drivers do not all have identical per-call safeguards.

The first native/public positive gate fixtures failed with the expected Unsupported frontier before implementation. Additional adversarial review found and fixed two real defects:

- An eager page A alias changed page-table authority between admissions. A later frame D-write refusal at linear FFD / physical 57000 was incorrectly labeled as an earlier GDT descriptor accessed write at the same linear address. Native gate and ordinary-CALL packets reproduced it; an emitted public packet reproduced the incorrect report. Paged memory now carries the failing captured write's ordinal. Gate/ordinary far consumers distinguish descriptor-prefix admissions from frame admissions without another walk. A separate duplicate-span memory test identifies index1 and proves failed batches cannot publish later.
- A gate with newSP=9008 captured its first two frame writes before the next slot faulted. The bridge retained that abandoned plan until a later begin/entry cleared it; a new memory owner could still publish its D update. The actual bridge regression changed PTE9 from 9023 to 9063 before the fix. Every failed paged far result now drops that plan before returning its diagnostic.

Canonical CALL/JMP descriptor sources retain the full system-memory report while opt-in delivery captures the selector-coded GP; native/public tests distinguish RETF/LTR and later private refusals. Debug observes captured pointer/parameter/new-frame/RETF linear spans and publishes the current mask only on success. The spec's deferred-SS wording was clarified against the inherited debug contract: private refusals preserve history; a recognized architectural successor fault cancels it.

Fresh independent source reviews checked ordering, captured physical publication, error ownership, companion lifetimes, actual debug operands, event/TSS policy separation and the latest bridge cleanup. Separate acceptance review added selected WP/NX/target-fetch, self-PTE and active/dormant aliases, gate eviction/backing reincarnation, epoch saturation, IA32e JMP and unblocked-NMI packets. All passed the full public/native gate.

All **16 deliberate semantic mutants** built successfully in isolated copies, then failed on named unchanged guest assertions. No build error, engine crash, trap, timeout or missing scenario was counted. The source snapshot remained unchanged. The complete [campaign](verification/mutation-campaign.json) and [kill evidence](verification/mutations.json) preserve exact patches, argv, assertion diagnostics and hashes; temporary Cargo sandboxes are not the permanent evidence.

## performance

All timing jobs were serialized, with no overlapping builds, mutations or other guest/timing workloads. Each side owns its frozen factory/Core/CPU/backing. [Measurement plan](verification/performance-plan.json), [performance evidence](verification/performance.json), [raw timing pairs](verification/timing-pairs.csv) and [row summaries](verification/timing-summary.csv) retain **40 paired reports and 9,978 sample pairs**, actual work/caps, first/early/later observations, side identities and raw zeros. Every paired state/context/numeric/resource/unit packet compared equal. Ratios always mean current/baseline by explicit labels; reverse execution order does not reverse that direction. A/A means B/A.

The inherited screen used configured N=1001/samples=9: 170 report rows and 169 matched-delivery rows per runtime. Matched TF stepping is explicitly unavailable because it selects events, as in the predecessor. Chrome sub-tick/zero samples remain in the data; a zero baseline median produces an undefined ratio, not a floor or a dropped sample. CSV zero counts cover all saved samples; medians use the recorded `later_cutoff`. No percentile confidence or per-application throughput is inferred.

The recovered x87/MMX controls used N=1,000,001/samples=17, retaining 13 later pairs. Five IA32e kernels used N=100,001/samples=18, retaining 17 warm pairs, with 300,003 retired instructions per sample. Primary and reversed ranges are:

| workload          | Node current/baseline | Chrome current/baseline |
| ----------------- | --------------------- | ----------------------- |
| x87 stack churn   | 1.0022–1.0056         | 1.0076–1.0086           |
| mixed MMX/x87     | 0.9863–0.9956         | 0.9931–1.0256           |
| IA32e fetch       | 0.9923–0.9935         | 0.9769–1.0024           |
| IA32e load        | 1.0006–1.0070         | 0.9957–0.9986           |
| IA32e store       | 0.9899–1.0042         | 1.0000–1.0058           |
| IA32e RMW         | 1.0004–1.0055         | 0.9962–0.9962           |
| IA32e system read | 0.9985–1.0027         | 0.9907–0.9977           |

Chrome churn retains a small observed shift of **+0.13–0.15ns per retired instruction**. Its raw paired ratios span 0.9886–1.0297 / 0.9850–1.0296, and A/A spans 0.9804–1.0366; the single A/A median is not a universal noise bound. MMX's Chrome result changes with order. These observations establish no attributed repeatable material loss in the recovered targets, and do not establish zero overhead.

Fourteen fixed inherited controls ran primary/reversed/A/A in both modes/runtimes. A predeclared additional three-row deep cohort investigated the screen's Node F32/FNSTENV outliers and short-resume far CALL/RET: N=1,000,001/samples=17, all modes/runtimes. The initial 45–50% F32 and 14% FNSTENV screen losses did not survive the deeper workload. F32 later ratios range 0.9891–1.0011. FNSTENV has small order/mode-dependent shifts up to 1.0197; all rows and A/A values remain in the tables. Far-resume is actually capped at 3,000 iterations / 9,000 retired instructions / 9,000 public runs; a larger requested N does not enlarge it. Its summed short-run clocks change with order and A/A, and wall timing remains a different metric. No repeatable material regression was attributed. This is bounded synthetic evidence on one host.

Seven syscall/context-reuse and twelve population controls also passed in each runtime with timing intentionally discarded. They establish the checked semantic/owner behavior, not an additional latency conclusion.

New gates have no executable predecessor denominator. **33 characterization rows** completed one first invocation and five warm samples per runtime, configured N=4096. Debug-hit, overlap, repair and short-resume rows cap at 257; the other 29 rows use 4096. [Raw characterization](verification/characterization.csv) preserves elapsed/wall/creation timing, calls, retired work, copied bytes, failures and flow/resource gauges. Scope includes W2/4/8, counts 0/1/31, memory families, same/conforming/inner, an actually equal loaded context, round-trip reuse, descriptor-A versus page-A/D first touches, debug, aliases/repair and gate A→B→A edits. Nominal metadata/operand counts explicitly exclude fetch/validation/page walks. Batch samples have no zero elapsed result; that does not establish single-call clock precision or native cycles.

## replay

The local frozen directories above contain the exact measured artifacts. Rebuilding another source path/toolchain can change binary identity; always record the resulting hashes instead of silently substituting it. Original full JSON/logs remain under `build/verification/`; committed CSVs retain every paired elapsed value and characterization phase, with raw-file hashes in the index.

```sh
npm run check
node scripts/call-gates-audit.mjs --snapshot build/verification/call-gates-final-d232452 --output build/verification/call-gates-oracle-replay-node.json
node scripts/call-gates-audit.mjs --snapshot build/verification/call-gates-final-d232452 --browser --output build/verification/call-gates-oracle-replay-chrome.json
node scripts/call-gates-mutations.mjs --campaign specs/call-gates-and-privilege-stacks/verification/mutation-campaign.json --run --output build/verification/call-gates-mutations-replay.json
node scripts/paging-performance.mjs --snapshot build/verification/call-gates-final-d232452 --baseline build/verification/call-gates-baseline-ec50133 --tag call-gates-replay --iterations 1001 --samples 9
node scripts/paging-latency-audit.mjs --baseline build/verification/call-gates-baseline-ec50133 --current build/verification/call-gates-final-d232452 --iterations 100001 --samples 18 --output build/verification/call-gates-paging-replay.json
node scripts/call-gates-audit.mjs --snapshot build/verification/call-gates-final-d232452 --characterize --iterations 4096 --samples 5 --output build/verification/call-gates-characterization-replay.json
```
