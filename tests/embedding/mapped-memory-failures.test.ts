import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createCpu } from '../../host/index.js';
import { Core } from '../../host/core.js';
import { LIMITS, initial } from '../support/fixture.js';

const compiler = await WebAssembly.compile(
  new Uint8Array(await readFile(new URL('../../build/ring64.wasm', import.meta.url))),
);

for (const operation of ['readMemory', 'readState', 'setState'] as const) {
  test(`unexpected core trap during ${operation} leaves disposal as the only operation`, async () => {
    const cpu = await createCpu({
      compiler,
      code: { base: 0x1000n, bytes: Uint8Array.of(0xb8, 1, 0, 0, 0) },
      ram: { base: 0x8000n, bytes: Uint8Array.of(1, 2, 3, 4) },
      limits: LIMITS,
    });
    const readMemory = Core.prototype.readMemory;
    const snapshot = Core.prototype.snapshot;
    const setState = Core.prototype.setState;
    const trap = () => {
      throw new WebAssembly.RuntimeError('injected core trap');
    };
    if (operation === 'readMemory') Core.prototype.readMemory = trap;
    else if (operation === 'readState') Core.prototype.snapshot = trap;
    else Core.prototype.setState = trap;
    try {
      const action =
        operation === 'readMemory'
          ? () => cpu.readMemory(0x8000n, 1)
          : operation === 'readState'
            ? () => cpu.readState()
            : () => cpu.setState(initial());
      assert.throws(action, /cpu engine failed/);
      assert.throws(() => cpu.readState(), /failed/);
      assert.throws(() => cpu.readMemory(0x8000n, 1), /failed/);
      assert.throws(() => cpu.setState(initial()), /failed/);
      assert.throws(() => cpu.addBacking({ id: 'extra', bytes: Uint8Array.of(1) }), /failed/);
      assert.throws(() => cpu.setMappings([]), /failed/);
      assert.throws(() => cpu.inspectTranslations(), /failed/);
      await assert.rejects(cpu.run({ budget: 0n }), /failed/);
    } finally {
      Core.prototype.readMemory = readMemory;
      Core.prototype.snapshot = snapshot;
      Core.prototype.setState = setState;
      cpu.dispose();
    }
    assert.doesNotThrow(() => cpu.dispose());
  });
}

test('malformed mapping array counts reject atomically instead of unmapping live code', async () => {
  const bytes = Uint8Array.of(0xb8, 1, 0, 0, 0);
  const cpu = await createCpu({
    compiler,
    code: { base: 0x1000n, bytes },
    ram: { base: 0x8000n, bytes: Uint8Array.of(1, 2, 3, 4) },
    limits: LIMITS,
  });
  try {
    cpu.setState(initial());
    assert.equal((await cpu.run({ budget: 1n })).reason, 'budget');
    const state = cpu.readState();
    const translations = cpu.inspectTranslations();
    for (const count of [NaN, -1, '0', 0n, Infinity, 0.5, undefined, null, false, 0x100000000]) {
      const mappings = new Proxy([], {
        get(target, property, receiver) {
          if (property === 'length') return count;
          return Reflect.get(target, property, receiver) as unknown;
        },
      });
      assert.throws(() => cpu.setMappings(mappings), TypeError);
      assert.deepEqual(cpu.readState(), state);
      assert.deepEqual(cpu.inspectTranslations(), translations);
      assert.deepEqual(cpu.readMemory(0x1000n, 5), bytes);
    }
    cpu.setState(initial());
    const resumed = await cpu.run({ budget: 1n });
    assert.equal(resumed.reason, 'budget');
    assert.equal(resumed.state.registers[0], 1n);
    assert.equal(resumed.resources.compilations, 0);
  } finally {
    cpu.dispose();
  }
});
