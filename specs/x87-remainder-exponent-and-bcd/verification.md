# x87 special-form verification

Functional implementation and verification on `x87-remainder-exponent-bcd`, based on `e00a41875c54798a554f7c30864e784e569df10d`. The completed source gate below ran at `036c1ec`; later verification-only changes do not change its Wasm. Final integrated conformance, independent oracles, cross-review and quiet performance observations are recorded in the [integration report](../five-spec-integration/verification.md).

## implemented boundary

FPREM, FPREM1, FSCALE, FXTRACT, FBLD and FBSTP now pass through selected decoding, checked operation transport, raw80 evaluation, physical stack/status publication and generated execution. The private word uses six kind bits and thirty total bits; BCD is a separate numeric format using load/store ownership. Public state offsets and the generated five-argument entry remain unchanged.

Remainders use bounded integer division, with one selected `N=32+(D mod32)` partial step per instruction. Scale/extract retain all64 significand bits. BCD rounds before the eighteen-digit range check; unmasked precision commits store/pop, while invalid conversion suppresses them. Operand A writes can report source invalidation even for reads or suppressed stores; existing paged completion owns subsequent redispatch without extra default emitter work.

## completed gate

`npm run check` passed after restoring exact sources from mutation experiments:

| check                                            | result                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| formatting, TypeScript, lint, native/Wasm Clippy | passed                                                             |
| native tests                                     | 814 passed, 0 failed                                               |
| Node tests                                       | 225 passed, 0 failed                                               |
| shared Chrome scenarios                          | 837 passed, 0 failed                                               |
| browser                                          | Chrome157.0.8103.79, headless                                      |
| Core Wasm                                        | 1,123,822 bytes                                                    |
| Core SHA256                                      | `e2c2bb3d7f2e0317f034cacdb768d8ce41567c9e7ec3824d80265d8eb338b43f` |

Environment: rustc1.97.1 (`8bab26f4f`), cargo1.97.1 (`c980f4866`), Node25.9.0, TypeScript7.0.2 and Playwright1.64.1. Generated browser evidence is `build/verification/browser.json`; build artifacts are not committed. The previous public negative fixture used FPREM as unsupported; it now checks pending detection for all six admitted forms and keeps deferred `d9f9` as its unsupported control.

## independent correctness evidence

[Native special-form fixtures](../../src/x86/x87/special_tests.rs) use literal raw80/status/BCD results, all64 exception-mask combinations, every TOP/occupancy, all PC/RC/sign combinations for BCD precision publication, massive scale cases, normalized subnormal exponents and partial-zero C2. Exact literal quotient/partial results are independent of the production implementation. A separately implemented `rustc_apfloat` reference corroborates completed remainder values for256 signed raw80 operand pairs; it does not supply quotient flags, stack/exception expectations or the partial-step profile. Those comparisons reached completion within1026 guest instructions across the selected exponent extremes.

[Generated public packets](../../tests/execution/x87/specials.ts) execute all six forms in every14 inherited mode/code/stack profile and check unrelated scalar/XMM/MXCSR banks. They verify raw partial checkpoints and committed unmasked BCD precision followed by a distinct WAIT boundary. [Memory packets](../../tests/execution/x87/special-memory.ts) check missing ten-byte tails1–9, A-bit aliases modifying a successor immediate for FBLD and suppressed FBSTP, and dirty-metadata refusal preserving the complete incoming numeric image. [Guest image packets](../../tests/execution/x87/special-images.ts) save a partial remainder through FNSAVE/FRSTOR and FXSAVE64/FNINIT/FXRSTOR64 before completing it. These shared packets ran in Node and Chrome.

Native bridge regression was first observed returning0 where a completed A-alias change required2, then passed after removing the payload-store-only predicate. Public source refetch also remains covered by the existing paged completion owner; this does not claim a new default per-instruction observer.

## semantic falsification

Eighteen temporary production mutations each failed an unchanged semantic assertion at its intended native or generated consumer:

| mutation group | killed distinctions                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| remainder      | wrong quotient rounding; fixed N63; quotient-bit permutation; wrong ST(1) source; raw rather than normalized exponent difference                        |
| scale/extract  | PC-sensitive result; missing massive overflow adjustment; swapped extract results; unchecked occupied push slot                                         |
| decimal        | BCD interpreted as raw80; sign loss; width8 instead of10; unmasked invalid incorrectly stores/pops; unmasked precision incorrectly suppresses store/pop |
| boundaries     | BCD bypasses pending detection; source-change exit depends only on payload store; five-bit kind collision; unconditional GPR reload after helper        |

Each experiment compiled and reached its named semantic fixture. The generated GPR mutation failed the Node `deepStrictEqual` result comparison; it was not counted as a generic subprocess failure. Compile errors, empty filters and unrelated crashes were excluded. Each mutated file was restored byte-for-byte, followed by the complete clean gate above. Temporary scripts/results are under `/tmp/ring64-five-x87-mutations*`; permanent expected results remain with their semantic test owners.

## measurement ceiling

No latency, throughput, heap-retention or application-performance conclusion is drawn from concurrent builds or test durations. The frozen predecessor is `/tmp/ring64-five-baseline` at `e00a418`. New forms have no executable predecessor denominator. The [integration report](../five-spec-integration/verification.md) records balanced/reversed/A-A inherited comparisons and candidate-only new-form characterization, with their measurement limits. Widened operation immediates may change LEB/generated-byte lengths; no byte-identical-body claim is made.

README was not edited. No push was performed from this isolated branch; root integration owns final all-five review and delivery.
