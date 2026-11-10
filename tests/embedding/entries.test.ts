import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createCpu } from '../../host/index.js';
import type { State } from '../../host/index.js';

const compiler = await WebAssembly.compile(
  new Uint8Array(await readFile(new URL('../../build/ring64.wasm', import.meta.url))),
);
const CODE = 0x1000n;
const RAM = 0x8000n;
const limits = {
  maxInstructions: 32,
  maxSourceBytes: 256,
  maxArtifactBytes: 65536,
  maxCachedArtifacts: 8,
  maxCachedBytes: 1048576,
  maxTranslationsPerRun: 8,
};

function state(rip: bigint): State {
  return {
    registers: Array.from({ length: 16 }, (_, index) => 0x1122334400000000n + BigInt(index)),
    flags: 0x8d7n,
    rip,
    interruptibility: { sti: false, ss: false },
    event: { kind: 'ready' },
  };
}

test('the first requested entry can follow a lower discovered entry in the same artifact', async () => {
  const cpu = await createCpu({
    compiler,
    code: { base: CODE, bytes: Uint8Array.of(0xb8, 0x11, 0, 0, 0, 0xeb, 0xf9) },
    ram: { base: RAM, bytes: new Uint8Array(8) },
    limits,
  });
  try {
    const input = state(CODE + 5n);
    cpu.setState(input);
    const first = await cpu.run({ budget: 1n });
    assert.equal(first.reason, 'budget');
    assert.equal(first.retired, 1n);
    assert.equal(first.remaining, 0n);
    assert.equal(first.resources.compilations, 1);
    assert.equal(first.resources.nativeEntries, 1);
    assert.deepEqual(first.state, { ...input, rip: CODE });
    assert.deepEqual(cpu.inspectTranslations()[0]!.entries, [CODE, CODE + 5n]);

    const resumed = await cpu.run({ budget: 1n });
    const expected = state(CODE + 5n);
    expected.registers[0] = 0x11n;
    assert.equal(resumed.reason, 'budget');
    assert.equal(resumed.retired, 1n);
    assert.equal(resumed.remaining, 0n);
    assert.equal(resumed.resources.compilations, 0);
    assert.deepEqual(resumed.state, expected);
    assert.deepEqual(cpu.readMemory(RAM, 8), new Uint8Array(8));
  } finally {
    cpu.dispose();
  }
});

test('a cached middle entry imports fresh state and executes only its resumed suffix', async () => {
  const cpu = await createCpu({
    compiler,
    code: {
      base: CODE,
      bytes: Uint8Array.of(0xb8, 1, 0, 0, 0, 0xb9, 2, 0, 0, 0, 0xba, 3, 0, 0, 0),
    },
    ram: { base: RAM, bytes: new Uint8Array(8) },
    limits,
  });
  try {
    cpu.setState(state(CODE));
    const first = await cpu.run({ budget: 1n });
    assert.equal(first.resources.compilations, 1);
    assert.deepEqual(cpu.inspectTranslations()[0]!.entries, [CODE, CODE + 5n, CODE + 10n]);

    const input = state(CODE + 5n);
    cpu.setState(input);
    const middle = await cpu.run({ budget: 1n });
    const expected = state(CODE + 10n);
    expected.registers[1] = 2n;
    assert.equal(middle.reason, 'budget');
    assert.equal(middle.retired, 1n);
    assert.equal(middle.remaining, 0n);
    assert.equal(middle.resources.compilations, 0);
    assert.equal(middle.resources.cacheHits, 1);
    assert.deepEqual(middle.state, expected);

    const suffix = await cpu.run({ budget: 1n });
    expected.registers[2] = 3n;
    expected.rip = CODE + 15n;
    assert.equal(suffix.reason, 'budget');
    assert.equal(suffix.retired, 1n);
    assert.equal(suffix.remaining, 0n);
    assert.equal(suffix.resources.compilations, 0);
    assert.deepEqual(suffix.state, expected);
    assert.deepEqual(cpu.readMemory(RAM, 8), new Uint8Array(8));
  } finally {
    cpu.dispose();
  }
});
