# five-spec integration verification

This record joins the separately reviewed x87 special forms, numeric controls,
legacy paging, reset/mode transitions and port I/O implementations. The original
contracts were committed and pushed at `e00a418`. Implementation, integration
fixes, independent acceptance tests and audit changes use separate logical commits.
README is outside this change and remains byte-identical.

## responsibility and publication

| contract                                                                  | implementation and isolated evidence                                                                                              |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| FPREM/FPREM1/FSCALE/FXTRACT/FBLD/FBSTP                                    | [x87 verification](../x87-remainder-exponent-and-bcd/verification.md)                                                             |
| MP/EM/TS/OSFXSR/OSXMMEXCPT and typed numeric faults                       | [numeric verification](../numeric-execution-controls/verification.md)                                                             |
| non-PAE/PAE/PSE-36, conditional PDPTE capture and permissions             | [legacy paging verification](../legacy-paging-and-permissions/verification.md)                                                    |
| PG0/reset and guest real→legacy→PAE→IA32e→real execution                  | [reset verification](../reset-and-mode-transitions/verification.md)                                                               |
| synchronous scalar/string I/O, live permission reads and partial progress | [I/O verification](../port-io-and-string-io/verification.md), [independent audit](../port-io-and-string-io/audit-verification.md) |

Rust owns decode/admission, raw numeric effects, controls, translation, prepared
memory effects and architectural publication. TypeScript owns captured inputs,
provider adaptation, bounded cache references and public lifecycle. Generated code
uses those existing owners; it does not duplicate permission, numeric eligibility
or page-family rules. A physical plane keeps its memory authority across family
changes. Pending historical sources remain separate from live controls.

## final conformance cohort

`npm run check` passed at production/script source `9547ade`:

- formatting, lint, native/Wasm Clippy and the release build;
- **851 native tests**, **238 Node tests**, **941 shared Chrome scenarios**;
- the final **2,200 x87** and **6,480 I/O** independent cases passed again after
  that build. The 51 characterization fixtures also passed Node/Chrome functional
  smoke; 19 inherited context/population controls passed both runtimes.

Final Core: **1,179,167 bytes**, SHA256
`d11c4a3e0847e57e82b61eb3e41ef67d1ad8462722a6235b546600208f98299f`.
Production host SHA256:
`2f2ccdfa6177c2cd42afb4c811f8e019216e4ebfbaf719668b8ff506dbcf4a84`.
Host hash including compiled test files:
`a3945ddb4b62f434ee59a5056df0525eb96ae21ada4c1e6e81404924c38319b3`.
Pending changes during the final gate/oracles were verification documents only;
the recorded manifests retain their exact working-tree descriptions. Later report
commits do not change these executable artifacts.

Local evidence: `/tmp/ring64-five-complete-final-check.log`,
`/tmp/ring64-five-delivery-x87-oracle.log` and
`/tmp/ring64-five-delivery-io-oracle.json`. README SHA256 remains
`8b5c428abbf6bdff38ef1dc5d0436873bdffa8283e68a98da23f1fce0f4372ac`.

## independent audit and falsification

Three concurrent reviewers examined separate correctness, ownership/boundary and
performance responsibilities. A second cross-review exchanged implementations:
x87/numeric controls, legacy/reset and legacy/I/O received fresh source and
actual-Wasm review. Findings were fixed and rechecked before delivery.

Consequential fixes included preserving all numeric control masks in physical
profiles; respecting decode-only cold-probe admission; poisoning the CPU on reset
cache-release traps; restoring legal physical checkpoints with raw noncanonical
loaded bases after IA32e activation; and invoking captured provider callables with
`Reflect.apply` instead of consulting a mutable own `.call` property. Each has a
specific regression packet at its owner.

The isolated campaigns killed **67 semantic mutants**: x87 18, numeric controls 9,
legacy paging 5, reset/transitions 22 and I/O 13. Each counted mutant reached a
named unchanged semantic assertion. Compile failures and unrelated traps were not
counted. One additional redundant MOV-CR normalization guard removal survived;
the emitter already narrows that value, and the experiment is explicitly excluded
from the kill count. The owned reports preserve the campaign details and restored
source gates; isolated hashes are historical cohorts, not final integration hashes.

Two independently expressed finite oracles supplement the literal public tests:

- [Fraction/raw80 generation](../../scripts/x87-independent-oracle.py) and its
  [public checker](../../scripts/check-x87-oracle.mjs): 1,200 remainder and 1,000
  scaling cases. Expectations do not call production arithmetic.
- [Port oracle](../../scripts/check-io-independent-oracle.mjs): 336 string-progress
  packets and 6,144 permission packets, with independently constructed masks,
  callback traces, index/count progress and fixed Long64 CPL3 bitmap decisions.

These cases establish their finite selected profile. They do not establish native
hardware equivalence, transcendental accuracy, a device platform or OS boot support.

## measurement method

The frozen executable baseline is `e00a418`, Core SHA256
`bc0f715fff9bcceac715359804103041deb1fd4038197f3d547fb708fada7be4`.
The all-five measurements compare that baseline with the integrated candidate;
they do not attribute every change to an individual spec. Per-spec source audits,
isolated gates and artifact observations remain separately identified above.

Measurements run serially without concurrent builds, tests or other benchmark
processes, on an Apple M4 Pro, darwin/arm64, Node v22.16.0 and headless
Chrome 157.0.8103.79. Each side uses its own factory/Core/CPU/backing. Matched work
checks results outside the measured interval, alternates A/B and B/A, and uses
reversed-order and same-build A/A controls for investigated differences.

The existing benchmark covers 170 inherited workloads. Its resume rows cap their
guest count; increasing `--iterations` does not necessarily deepen those rows.
The separate IA32e audit uses five equal-work fetch/load/store/RMW/system kernels,
prefills A/D bits and separates first compilation from warm artifact reuse.
The 51 candidate-only characterization kernels include an inherited IA32e anchor.
Newly admitted behavior has no executable predecessor denominator and does not
claim a speedup. Fault-only rows use attempts rather than a zero-retirement denominator; mixed
packets retain actual retirement counts. Partial remainders report both steps and
completed reductions; I/O rows
separate attempted/accepted/consumed/committed work. Cache gauges are final resident
values, not sums across resumptions.

The characterization `creationMs` includes complete fixture construction. Transition
preparation resets architectural state and owners while retaining RAM/A-D bits;
later samples are not cold-RAM boots. Provider-only direct-call loops include their
own loop work and are never subtracted into claimed engine cycles. Expected
semantic table bytes are labeled as expectations rather than whole-engine physical
read instrumentation. Chrome's coarse clock makes tiny fixed repair/reset packets
quantized; zero/sub-resolution rows do not support precise ns/unit or ratio claims.

## measured native walk work

The physical-call native test records actual `Image` call sites in the walk/PDPTE
owners; a separate literal entry-access trace test protects dispatch and geometry.
Storage and recording calls are entirely `cfg(test)`;
generated units and release builds acquire no observer. Read-only observation of
cold tables has the warm read count and performs no updates. Counts below are
successful selected packets; the recorder counts attempted explicit calls and
requested widths, not internal backing probes or bus transactions.

| family          | warm reads / bytes | cold reads / bytes | cold checks and writes, each / bytes | cold FETCH reads / bytes |
| --------------- | ------------------ | ------------------ | ------------------------------------ | ------------------------ |
| IA32e 4KiB      | 4 / 32             | 8 / 64             | 4 / 32                               | 18 / 144                 |
| legacy PAE 4KiB | 2 / 16             | 4 / 32             | 2 / 16                               | 7 / 56                   |
| non-PAE 4KiB    | 2 / 8              | 4 / 16             | 2 / 8                                | 7 / 28                   |
| PSE-36 4MiB     | 1 / 4              | 2 / 8              | 1 / 4                                | 3 / 12                   |
| PAE 2MiB        | 1 / 8              | 2 / 16             | 1 / 8                                | 3 / 24                   |
| PG0             | 0 / 0              | 0 / 0              | 0 / 0                                | 0 / 0                    |

Cold ordinary walks include one current-word reread per A update. Cold FETCH also
includes each already-visited hierarchy reread after those updates. A successful
quartet capture performs **4 reads / 32 bytes**, with zero checks/writes. FETCH's
encoding-currentness callback is a no-op in this native count gate. Payload/D
publication, embedding decode/source peeks, private backing preflights and whole
engine physical access totals are excluded; no uninstrumented count is presented
as measured. Prepared-D effects, refusal, alias and completion ordering have
separate functional tests.

[Release binary comparison](release-counter-check.json) confirms that the counter
commit changes no Code, import, export or name-section byte. The whole Core hashes
do differ: precisely two Data-section bytes update Rust panic line numbers after
test-only source displaced those expressions. The final Core hash above identifies
the rebuilt artifact; no whole-module byte-identity claim is made.

Numeric control bits are live admission facts rather than artifact keys. Repeated
TS/OSFXSR toggles therefore assert stable installed owner IDs instead of inventing
a numeric-variant population. The independent context reuse/population cohort
measures the existing bounded context-owner lookup and caps at populations 1/8/32/128 with
first/last/miss positions and preserves its effective iteration counts.

## quiet measurement results

The [measurement metadata](measurements.json) and [timing table](timings.csv)
retain the artifact/source identities, effective work, selected raw durations,
median/MAD/range, first/warm phases and resource counts. Ratios below are candidate
divided by baseline; values above 1 indicate additional time. They describe checked
synthetic batches on this one host, not an application throughput estimate or a
blanket no-regression result.

The audit found and reduced two substantial costs: absent numeric-source capture
allocated a typed array and called `Boolean` for 40 bytes on every snapshot; it now
checks all ten 32-bit chunks without allocation. Native walk geometry now specializes
at one shared family boundary instead of carrying dynamic shifts/widths through
every entry. The measured scan comparison reduced time by 2–14% in Node and 8–18%
in Chrome across its ten selected batches. The staged walker comparison reduced
time by 8–10% in Node and 6–10% in Chrome; that pair also includes the preceding host
scan optimization, so it is not a pure one-change end-to-end attribution. Profiles
and separate source/binary observations identify the native walker work.

A smaller memory-effect guard avoids source-change checks for pure x87
register/constant operations while retaining read-A and suppressed-store exits.
Its matched mixed-MMX/x87 comparison improved 4.2% in Node and 1.7% in Chrome;
stack-churn differences were below 1%. A final conditional diagnostic-clear probe
gave about 1.5–2.3% in Node and below 1% in Chrome, did not explain the residual, and was
not retained. Rebuilding restored the entire final Core byte-for-byte. Historical
counterfactuals have separate hashes; their ratios are not additive.

Selected final inherited medians:

| checked batch                    | Node baseline → candidate, ms | Node ratio | Chrome ratio |
| -------------------------------- | ----------------------------- | ---------- | ------------ |
| vector store, unaligned          | 1.823 → 1.833                 | 1.005      | 0.944        |
| budget-one resume                | 7.764 → 7.822                 | 1.007      | 0.976        |
| far-call/return resume           | 12.699 → 12.730               | 1.002      | 1.040        |
| software-event/IRET resume       | 4.566 → 4.672                 | 1.023      | 1.044        |
| x87 stack churn                  | 13.438 → 14.221               | 1.058      | 1.056        |
| mixed MMX/EMMS/x87               | 5.591 → 6.309                 | 1.128      | 1.068        |
| IA32e RMW, forward order         | 142.820 → 146.121             | 1.023      | 1.011        |
| IA32e system read, forward order | 133.970 → 140.936             | 1.052      | 1.030        |

The last two rows use 100,001 iterations/300,003 retirements. The general benchmark
retains its own effective caps, including short-resume caps; rows are comparable
within each pair, not across different workloads. Final five-kernel IA32e Node
ratios span 1.017–1.053 across forward/reverse observations. Chrome's corresponding
range is 0.959–1.040; its RMW A/A control itself varied 2.6%. The x87/MMX residuals
above repeat across runtimes and are explicitly retained as measured costs. No
claim is made that generated byte stability eliminates native helper overhead.

Seven source-preserving context round trips and twelve population/position cases
also passed balanced, reversed and A/A runs. Warm installed owners/caps remained
bounded and checked; no numeric-control variants were invented. Tiny hit batches
are clock-limited in Chrome. Cold compile-heavy population timings varied enough
in same-build controls (selected Node A/A ratios about 0.81–0.87) and reversed order
that they do not support an attributed speedup/regression conclusion. The data
preserves these unfavorable controls rather than filtering them into a claim.

All 51 characterization kernels passed their first and seven subsequent checked
batches in both runtimes. Selected candidate-only medians below use the stated
effective work; newly admitted behavior has no old executable speedup denominator.

| candidate batch              | effective work                                    | Node ms | Chrome ms     |
| ---------------------------- | ------------------------------------------------- | ------- | ------------- |
| FPREM partial/completed loop | 65,536 reductions, two remainder steps each       | 20.470  | 18.300        |
| split-page FBLD              | 65,536 conversions, disjoint 5+5-byte payload     | 107.680 | 100.600       |
| split-page FBSTP             | 65,536 conversions, disjoint 5+5-byte destination | 115.606 | 104.200       |
| #NM→CLTS→IRET→retry          | 256 completed round trips, 9 retirements each     | 2.937   | 2.500         |
| live TS/OSFXSR toggles       | 2,048 guest iterations, 13 retirements each       | 17.883  | 17.100        |
| OSFXSR0 FX image pair        | 2,048 save/restore pairs                          | 5.966   | 5.400         |
| PSE-36 4MiB RMW              | 65,536 checked RMW iterations                     | 54.276  | 49.200        |
| PAE 2MiB RMW                 | 65,536 checked RMW iterations                     | 55.300  | 50.900        |
| same-root CR3/quartet loop   | 64 checked writer iterations                      | 7.104   | 4.000         |
| PSE toggle/capture loop      | 64 checked toggle iterations                      | 13.577  | 8.300         |
| scalar IN                    | 65,536 full-width callbacks                       | 4.923   | 2.000         |
| REP INS8, bypass             | 65,536 committed elements/callbacks               | 5.948   | 3.000         |
| REP INS8, live bitmap        | 65,536 committed elements/callbacks               | 6.916   | 4.600         |
| REP INS8, paged TSS          | 65,536 committed elements/callbacks               | 31.928  | 26.600        |
| INS8, one batch              | 2,048 elements, one public run                    | 0.190   | clock-limited |
| INS8, allowance1             | same 2,048 elements, 2,048 public runs            | 5.740   | 3.600         |
| complete family transition   | one 69-instruction round trip                     | 4.037   | 3.000         |
| budget-one family transition | same 69 retirements, 69 public resumptions        | 4.106   | 3.100         |

Cross-row differences do not isolate a single effect: for example, split BCD uses
physical paging, while the contiguous numeric rows use their declared linear
fixture. Writer-loop time includes redispatch and compilation, not just quartet
reads. Scalar I/O and REP also perform different retired work despite equal
callback counts. Full traces, guards, numeric banks, frames and exact accounting
are checked outside the timer.

Reset at zero owners measures 1,024 resets per batch: Node medians 0.075 ms at 128 KiB
RAM and 0.117 ms at 1 MiB. Eight/24-resident-owner cases measure one reset each; their
Node medians are about 0.007 ms, while Chrome is below useful clock resolution.
These few packet sizes do not establish a scaling curve or precise per-reset
latency. Exceptional FSCALE, full-stack FXTRACT and fixed repair packets likewise
remain characterization with explicit producer/attempt counts; their zero Chrome
durations mean unresolved timing, not zero-cost execution.

## inactive generated structure

[The final structural record](structure.json) checks 339 inherited cohorts.
**309 cohorts** have byte-identical generated modules. The other **30 cohorts** are the
previously identified x87/MMX-x87 operation-word changes permitted by the spec.
Every cohort preserves generated imports, binding signatures, five-argument run
arity, helper/host/native calls, semantic work and resources apart from generated
and cached byte counts. Ordinary units acquire no generated I/O import. Core's two
fixed I/O imports are separate from this generated-body observation.

The old state offsets, reason-code prefix and export arities are preserved. The
numeric source appends 40 bytes at 728, making the current transport 768 bytes.
The historical observer exits 1 with 31 strict differences: its old 728-byte size
assertion plus the 30 known word changes. Its raw `passed:false` is preserved and
classified explicitly; it is not reported as a passing historical gate.

Final Core size is 62,237 bytes above the executable baseline. Source owners and
cached artifacts remain bounded by their tested caps; generated-byte counts do
not measure JavaScript heap retention. Hardware cycles, device throughput,
unmeasured whole-engine physical accesses and whole-application performance remain
outside these observations.

## reproducible commands

Use a built, detached checkout of `e00a418` as `$RING64_BASELINE`; keep it immutable
throughout the observations. Build the candidate once before serial measurement.

```sh
npm run check
python3 scripts/x87-independent-oracle.py --output /tmp/ring64-x87-cases.json
node scripts/check-x87-oracle.mjs --current "$PWD" --cases /tmp/ring64-x87-cases.json
node scripts/check-io-independent-oracle.mjs --current "$PWD" --output /tmp/ring64-io-oracle.json
node scripts/benchmark.mjs --baseline "$RING64_BASELINE" --iterations 10001 --samples 9 --output /tmp/ring64-inherited-node.json
node scripts/benchmark.mjs --browser --baseline "$RING64_BASELINE" --iterations 10001 --samples 9 --output /tmp/ring64-inherited-chrome.json
node scripts/paging-latency-audit.mjs --baseline "$RING64_BASELINE" --current "$PWD" --iterations 100001 --samples 12 --output /tmp/ring64-paging-node.json
node scripts/paging-latency-audit.mjs --browser --baseline "$RING64_BASELINE" --current "$PWD" --iterations 100001 --samples 12 --output /tmp/ring64-paging-chrome.json
node scripts/paging-latency-audit.mjs --context-reuse --baseline "$RING64_BASELINE" --current "$PWD" --iterations 101 --samples 7 --output /tmp/ring64-reuse-node.json
node scripts/paging-latency-audit.mjs --population --baseline "$RING64_BASELINE" --current "$PWD" --iterations 101 --samples 7 --output /tmp/ring64-population-node.json
node scripts/five-spec-characterize.mjs --iterations 65536 --samples 7 --output /tmp/ring64-new-node.json
node scripts/five-spec-characterize.mjs --browser --iterations 65536 --samples 7 --output /tmp/ring64-new-chrome.json
```

For controls, repeat the inherited comparison with `--reverse` and with the built
candidate as its own `--baseline`. The paging audit has `--reverse` and `--aa`.
Context/population controls repeat with `--samples 17`; `--browser` selects the
same cohort in Chrome. The untimed structural observer's historical exit1 and
explicitly classified differences are recorded in [structure.json](structure.json).
Artifact hashes and per-row raw durations are retained in the measurement record;
local large raw logs remain under `/tmp/ring64-five-*`.
