# port I/O and string I/O verification

Scalar IN/OUT and bare/REP INS/OUTS are implemented with synchronous captured providers, live task permissions and ordered external effects. Functional acceptance, independent public-runtime oracles and semantic mutations passed. The prior integrated gate is recorded below; the final post-optimization gate and paired performance results belong to the [five-spec integration report](../five-spec-integration/verification.md).

## production ownership and contracts

| owner                                                                                  | implemented responsibility                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [decoder](../../src/x86/decode/io.rs)                                                  | exact scalar/string forms, immediate8/DX ports, CS.D/66 widths, ignored Long64 REX.W, prefix/fetch frontiers and fixed implicit registers                                                                       |
| [task permission owner](../../src/x86/protection/io.rs)                                | live CPL/VM/IOPL bypass, loaded TR admission, exact two-byte map-base/permission reads, inclusive limits, selected masks and #GP/private provenance                                                             |
| [native effect bridge](../../src/embedding/exports/io.rs)                              | immutable provider presence, permission-before-provider ordering, source read before OUTS output, INS input before destination paging/private admission, and release of all Core/state borrows before callbacks |
| [host binding](../../host/io.ts), [Core](../../host/core.ts), [CPU](../../host/cpu.ts) | one-time receiver/callable capture, primitive result validation before Wasm coercion, execution/effect scope checks, terminal callback failure and lifecycle cleanup                                            |
| [scalar emitter](../../src/dbt/wasm/io.rs), [REP owner](../../src/dbt/wasm/strings.rs) | parent-register merges, completed index/count publication, retirement/allowances, debug boundaries and source-change redispatch                                                                                 |

The provider receives one unsigned full-width transaction per accepted attempt. It receives no guest pointer or mutable Core view. An INS input can be consumed before its destination #PF or private refusal; that failed element publishes no destination bytes/index/count progress, and retry consumes fresh input. OUTS reads its complete source before invoking output. Earlier completed elements survive either failure. No hidden continuation, automatic effect replay or cross-checkpoint exactly-once guarantee is introduced.

Permission decisions re-read the live bitmap for each attempted element; the preceding INS store may itself deny the next attempt. Implicit TSS traffic uses the current guest-memory family with supervisor provenance and no operand watchpoint. Bare forms leave count/repeat allowance alone. Zero-count and exhausted-repeat boundaries keep the inherited ordering, including allowance priority before source redispatch. Callback failure leaves the existing CPU failed; disposal releases host references without reentering an unwound native Core.

## functional acceptance and corrected callable invocation

The [shared registry](../../tests/execution/io/index.ts) contains **32 I/O scenarios**, executed through actual Core/generated Wasm in Node and Chrome. Their matrices cover all fourteen inherited mode/code/stack profiles, byte/word/dword transactions, immediate/DX selection, parent-register merges, REX/66 priority, FS/GS OUTS, fixed ES INS, address16/32/64 and DF, complete spans, bare/REP budgets, missing providers, terminal ports and mandatory permission-word bounds.

[Paged/source packets](../../tests/execution/io/paging.ts), [source-PTE rewrites](../../tests/execution/io/source-pte.ts) and [guest repair](../../tests/execution/io/review-repair.ts) verify supervisor TSS #PF provenance, late failed destinations, OUTS source refusal, code/table aliases and a literal #PF→OR PTE→INVLPG→IRETD repair. A private handler-fetch refusal preserves the already accepted frame and completed input history. [Debug packets](../../tests/execution/io/review-debug.ts) check RF, unfinished TF/data traps, inactive I/O comparators and durable SS-deferred causes after the external effect.

The independent source audit found a real callable-capture defect: using `binding.read.call(...)` or `binding.write.call(...)` reads the function's mutable `.call` property after capture. A valid provider could replace it or expose another getter. Commit `726c45a` switched both calls to `Reflect.apply`, retaining the captured function and original receiver. The [host regression](../../host/io.test.ts) and [public await/capture packet](../../tests/execution/io/review-lifecycle.ts) assert that an own `.call` getter is never inspected and later method replacement cannot redirect execution. Premature Core/generated-instantiation imports, caught same-CPU reentry, independent CPUs, malformed results and terminal cleanup have separate controls.

[Reset integration](../../tests/execution/io/reset.ts) executes physical PG0 input before and after reset through the same captured receiver. It checks that the external queue is neither rewound nor replaced, reset calls no device hooks, a reset during run-option capture rejects only the stale outer operation, the reset-vector fetch uses retained ROM, and reset during the callback rejects. CPU disposal reads no provider reset/dispose hook. These are CPU/provider lifetime checks, not a device reset implementation.

## independent arithmetic and permission oracle

The permanent [independent public I/O checker](../../scripts/check-io-independent-oracle.mjs) imports no production decoder, I/O semantic helper or shared execution fixture. Literal bytes and independently calculated integer masks/banks/traces/RAM images check **6,480 cases**: 336 cross-width/address/direction bare/partial/resumed string packets and 6,144 live permission packets, with 2,048 cases per width and seed `0x77384a21`. Assertions include callback counts on denied attempts, index/count merges, RF, exact completed progress, live map-base aliases, terminal masks and the beyond-port-space frontier.

The canonical completed report is `/tmp/ring64-independent-io-oracle-report.json` at clean source `36e010767f142e05c1e99dac105366b53515b779`; `/tmp/ring64-io-final-oracle.json` repeats all6,480 cases at clean `0980de0c4a9fdd42830d0f493c2b0437e5fecc81`. Both record Core SHA256 `2cc2e919193f9a93f68172b96efa316151478076b21177a09358ae827d2b24ed` and host SHA256 `a53183ac910c5c9d7a5195f46f1adeed67af5851513ff8dae41d95775b334b0e`. The checker freezes its own host/Core inputs and verifies their hashes afterward. This is public-Wasm literal/integer evidence, without native-hardware, arbitrary-provider or hidden physical-read instrumentation claims.

Reproduce against a built checkout with:

```sh
node scripts/check-io-independent-oracle.mjs --current . --output build/verification/io-independent-oracle.json
```

## adversarial audit and gate boundary

The [independent acceptance/mutation record](audit-verification.md) preserves the earlier audit snapshot, exact restore hash and named failure assertions. Its **13/13 semantic kills** distinguish INS private-preflight order, omitted OUTS reads, permission byte/word width, live denial, bare repeat charging, index publication, execution scope, captured methods and `.call`, code-source invalidation, REX/66 widths, durable SS history and unsigned dword output. Each counted mutation compiled and failed its unchanged intended assertion; a discarded unsupported-width panic was not counted. Sources and the Core artifact were restored exactly, followed by a complete positive gate.

The **prior integrated** `npm run check` passed formatting, lint, both Clippy targets, the release Core/TypeScript build, **849 native tests**, **237 Node tests**, and **941 shared Chrome157.0.8103.79 scenarios**. These are historical integrated-gate counts before the latest host-only numeric-source optimization/test, not the final gate for that later source. The [integration report](../five-spec-integration/verification.md) owns final counts, source/artifact identities, Chrome characterization smoke and quiet timing acceptance.

I/O characterization covers transaction widths, bare/REP progress, short resumes, bitmap bypass/deny, irreversible destination failures, source refusal and code/PTE aliases separately. New executable I/O has no successful predecessor denominator. Provider cost depends on the embedder; synthetic callbacks do not establish device, storage, networking, application or boot performance. Inactive-path overhead and matched inherited cohorts require the integrated paired controls rather than conclusions from test durations. README is outside this work.
