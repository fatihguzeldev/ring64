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
claim a speedup. Fault rows report attempts with zero
retirement; partial remainders report both steps and completed reductions; I/O rows
separate attempted/accepted/consumed/committed work. Cache gauges are final resident
values, not sums across resumptions.

The new-form `creationMs` includes complete fixture construction. Transition
preparation resets architectural state and owners while retaining RAM/A-D bits;
later samples are not cold-RAM boots. Provider-only direct-call loops include their
own loop work and are never subtracted into claimed engine cycles. Expected
semantic table bytes are labeled as expectations rather than whole-engine physical
read instrumentation. Chrome's coarse clock makes tiny fixed repair/reset packets
quantized; zero/sub-resolution rows do not support precise ns/unit or ratio claims.

## measured native walk work

Two focused native gates exercise counters at the actual `Image` call sites in
the walk/PDPTE owners. Storage and recording calls are entirely `cfg(test)`;
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

Numeric control bits are live admission facts rather than artifact keys. Repeated
TS/OSFXSR toggles therefore assert stable installed owner IDs instead of inventing
a numeric-variant population. The independent context reuse/population cohort
measures the existing bounded context-owner lookup and caps at populations 1/8/32/128 with
first/last/miss positions and preserves its effective iteration counts.

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
node scripts/five-spec-characterize.mjs --iterations 65536 --samples 7 --output /tmp/ring64-new-node.json
node scripts/five-spec-characterize.mjs --browser --iterations 65536 --samples 7 --output /tmp/ring64-new-chrome.json
```

For controls, repeat the inherited comparison with `--reverse` and with the built
candidate as its own `--baseline`. The paging audit has `--reverse` and `--aa`.
Artifact hashes and per-row raw durations are retained in the measurement record;
local large raw logs remain under `/tmp/ring64-five-*`.
