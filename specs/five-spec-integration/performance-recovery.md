# performance regression recovery

This follow-up recovers the selected x87/MMX and IA32e regressions recorded in
[the integration verification](verification.md). Earlier measurements remain
historical evidence. The [data index](performance-recovery.json) and
[timing table](performance-recovery.csv) retain frozen source/artifact identities,
full-precision paired observations, rejected experiments and measurement limits.
README and dependency manifests/locks are unchanged.

## retained changes

The x87 special-form cohort changed ThinLTO inlining decisions: constant, push and
store helpers acquired hot out-of-line calls. Two small helpers now explicitly stay
inline. A thin inline store wrapper returns raw F80/Register values before the
unchanged conversion body. Conversion status, C1, suppression, pop and memory
publication remain with their existing owners. Actual Wasm call/body inspection
and separately frozen A/B runs identify this mechanism; profile sample shares
alone are not latency attribution.

Numeric admission now bypasses classification/bookkeeping only when live controls
prove enable faults impossible: EM=TS=0, NE=1 and both OS numeric bits enabled,
or the fixed private plane. DE legality still runs first. Both callers clear prior
diagnostics before debug/decode; the skipped numeric PC is consumed only by the
OSXMMEXCPT=0 route excluded by the shortcut. NE0 waiting behavior and exceptional
control paths remain intact. The paging bank is borrowed for one synchronous
decode instead of copying 80 bytes; it cannot outlive decode or observe a control
publication during it.

The larger paging improvement removes redundant work at its owner. A required-byte
fetch previously rewalked consumed encoding and the current translation even when
the fetch walk performed no A write. In this synchronous, privately owned Image,
only a successful A write can change those inputs during decode. A local witness
is reset for every byte and set by the existing post-A callback. With no write,
the repeated observations are unnecessary; with any write, the entire old
postwalk validation remains. Per-level FETCH barriers, callback order, early
fault/restart exits and the final physical Execute fetch are unchanged. There is
no cross-byte or cross-call cache. Captured PDPTEs remain authoritative values.

The integrated native guard was RED before this change and GREEN afterward. For
three literal instruction bytes, warm IA32e hierarchy reads fall **36 to 12**;
cold reads fall **50 to 30** while all four A checks/writes remain. Legacy non-PAE
and PAE have six warm and thirteen cold reads, at their respective widths. Whole
RAM, bank/context/scalar state, a warm PTE remap between calls and PG0 Execute
refusal are checked independently. Existing alias, lower-fault priority, repeated
restart, RF, CR2 and retirement scenarios passed in the full runtime suite.

## exact final artifact and verification

Production source: `d619845f813712cfb953ebd67d0b296c0fb49f7a`.
Final Core: **1,179,084 bytes**, SHA256
`670a46f37d8cec0f4b0868b63285354a587cdc82723b2a5c90dc978e7b5f7416`.
Production host SHA256:
`2f2ccdfa6177c2cd42afb4c811f8e019216e4ebfbaf719668b8ff506dbcf4a84`.
Host including compiled tests:
`a3945ddb4b62f434ee59a5056df0525eb96ae21ada4c1e6e81404924c38319b3`.
The final timing snapshot records a clean working tree at that source. Historical
stage I used Core `06a12aa0…`; formatting changed artifact bytes, so all final
comparisons and acceptance oracles were rerun against `670a46f3…`.

`npm run check` passed formatting, lint, native/Wasm Clippy, release build,
**859 native tests, 239 Node tests and 942 Chrome scenarios**. The exact final
Core also passed **2,200 rational/raw80 x87 cases**, **6,480 I/O cases** and
**2,496 independent raw-store cases**. The promoted
[raw-store oracle](../../scripts/check-x87-raw-store-oracle.mjs) passed again after
formatting/lint; its CLI rejection controls passed. Later commits add the oracle
and verification evidence without changing production Core/host code.
An isolated valid Core mutation after native compilation reached the oracle's
post-run hash guard and produced no report.

Raw-store coverage includes literal value classes, eight TOP values, masked and
unmasked empty sources, register/F80 stores, RF, TF and last-byte DR completion;
it checks 800 committed and 32 suppressed memory stores with guard bytes. On
isolated stage B (Core `6867286d…`), a separate temporary Wasm mutation made only
the conversion body trap: all 2,496 raw
packets still passed, while F32/I32/BCD conversion controls reached that trap.
The initial probe's incorrect expectation for optional TF-only debug fields was
corrected against identical old/new public results; it was an oracle error.

Three agents investigated correctness, boundaries and measurement; two fresh
reviewers audited the retained implementation afterward. Neither fresh source
review found an actionable issue. The promoted oracle received a separate
source review. These reviews complement the runtime evidence rather than proving
unbounded conformance.

## matched target results

All latency runs were serialized without builds, tests or agent workloads on
Apple M4 Pro, darwin/arm64, Node **v22.16.0** and Chrome **157.0.8103.79**. Each
side owns its factory, Core, CPU and backing. Benchmark provenance now uses frozen
metadata, and Core/host changes during observation reject publication; a
permanent subprocess test covers both properties.

Ratios are final/baseline elapsed time; below one means less time. X87 uses
1,000,001 iterations, 17 samples and the 13 saved later pairs. Paging uses
100,001 iterations, 18 samples and 17 warm pairs, with exactly 300,003 retired
instructions per sample. First compilation is separate. The ranges below span
the initial and reversed-order comparisons with original `e00a418`; they are
observations, not confidence intervals.

| workload          | Node ratio range | Chrome ratio range |
| ----------------- | ---------------- | ------------------ |
| x87 stack churn   | 0.9771–0.9891    | 0.9742–0.9811      |
| mixed MMX/x87     | 0.9797–1.0016    | 0.9679–0.9691      |
| IA32e fetch       | 0.6742–0.6769    | 0.6505–0.6607      |
| IA32e load        | 0.6435–0.6499    | 0.6201–0.6286      |
| IA32e store       | 0.6569–0.6578    | 0.6347–0.6349      |
| IA32e RMW         | 0.6091–0.6128    | 0.5832–0.5865      |
| IA32e system read | 0.6978–0.7016    | 0.6664–0.6751      |

Against regressed `ed95faa`, x87 stack/mixed ratios are **0.9112/0.8862** in Node
and **0.9175/0.8983** in Chrome. The five paging ratios range **0.5924–0.6781**
in Node and **0.5771–0.6682** in Chrome. These are direct comparisons, not products
of stage ratios. Node mixed MMX/x87 is at original-baseline parity across order:
the reversed ratio 1.0016 is comparable with its A/A ratio 1.0018. Target A/A
controls stay within about 0.8% of one; they bound this run's noise rather than
establishing a universal threshold.

## broader checks and limits

The inherited 170-workload comparison completed with semantic assertions passing
in both runtimes at configured N=1,001/samples=9; 28 non-resume x87/MMX/numeric
workloads also completed at N=100,001/samples=13 with their assertions passing.
Effective work and caps are retained per definition.
All 51 new-spec fixtures passed ed95/final characterization in both runtimes at
N=4,096/samples=3: each report includes one first invocation and three warm batches
per fixture. These separate runs are characterization, not paired speedup proof.
The 19 inherited context/population controls passed timing-discarded smoke in
both runtimes.

The broad Node scalar-F32 short-batch ratio 1.5043 did not reproduce with
1,000,001 iterations: direct/reversed ratios were 0.9913/0.9887 in Node and
0.9967/0.9957 in Chrome. Debug-miss and REP segment-repair rows remain capped at
501 cycles regardless of the larger configured N: debug measures 1,503 public run
calls; repair measures 501 calls/entry attempts. Their summed per-call clock
readings are unstable: Chrome repair shows 1.1071/1.0714 against old, but the
same-artifact A/A ratio is 1.2083; corresponding wall ratios are
1.0099/1.0097 and 1.0000. Wall time includes rearming/repair and is a different
metric, so it does not replace the per-call result. No attributed regression is
established by those rows. In the broad Chrome comparison, 86 workloads contain
zero-duration pairs; their ratios remain undefined rather than dropping zeros or
adding a denominator floor.

Force-inlining admission, shrinking Translation/Fragment layout and outlining
all/legacy walk geometries were tried separately and rejected. Smaller structures,
fewer Wasm call edges or smaller callers did not reliably improve latency. The
unused I/O decoder split was not adopted. Old/current original comparisons change
both Core and host; same-host stage/ed95 comparisons isolate the Core better.
Profile shares and binary sizes diagnose mechanisms, not native cycles. The
evidence establishes selected synthetic batches on one host, not application
throughput, native-hardware equivalence or blanket performance parity.
