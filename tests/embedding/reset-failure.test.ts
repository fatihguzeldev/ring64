import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Core } from '../../host/core.js';
import { physicalCpu } from '../execution/reset/fixture.js';

test('a trap while releasing reset owners leaves the existing CPU failed', async () => {
  const compiler = await WebAssembly.compile(
    await readFile(new URL('../../build/ring64.wasm', import.meta.url)),
  );
  const rom = new Uint8Array(0x10000);
  rom[0xfff0] = 0x90;
  const cpu = await physicalCpu(compiler, new Uint8Array(0x10000), rom);
  const release = Core.prototype.release;
  try {
    await cpu.run({ budget: 1n });
    assert.equal(cpu.inspectTranslations().length > 0, true);
    Core.prototype.release = () => {
      throw new Error('native release trap');
    };
    assert.throws(() => cpu.reset(), /cpu engine failed/);
    assert.throws(() => cpu.readState(), /cpu is failed/);
    assert.throws(() => cpu.reset(), /cpu is failed/);
  } finally {
    Core.prototype.release = release;
    cpu.dispose();
  }
});
