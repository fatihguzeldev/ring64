import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCpu } from '../../host/index.js';

const compiler = await readFile(new URL('../../build/ring64.wasm', import.meta.url));
const limits = {
  maxInstructions: 128,
  maxSourceBytes: 2048,
  maxArtifactBytes: 262144,
  maxCachedArtifacts: 32,
  maxCachedBytes: 4 * 1024 * 1024,
  maxTranslationsPerRun: 32,
};

test('the literal guest loop runs through generated wasm with exact state and resume', async () => {
  const code = Uint8Array.from(Buffer.from('b800000000b9030000004801c84883e90175f7488903', 'hex'));
  const initialMemory = Uint8Array.from(
    Buffer.from('1011121314151617a0a1a2a3a4a5a6a7f0f1f2f3f4f5f6f7', 'hex'),
  );
  const cpu = await createCpu({
    compiler,
    code: { base: 0x1000n, bytes: code },
    ram: { base: 0x100003ff8n, bytes: initialMemory },
    limits,
  });
  try {
    const registers = Array.from({ length: 16 }, (_, i) => 0x1122334400000000n + BigInt(i));
    registers[3] = 0x100004000n;
    cpu.setState({ registers, flags: 2n, rip: 0x1000n });
    const prefix = await cpu.run({ budget: 5n });
    assert.equal(prefix.reason, 'budget');
    assert.equal(prefix.retired, 5n);
    assert.equal(prefix.state.rip, 0x100an);
    assert.equal(prefix.state.registers[0], 3n);
    assert.equal(prefix.state.registers[1], 2n);
    assert.equal(prefix.state.flags, 2n);
    assert.deepEqual(cpu.readMemory(0x100003ff8n, 24), initialMemory);
    const result = await cpu.run({ budget: 8n, stop: 0x1016n });
    assert.equal(result.reason, 'stop');
    assert.equal(result.retired, 7n);
    assert.equal(result.remaining, 1n);
    assert.equal(result.state.rip, 0x1016n);
    assert.equal(result.state.registers[0], 6n);
    assert.equal(result.state.registers[1], 0n);
    assert.equal(result.state.flags, 0x46n);
    for (let i = 2; i < 16; i++) assert.equal(result.state.registers[i], registers[i]);
    assert.deepEqual(cpu.readMemory(0x100004000n, 8), Uint8Array.of(6, 0, 0, 0, 0, 0, 0, 0));
    assert.deepEqual(cpu.readMemory(0x100003ff8n, 8), initialMemory.slice(0, 8));
    assert.deepEqual(cpu.readMemory(0x100004008n, 8), initialMemory.slice(16));
  } finally {
    cpu.dispose();
  }
});
