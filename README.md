# ring64

an x86 and x86-64 cpu emulator for the browser

## development

requires node 22.12 or newer and rustup.

```sh
npm ci
npm run check
```

browser tests use installed chrome on macos. elsewhere, run `npx playwright install chromium` or set `RING64_BROWSER` to a browser executable.

## use

after `npm run build`, this node example executes one guest instruction. the same host module works in a browser with fetched compiler bytes.

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
