import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createCpu, type MemoryMapping } from '../../host/index.js';
import { LIMITS, changed, initial } from '../support/fixture.js';

const compiler = await WebAssembly.compile(
  new Uint8Array(await readFile(new URL('../../build/ring64.wasm', import.meta.url))),
);

test('backing identities preserve exact UTF-16 names through creation mutation and recreation', async () => {
  // These include unpaired surrogates and strings resembling a transport encoding.
  const names = ['\ud800', '\udc00', '😀', 'd800', '\\ud800', '0041', 'A'];
  const code = (value: number) => Uint8Array.of(0xb8, value, 0, 0, 0);
  const maps: MemoryMapping[] = names.map((backing, index) => ({
    base: 0x1000n + BigInt(index * 0x100),
    backing,
    offset: 0,
    length: 5,
    permissions: { read: true, write: false, execute: true },
  }));
  const cpu = await createCpu({
    compiler,
    memory: {
      backings: names.map((id, index) => ({ id, bytes: code(index + 1) })),
      mappings: maps,
    },
    entry: 0x1000n,
    memoryLimits: { maxBackings: 7, maxMappings: 7, maxBackingBytes: 35 },
    limits: LIMITS,
  });
  try {
    for (const [index, mapping] of maps.entries()) {
      const input = initial(mapping.base, {}, 0x8d7n);
      cpu.setState(input);
      const result = await cpu.run({ budget: 1n });
      assert.equal(result.reason, 'budget');
      assert.deepEqual(result.state, changed(input, mapping.base + 5n, { 0: BigInt(index + 1) }));
      assert.deepEqual(cpu.readMemory(mapping.base, 5), code(index + 1));
    }
    assert.equal(cpu.inspectTranslations().length, names.length);
    cpu.setMappings([]);
    assert.deepEqual(cpu.inspectTranslations(), []);
    for (const id of names) cpu.removeBacking(id);
    for (const [index, id] of names.entries()) cpu.addBacking({ id, bytes: code(index + 21) });
    cpu.setMappings([...maps].reverse());
    for (const [index, mapping] of maps.entries()) {
      const input = initial(mapping.base);
      cpu.setState(input);
      const result = await cpu.run({ budget: 1n });
      assert.equal(result.resources.compilations, 1);
      assert.deepEqual(result.state, changed(input, mapping.base + 5n, { 0: BigInt(index + 21) }));
      assert.deepEqual(cpu.readMemory(mapping.base, 5), code(index + 21));
    }
  } finally {
    cpu.dispose();
  }
});
