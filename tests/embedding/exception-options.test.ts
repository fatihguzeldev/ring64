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

for (const alias of ['eventDelivery', 'exceptionDelivery'] as const) {
  test(`${alias} capture reads its selected properties once before run admission`, async () => {
    const value = await cpu();
    try {
      let optionReads = 0,
        budgetReads = 0;
      const before = value.readState();
      const result = await value.run({
        budget: 0n,
        get [alias]() {
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
      const omitted = await value.run({ budget: 0n, [alias]: undefined });
      assert.equal(omitted.deliveryAttempts, undefined);
      assert.equal(omitted.remainingDeliveryBudget, undefined);
    } finally {
      value.dispose();
    }
  });

  test(`malformed ${alias} publishes no state memory or artifact changes`, async () => {
    const value = await cpu();
    try {
      value.setState(initial(0x1000n, { 0: 3n }, 2n));
      await value.run({ budget: 2n });
      const before = value.readState();
      const owners = value.inspectTranslations();
      for (const delivery of [
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
          value.run({ budget: 1n, [alias]: delivery as { budget: bigint } }),
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

  for (const field of ['option', 'budget'] as const) {
    test(`a completed cached run during ${alias} ${field} capture rejects the outer run`, async () => {
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
            get [alias]() {
              if (field === 'option') start();
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
}

test('conflicting delivery aliases reject before nested budgets are read or queues are consumed', async () => {
  const value = await cpu();
  try {
    value.requestInterrupt(13);
    value.requestNmi();
    const before = value.readState();
    let reads = 0;
    const delivery = {
      get budget() {
        reads++;
        return 1n;
      },
    };
    await assert.rejects(
      value.run({ budget: 1n, eventDelivery: delivery, exceptionDelivery: delivery }),
      /mutually exclusive/,
    );
    assert.equal(reads, 0);
    assert.deepEqual(value.readState(), before);
    assert.deepEqual(value.inspectTranslations(), []);
    const admitted = await value.run({
      budget: 0n,
      eventDelivery: { budget: 1n },
      exceptionDelivery: undefined,
    });
    assert.equal(admitted.reason, 'budget');
    assert.equal(admitted.deliveryAttempts, 0n);
    assert.deepEqual(admitted.state, before);
  } finally {
    value.dispose();
  }
});
