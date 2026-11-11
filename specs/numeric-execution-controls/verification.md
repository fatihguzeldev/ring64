# numeric execution controls verification

## implementation and boundary

Implementation commits: `9c7c0e0`, `f541da5`, `1e2754c`, based on `e00a418`.
The source comparison build is `/tmp/ring64-five-baseline` at `e00a418`.

CR0/CR4 retain one paging/control authority. Numeric-only publication cancels
pending captures and positive context proofs through the existing owner boundary,
including epoch saturation, while keeping published source owners alive. Actual
paging fences remain destructive. Generated artifacts specialize no numeric-enable
bits: the existing reached paged instruction-begin decodes and applies the shared
pure admission decision against the live bank. The current-PC probe uses that same
decision before compilation quota; discovery does not execute numeric arithmetic.
There is no additional generated admission call or separate variant cache.

Typed #NM and numeric #UD sources append a40-byte fixed transport tail; old scalar,
numeric, event, debug and paging offsets stay unchanged. `RunState` is768 bytes.
Reason27 is `device-not-available`; older reason IDs stay unchanged. Source imports
validate intrinsic captured facts independently of repaired controls, while the
enclosing pending-event RIP/FLAGS/VM invariants remain enforced. Secondary faults
drop replaced numeric metadata. Numeric-phase #UD publishes MXCSR before reporting,
suppresses the destination and preserves the existing post-begin RF phase.

## completed checks

`npm run check` passed on `1e2754c`:

- 804 native tests, including all32 control combinations, pure decoded-form truth
  tables, CLTS, owner retention/pending ABA at epochs0/MAX-1/MAX, source layout and
  secondary cleanup;
- 228 Node tests;
- 839 shared Chrome157.0.8103.79 execution scenarios, with actual generated Wasm.

Nine new shared scenarios cover all32 images across x87/WAIT/MMX/SIMD/bridge/FX,
101 numeric-control round trips without repeated compilation, cold #NM after an
already consumed compilation allowance, skipped disabled code, actual asynchronous
compilation ABA, execute/data DR priority, FX under OSFXSR0, CVTPI2PD-memory pending
exception exemption, benign #NM entry escalation, postnumeric #UD and a complete
frozen #NM → guest CLTS → IRET → FLD1 retry. Host tests cover primitive-only source
capture, detachment, malformed/incompatible metadata and exact transport bounds.

Browser evidence: `build/verification/browser.json`. Full local gate log:
`/tmp/ring64-numeric-check.log`.

## bounded falsification

Each mutation below was applied separately, rebuilt and exercised against unchanged
assertions. Compiler failures, timeouts and unrelated crashes were not counted.

| mutation                                           | intended assertion that failed   |
| -------------------------------------------------- | -------------------------------- |
| omit TS from x87/FX admission                      | typed admission reason           |
| omit WAIT's MP/TS gate                             | typed admission reason           |
| classify MMX/XMM bridges as plain MMX              | typed admission reason           |
| require OSFXSR for FX images                       | enabled FX reaches its operand   |
| report #XM with OSXMMEXCPT0                        | new numeric #UD reason           |
| clear RF at admission                              | pre-begin RF retained            |
| treat numeric-only edits as paging fences          | enabled return reuses owner      |
| retain pending compilation across host-control ABA | cancelled then fresh compilation |
| inherit numeric metadata on a secondary fault      | replaced source is None          |

All nine were killed. Source files and the built Wasm were restored byte-for-byte;
all nine public controls and the native secondary-source control passed afterward.
Restored Core SHA256:
`06c33fc6c3bd7dc5b944dbe384d93c34ff5043fa7004fe7099d02e4239ba625f`.
Raw logs/report: `/tmp/ring64-numeric-mutation-evidence/`.

## inactive-path structure and remaining measurements

Against the frozen baseline, scalar, direct-vector, floating-helper and MMX loops
produced byte-identical generated artifacts in both linear and IA32e profiles.
Imports, one compilation/native entry and20 checked retirements also matched.

| loop            | linear bytes/imports | IA32e bytes/imports |
| --------------- | -------------------- | ------------------- |
| scalar          | 746 /4               | 1205 /8             |
| direct vector   | 669 /4               | 1128 /8             |
| floating helper | 734 /5               | 1193 /9             |
| MMX             | 735 /4               | 1222 /8             |

The assertions compare artifact SHA256 and full import descriptors, not only sizes.
Raw structure observations are in the mutation-evidence directory's `structure.json`.
This establishes generated-body/import stability for those eight checked loops;
it does not establish unchanged engine latency or whole-application performance.
Paired Node/Chrome timing, forward/reverse/A-A controls and new fault/repair costs
remain pending a quiet integrated measurement run. No latency claim is made here.
README was not changed.
