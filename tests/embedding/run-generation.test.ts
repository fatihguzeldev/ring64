import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createCpu, type RunResult } from '../../host/index.js';
import { LIMITS, hex, initial } from '../support/fixture.js';

const compiler = await WebAssembly.compile(
  await readFile(new URL('../../build/ring64.wasm', import.meta.url)),
);

for (const operation of ['state', 'run'] as const) {
  test(`completed cached execution from ${operation} input rejects outer publication`, async () => {
    const cpu = await createCpu({
      compiler,
      code: { base: 0x1000n, bytes: hex('48ffc0ebfb') },
      ram: { base: 0x4000n, bytes: new Uint8Array(8) },
      limits: LIMITS,
    });
    let nested: Promise<RunResult> | undefined;
    try {
      cpu.setState(initial(0x1000n, { 0: 0n }));
      cpu.setXmmState(Array.from({ length: 16 }, (_, index) => BigInt(index + 1)));
      cpu.setMxcsr(0xffc5);
      const warm = await cpu.run({ budget: 2n });
      assert.equal(warm.resources.compilations, 1);
      assert.equal(warm.state.registers[0], 1n);
      assert.equal(warm.state.rip, 0x1000n);
      const context = cpu.readContext();
      const xmm = cpu.readXmmState();
      const x87 = cpu.readX87State();
      const owners = cpu.inspectTranslations();
      const start = () => {
        nested = cpu.run({ budget: 1n });
        // The warm entry finishes before this getter returns; phase alone is idle again.
        assert.equal(cpu.readState().registers[0], 2n);
        assert.equal(cpu.readState().rip, 0x1003n);
      };
      const input = initial(0x1000n, {}, 2n);
      const publish = () => {
        if (operation === 'state')
          return cpu.setState({
            ...input,
            interruptibility: {
              get sti() {
                start();
                return false;
              },
              ss: false,
            },
          });
        return cpu.run({
          get budget() {
            start();
            return 1n;
          },
        });
      };
      if (operation === 'run')
        await assert.rejects(publish() as Promise<RunResult>, /run.*capture/);
      else assert.throws(publish, /run.*capture/);
      assert.ok(nested);
      const result = await nested;
      assert.equal(result.resources.compilations, 0);
      assert.equal(result.retired, 1n);
      assert.equal(result.state.registers[0], 2n);
      assert.equal(result.state.rip, 0x1003n);
      assert.deepEqual(cpu.readState(), result.state);
      assert.deepEqual(cpu.readContext(), context);
      assert.deepEqual(cpu.readXmmState(), xmm);
      assert.deepEqual(cpu.readX87State(), x87);
      assert.equal(cpu.readMxcsr(), 0xffc5);
      assert.deepEqual(cpu.readMemory(0x4000n, 8), new Uint8Array(8));
      assert.deepEqual(cpu.inspectTranslations(), owners);
    } finally {
      await nested;
      cpu.dispose();
    }
  });
}
