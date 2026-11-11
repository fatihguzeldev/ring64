# reset and mode transitions verification

## implementation and authority

Implemented on isolated base `b4aec7c` in commits `1e47a45`, `8a27577`,
`bae948c`, `f2532ac`, `02febec`, `cb41b53` and `d12fb6d`.
The base already contains numeric controls and legacy paging runtime, plus the
concurrent I/O implementation. These measurements describe that isolated snapshot,
not the later integrated root tree.

Only physical CPUs gain PG0, reset and family transitions. The existing control
bank owns PE/PG/PAE/LME/LMA/NE/DE; loaded context owns VM, CS.L/D and SS.B.
`paging.is_some()` means the bank/access capability exists, not PG1. PG0 uses the
same physical memory authority with identity translation, zero table entries and
no fabricated dirty leaf. Fragment length compares in u64 before narrowing so
linear0's 2^32 remaining span cannot become a zero-length loop.

Control candidates, derived mode and conditional quartet publish together after
architectural admission and complete physical load. Source-family fetch precedes
the writer; completion precedes destination-family successor fetch. Cold probes
perform decode/DE legality/numeric-enable admission only. They do not execute
control writers, capture a PDPT or evaluate pending NE0 numeric results.

Physical full checkpoints preserve raw loaded caches through every family,
including noncanonical FS/GS/system bases, transitional CPL0 RW CS and unusable SS.
Old planes and shorthand inputs retain their prior validation. Actual address use
and architectural writers retain their instruction-specific checks. The independent
review reproduced an unreadable snapshot after legal IA32e activation; `d12fb6d`
closes host capture/readback and native parse/restore together, without inventing
an activation fault or clipping the raw bases.

Reset replaces architectural banks in place, retires all source proofs/watchers,
then releases host cache references. Image, RAM, mappings, provider binding and
monotonic owner allocation remain. A fresh reset token rejects stale input capture;
its reset identity is separate from ordinary run generation, preserving inherited
completed nested-run policies. Unexpected native/reset-owner release traps poison
the CPU. Pending NE0 refuses before RF/operands; DE1 DR4/5 legality precedes CPL/GD.

## completed conformance

After all mutations, exact source restoration and artifact rebuilding,
`npm run check` passed at `d12fb6d`:

- 848 native tests;
- 237 Node tests;
- 893 shared actual-Wasm scenarios in Chrome157.0.8103.79.

The complete check includes formatting, lint, both native/Wasm clippy targets,
native tests, build, Node and browser execution. Final core size: 1,173,460 bytes.
SHA256: `2cc2e919193f9a93f68172b96efa316151478076b21177a09358ae827d2b24ed`.
Tools: rustc/cargo1.97.1, Node25.9.0, TypeScript7.0.2, Playwright1.64.1.
Local gate log: `/tmp/ring64-five-reset-post-mutation-check.log`.
Machine-readable browser evidence: `build/verification/browser.json`.

The 28 new shared scenarios live in [the reset suite](../../tests/execution/reset/index.ts).
They include the independent high-vector near/far packet, the exact69-instruction
real→legacy→PAE→IA32e→real program, all69 budget-one resumptions with literal family
checkpoints, disjoint-root PG1 PAE toggles and a source-A/reserved-PDPTE alias.
Late successor #PF/private refusal preserves the committed writer; repaired retry
executes only the target. PG0 INT/IRET, RMW/FX images, implicit traffic, raw high PF
sources, full-cache constructor restore, complete-span refusal and destination-mode
TF have separate assertions.

Reset packets assert every represented bank, occupied-zero x87 reset behavior,
cache death, RAM/ROM retention and captured provider state. Getter packets cover
scalar/context/XMM/x87/debug/controls/MSRs/mappings/backings/byte input/run options.
Awaited compilation and synchronous provider callbacks reject reset without
canceling valid work. Failed/disposed/wrong-model cases preserve lifecycle rules.
Native owner tests cover epoch0/MAX, pending handles, monotonic fresh IDs and old
handle release. An isolated source-copy experiment seeds host run generation at
MAX−1/MAX: reset remains usable while exhausted runs continue to reject. It adds no
production hook; script `/tmp/ring64-five-reset-capacity.mjs` records that control.

## bounded mutation evidence

Each counted mutation was separate, compiled successfully and failed unchanged
intended semantic assertions. Compiler failures, timeouts and unrelated crashes
were not counted. Exact source bytes were restored after every attempt.

| owner / broken fact                                                       | counted kills |
| ------------------------------------------------------------------------- | ------------- |
| PG0 identity and absence of fake dirty metadata                           | 2             |
| reset FCW/tags/EDX/high-CS literals, provider and old-owner retention     | 6             |
| native raw full-cache/CR3/FS transport and canonical-at-use               | 3             |
| cold probe purity, NE0 refusal, CD/NW legality and activation priority    | 4             |
| public reset capture identity/cache release and physical raw FS transport | 3             |
| generated DR4 alias, NE0 phase, unreal CS.D lifetime and PG0 selected MSR | 4             |

All22 counted mutants were killed. One additional removal of Core's nonlong
MOV-CR normalization survived because generated input narrowing still supplies the
same low32 value. That redundant-guard experiment is not counted as a kill or a
new semantic gap. The normal public fixture separately asserts raw upper-bank
read/merge/write behavior.

Raw scripts/reports: `/tmp/ring64-five-reset-mutations.py`,
`/tmp/ring64-five-reset-mutations.json`,
`/tmp/ring64-five-reset-mutations-public.py`,
`/tmp/ring64-five-reset-mutations-public-last.py`,
`/tmp/ring64-five-reset-mutations-public.json` and the separate attempted-survivor
record `/tmp/ring64-five-reset-mutation-attempts-public.json`.

## performance claim ceiling

No additional generated helper/import or provider poll is added to non-I/O units.
The existing reached paging boundary consumes live controls; reset has fixed bank
work plus bounded resident owner/cache/watcher release, without RAM scanning.
The isolated conformance runs occurred alongside other builds and are not latency
measurements. Matched inherited workload timings, A-A/reversed controls and reset
cost versus owner/RAM size belong to the quiet integrated measurement run. No boot,
hardware-cycle, whole-application or unmeasured performance claim is made here.
README was not changed.
