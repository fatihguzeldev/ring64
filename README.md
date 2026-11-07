# ring64

an x86 and x86-64 cpu emulator for the browser

## development

requires node 22.12 or newer and rustup.

```sh
npm ci
npm run check
```

browser tests use installed chrome on macos. elsewhere, run `npx playwright install chromium` or set `RING64_BROWSER` to a browser executable.

## performance

after building, run the checked synthetic kernels in node or chrome:

```sh
npm run bench
npm run bench -- --browser
```

`--baseline /path/to/built/checkout` compares two builds with alternating sample order. `--iterations`, `--samples` and `--workloads` select the workload; `--help` lists the kernels. each sample checks registers, defined flags, XMM, MXCSR, memory, budgets and translation counts. JSON results in `build/verification` include build hashes, environment, first and later samples, phase timings and generated-code sizes.

timings exclude state setup and output checks. they include `run()` and its state snapshots; FP kernels also include the reset and loop instructions recorded in the results. throughput counts those guest instructions, or completed elements for REP. the budget-one kernel times each call separately and also records the elapsed wall time. these kernels measure private-memory long64 execution, not application performance or native CPU parity. CI runs a small sample to check the kernels; use longer local runs for timings.

## use

after `npm run build`, this node example executes one guest instruction. the same host module works in a browser with fetched compiler bytes. the runtime must support BigInt and standard fixed128 WebAssembly SIMD, including for scalar guests. `createCpu` checks SIMD support before allocating its Core and rejects unsupported runtimes with `TypeError`.

```js
import { readFile } from 'node:fs/promises';
import { createCpu } from './build/host/index.js';

const cpu = await createCpu({
  compiler: await readFile('build/ring64.wasm'),
  code: { base: 0x1000n, bytes: Uint8Array.of(0xb8, 1, 0, 0, 0) },
  ram: { base: 0x8000n, bytes: new Uint8Array(32) },
  limits: {
    maxInstructions: 128,
    maxSourceBytes: 2048,
    maxArtifactBytes: 262144,
    maxCachedArtifacts: 32,
    maxCachedBytes: 4194304,
    maxTranslationsPerRun: 32,
  },
});

try {
  const result = await cpu.run({ budget: 2n, stop: 0x1005n });
  console.log(result.reason, result.state.registers[0]); // stop, 1n
} finally {
  cpu.dispose();
}
```

`code` and `ram` create copied RX and RW mappings. for multiple regions or aliases, replace them with `memory: { backings, mappings }`, an explicit `entry` and `memoryLimits`. a backing owns bytes; mappings expose its slices at guest addresses with independent read, write and execute permissions. see the [memory contract](specs/memory-map-and-code-validity/spec.md) for the input types and limits.

while idle, `addBacking`, `removeBacking` and `setMappings` manage the layout. `setMappings` atomically replaces the whole table; remove a backing only after unmapping it. `readMemory` requires read permission and `writeMemory` requires write permission. writes through any alias invalidate affected translations, including when guest code changes its own instructions.

`context` defaults to long64 with zero FS and GS bases. it can also import real, virtual8086, protected or compatibility execution with loaded segment caches. `readContext()` returns a copy; idle `setContext(context)` replaces it, preserving registers, flags and RIP. a changed context invalidates translations. guest mode transitions are not implemented. see the [execution context contract](specs/mode-context-and-decoding/spec.md) for profile validation and supported instruction forms.

`readState()`, `setState()` and run results contain the GPR, flags and RIP projection. `readXmmState()` returns a fresh array of sixteen unsigned128-bit bigints; idle `setXmmState(bank)` replaces that complete bank. XMM registers start at zero. scalar state imports and context changes preserve them, including XMM8-15 in modes where guest instructions cannot address those registers. `readMxcsr()` returns SIMD control/status; idle `setMxcsr(value)` replaces its complete unsigned16-bit value. MXCSR starts at `0x1f80`; scalar/XMM imports and context changes preserve it. a complete checkpoint includes both register projections, MXCSR, context and memory.

RIP, entry points and stop addresses are logical CS offsets. memory mappings and host memory access use linear addresses. execution can return `segment-fault` with a `segmentFault` record; mapping and address faults use `fault`, which also names the selected segment. aligned SIMD memory operands can return `alignment-fault` with an `alignmentFault` record containing the instruction PC, segment, logical offset, translated address, width, access and required alignment.

legacy SSE/SSE2 floating-point instructions use guest MXCSR rounding, exception masks, DAZ and FTZ. an unmasked numeric condition returns resumable `simd-exception` with `simdException`, preserving the faulting instruction's destinations and RIP while publishing reportable MXCSR status. LDMXCSR reserved bits return `general-protection` with `generalProtectionFault`; other state remains unchanged. these outcomes export detected faults without entering a guest handler. see the [floating-point contract](specs/simd-floating-point-and-controls/spec.md) for selected forms and exact status rules.

memory strings support DF, CLD/STD and REP/REPE/REPNE. `run({ budget, repeatBudget })` counts retired instructions separately from completed repeated elements. `repeatBudget` defaults to `budget`; exhausting it during an unfinished REP returns `repeat-budget` at the same RIP with completed effects preserved. results include `repeatIterations` and `remainingRepeatBudget`. resuming uses the published state; [the string contract](specs/string-and-repeated-execution/spec.md) defines comparison flags, fault repair and code changes between elements.
