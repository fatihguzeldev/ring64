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
