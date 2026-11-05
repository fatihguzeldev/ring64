import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCpu } from '../../host/index.js';
import { Core } from '../../host/core.js';

const compiler = await WebAssembly.compile(
  new Uint8Array(await readFile(new URL('../../build/ring64.wasm', import.meta.url))),
);
const limits = {
  maxInstructions: 32,
  maxSourceBytes: 256,
  maxArtifactBytes: 65536,
  maxCachedArtifacts: 8,
  maxCachedBytes: 1048576,
  maxTranslationsPerRun: 8,
};

function options() {
  return {
    compiler,
    code: { base: 0x1000n, bytes: Uint8Array.of(0xb8, 1, 0, 0, 0) },
    ram: { base: 0x8000n, bytes: Uint8Array.of(1, 2, 3, 4) },
    limits,
  };
}

test('creation snapshots validated span bases before asynchronous browser work', async () => {
  const input = options();
  const pending = createCpu(input);
  input.code.base = 0x2000n;
  input.ram.base = 0x9000n;
  const cpu = await pending;
  try {
    assert.equal(cpu.readState().rip, 0x1000n);
    assert.deepEqual(cpu.readMemory(0x8000n, 4), Uint8Array.of(1, 2, 3, 4));
    assert.equal((await cpu.run({ budget: 2n, stop: 0x1005n })).reason, 'stop');
  } finally {
    cpu.dispose();
  }
});

test('disposal settles host ownership even if core cleanup throws', async () => {
  const cpu = await createCpu(options());
  const dispose = Core.prototype.dispose;
  Core.prototype.dispose = () => {
    throw new Error('cleanup rejected');
  };
  try {
    assert.throws(() => cpu.dispose(), /cleanup rejected/);
    assert.throws(() => cpu.readState(), /disposed/);
    assert.doesNotThrow(() => cpu.dispose());
  } finally {
    Core.prototype.dispose = dispose;
    cpu.dispose();
  }
});
