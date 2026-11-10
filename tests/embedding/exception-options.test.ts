import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createCpu, type RunResult } from '../../host/index.js';
import { LIMITS, hex, initial } from '../support/fixture.js';

const compiler = await WebAssembly.compile(
  await readFile(new URL('../../build/ring64.wasm', import.meta.url)),
);

async function cpu() {
  return createCpu({
    compiler,
    code: { base: 0x1000n, bytes: hex('48ffc0ebfb') },
    ram: { base: 0x8000n, bytes: new Uint8Array(32) },
    limits: LIMITS,
  });
}

test('delivery option capture reads its selected properties once before run admission', async () => {
  const value = await cpu();
  try {
    let optionReads = 0,
      budgetReads = 0;
    const before = value.readState();
    const result = await value.run({
      budget: 0n,
      get exceptionDelivery() {
        optionReads++;
        return {
          get budget() {
            budgetReads++;
            return 7n;
          },
        };
      },
    });
    assert.equal(optionReads, 1);
    assert.equal(budgetReads, 1);
    assert.equal(result.reason, 'budget');
    assert.equal(result.deliveryAttempts, 0n);
    assert.equal(result.remainingDeliveryBudget, 7n);
    assert.deepEqual(result.state, before);
    const omitted = await value.run({ budget: 0n, exceptionDelivery: undefined });
    assert.equal(omitted.deliveryAttempts, undefined);
    assert.equal(omitted.remainingDeliveryBudget, undefined);
  } finally {
    value.dispose();
  }
});

test('malformed delivery options publish no state memory or artifact changes', async () => {
  const value = await cpu();
  try {
    value.setState(initial(0x1000n, { 0: 3n }, 2n));
    await value.run({ budget: 2n });
    const before = value.readState();
    const owners = value.inspectTranslations();
    for (const exceptionDelivery of [
      null,
      [],
      0,
      () => 0,
      {},
      { budget: undefined },
      { budget: 0 },
      { budget: -1n },
      { budget: 1n << 64n },
    ]) {
      await assert.rejects(
        value.run({ budget: 1n, exceptionDelivery: exceptionDelivery as { budget: bigint } }),
        TypeError,
      );
      assert.deepEqual(value.readState(), before);
      assert.deepEqual(value.inspectTranslations(), owners);
      assert.deepEqual(value.readMemory(0x8000n, 32), new Uint8Array(32));
    }
  } finally {
    value.dispose();
  }
});

for (const field of ['exceptionDelivery', 'budget'] as const) {
  test(`a completed cached run during ${field} capture rejects the outer delivery run`, async () => {
    const value = await cpu();
    let nested: Promise<RunResult> | undefined;
    try {
      value.setState(initial(0x1000n, { 0: 0n }, 2n));
      await value.run({ budget: 2n });
      const start = () => {
        nested = value.run({ budget: 1n });
        assert.equal(value.readState().registers[0], 2n);
      };
      const delivery = {
        get budget() {
          if (field === 'budget') start();
          return 1n;
        },
      };
      await assert.rejects(
        value.run({
          budget: 1n,
          get exceptionDelivery() {
            if (field === 'exceptionDelivery') start();
            return delivery;
          },
        }),
        /run.*capture/,
      );
      assert.ok(nested);
      const result = await nested;
      assert.equal(result.retired, 1n);
      assert.equal(result.resources.compilations, 0);
      assert.equal(result.state.rip, 0x1003n);
      assert.deepEqual(value.readState(), result.state);
      assert.equal(result.deliveryAttempts, undefined);
    } finally {
      await nested;
      value.dispose();
    }
  });
}
