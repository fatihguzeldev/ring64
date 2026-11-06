import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createCpu, type MemoryMapping, type Options } from '../../host/index.js';
import { LIMITS, hex } from '../support/fixture.js';
import { BASE, RW, RX, input, mapping } from '../execution/mapped-memory/fixture.js';

const compiler = await WebAssembly.compile(
  new Uint8Array(await readFile(new URL('../../build/ring64.wasm', import.meta.url))),
);

function options() {
  return {
    compiler,
    memory: {
      backings: [{ id: '__proto__', bytes: hex('b801000000') }],
      mappings: [mapping(BASE, '__proto__', 5, RX)],
    },
    entry: BASE,
    memoryLimits: { maxBackings: 4, maxMappings: 8, maxBackingBytes: 1024 },
    limits: LIMITS,
  };
}

const unchecked = (value: unknown) => value as Options;

test('mapped creation admits empty layouts and validates constructor forms before fetch', async () => {
  const source = options();
  const legacy = {
    compiler,
    code: { base: BASE, bytes: hex('b801000000') },
    ram: { base: 0x4000n, bytes: hex('a5') },
    limits: LIMITS,
  };
  for (const malformed of [
    { ...source, code: legacy.code },
    { ...source, ram: legacy.ram },
    { ...legacy, entry: BASE },
    { ...legacy, memory: source.memory },
    { ...source, memoryLimits: undefined },
    { ...source, entry: undefined },
    { ...legacy, ram: undefined },
  ])
    await assert.rejects(createCpu(unchecked(malformed)), TypeError);
  const cpu = await createCpu({
    ...source,
    memory: { backings: [], mappings: [] },
    entry: 0x800000000000n,
  });
  try {
    assert.equal(cpu.readState().rip, 0x800000000000n);
    assert.equal((await cpu.run({ budget: 0n })).reason, 'budget');
    assert.equal((await cpu.run({ budget: 1n, stop: 0x800000000000n })).reason, 'stop');
    const reached = await cpu.run({ budget: 1n });
    assert.equal(reached.reason, 'fetch-fault');
    assert.equal(reached.fault?.cause, 'noncanonical');
  } finally {
    cpu.dispose();
  }
});

test('memory capacity groups reject malformed fields and legacy defaults bound expansion', async () => {
  for (const name of ['maxBackings', 'maxMappings', 'maxBackingBytes'] as const) {
    for (const value of [0, -1, 1.5, NaN, Infinity, 0x100000000, undefined]) {
      const source = options();
      await assert.rejects(
        createCpu(
          unchecked({ ...source, memoryLimits: { ...source.memoryLimits, [name]: value } }),
        ),
        TypeError,
      );
    }
  }
  const cpu = await createCpu({
    compiler,
    code: { base: BASE, bytes: hex('b801000000') },
    ram: { base: 0x4000n, bytes: hex('a5') },
    limits: LIMITS,
  });
  try {
    assert.throws(() => cpu.addBacking({ id: 'third', bytes: Uint8Array.of(1) }), RangeError);
    cpu.setMappings([]);
    cpu.removeBacking('ram');
    cpu.addBacking({ id: 'third', bytes: Uint8Array.of(1) });
    assert.throws(
      () =>
        cpu.setMappings([
          mapping(BASE, 'code', 1, RX),
          mapping(BASE + 1n, 'code', 1, RX, 1),
          mapping(BASE + 2n, 'code', 1, RX, 2),
        ]),
      RangeError,
    );
    cpu.setMappings([mapping(BASE, 'code', 5, RX), mapping(0x4000n, 'third', 1, RW)]);
    assert.deepEqual(cpu.readMemory(0x4000n, 1), Uint8Array.of(1));
  } finally {
    cpu.dispose();
  }
});

test('memory capacities reject oversized input before indexed capture and allocation', async () => {
  const source = options();
  const over = Array<MemoryMapping>(9);
  Object.defineProperty(over, 0, {
    get() {
      throw new Error('oversized table must not be captured');
    },
  });
  await assert.rejects(
    createCpu({ ...source, memory: { ...source.memory, mappings: over } }),
    RangeError,
  );
  const cpu = await createCpu(source);
  try {
    assert.throws(() => cpu.setMappings(over), RangeError);
    const original = cpu.readState();
    const tooManyBytes = new Uint8Array(1025);
    assert.throws(() => cpu.addBacking({ id: 'large', bytes: tooManyBytes }), RangeError);
    assert.deepEqual(cpu.readState(), original);
    assert.deepEqual(cpu.readMemory(BASE, 5), hex('b801000000'));
    assert.throws(() => cpu.removeBacking('large'), TypeError);
  } finally {
    cpu.dispose();
  }
});

test('rejected table and backing mutations retain bytes cache state and logical capacity', async () => {
  const cpu = await createCpu(options());
  try {
    const initial = input();
    cpu.setState(initial);
    await cpu.run({ budget: 1n });
    const state = cpu.readState();
    const cache = cpu.inspectTranslations();
    for (const action of [
      () => cpu.removeBacking('__proto__'),
      () => cpu.removeBacking('missing'),
      () => cpu.addBacking({ id: '__proto__', bytes: hex('00') }),
      () => cpu.addBacking({ id: '', bytes: hex('00') }),
      () => cpu.addBacking({ id: 'empty', bytes: new Uint8Array() }),
      () => cpu.setMappings([mapping(BASE, 'missing', 1, RW)]),
      () => cpu.setMappings([mapping(BASE, '__proto__', 1, RX), mapping(BASE, '__proto__', 1, RW)]),
      () => cpu.setMappings([mapping(BASE, '__proto__', 2, RX, 4)]),
      () => cpu.setMappings([mapping(0xffffffffffffffffn, '__proto__', 2, RX)]),
      () =>
        cpu.setMappings([mapping(BASE, '__proto__', 1, { ...RW, read: 1 as unknown as boolean })]),
    ]) {
      assert.throws(action, TypeError);
      assert.deepEqual(cpu.readState(), state);
      assert.deepEqual(cpu.inspectTranslations(), cache);
      assert.deepEqual(cpu.readMemory(BASE, 5), hex('b801000000'));
    }
    cpu.addBacking({ id: 'data', bytes: new Uint8Array(1019) });
    assert.throws(() => cpu.addBacking({ id: 'extra', bytes: Uint8Array.of(1) }), RangeError);
    cpu.removeBacking('data');
    cpu.addBacking({ id: 'extra', bytes: Uint8Array.of(1) });
    cpu.setMappings([
      mapping(BASE, '__proto__', 5, RX),
      mapping(0x4000n, 'extra', 1, RW),
      mapping(0x5000n, 'extra', 1, RW),
    ]);
    cpu.writeMemory(0x4000n, Uint8Array.of(7));
    assert.deepEqual(cpu.readMemory(0x5000n, 1), Uint8Array.of(7));
  } finally {
    cpu.dispose();
  }
});

test('mapped inputs and nested translation snapshots retain no caller aliases', async () => {
  const source = options();
  const pending = createCpu(source);
  source.memory.backings[0]!.bytes.fill(0x90);
  source.memory.mappings[0]!.permissions.execute = false;
  source.memory.mappings[0]!.base = 0x9000n;
  source.memoryLimits.maxBackingBytes = 1;
  const cpu = await pending;
  try {
    cpu.setState(input());
    const result = await cpu.run({ budget: 1n });
    assert.equal(result.state.registers[0], 1n);
    const snapshot = cpu.inspectTranslations();
    const expected = structuredClone(snapshot);
    function damage(value: unknown): void {
      if (Array.isArray(value)) {
        for (const item of value) damage(item);
        value.reverse();
      } else if (value && typeof value === 'object')
        for (const key of Object.keys(value)) {
          const record = value as Record<string, unknown>;
          if (typeof record[key] === 'bigint') record[key] = 0n;
          else if (typeof record[key] === 'number') record[key] = 0;
          else if (typeof record[key] === 'string') record[key] = 'changed';
          else damage(record[key]);
        }
    }
    damage(snapshot);
    assert.deepEqual(cpu.inspectTranslations(), expected);
    cpu.addBacking({ id: 'copied', bytes: hex('1234') });
    const maps = [mapping(BASE, '__proto__', 5, RX), mapping(0x4000n, 'copied', 2, RW)];
    cpu.setMappings(maps);
    maps[1]!.permissions.read = false;
    maps[1]!.offset = 100;
    assert.deepEqual(cpu.readMemory(0x4000n, 2), hex('1234'));
  } finally {
    cpu.dispose();
  }
});

test('mapped host mutation rechecks lifecycle after accessor callbacks', async () => {
  for (const operation of ['add', 'maps'] as const) {
    const cpu = await createCpu(options());
    let pending: ReturnType<typeof cpu.run> | undefined;
    cpu.setState(input());
    try {
      if (operation === 'add') {
        const value = {
          id: 'data',
          get bytes() {
            pending = cpu.run({ budget: 1n });
            return Uint8Array.of(7);
          },
        };
        assert.throws(() => cpu.addBacking(value), /running/);
      } else {
        const value = mapping(BASE, '__proto__', 5, RX);
        Object.defineProperty(value, 'base', {
          get() {
            pending = cpu.run({ budget: 1n });
            return BASE;
          },
        });
        assert.throws(() => cpu.setMappings([value]), /running/);
      }
      assert.ok(pending);
      await pending;
      assert.throws(() => cpu.removeBacking('data'), TypeError);
      assert.deepEqual(cpu.readMemory(BASE, 5), hex('b801000000'));
    } finally {
      await pending;
      cpu.dispose();
    }
  }
  const disposed = await createCpu(options());
  assert.throws(
    () =>
      disposed.addBacking({
        id: 'data',
        get bytes() {
          disposed.dispose();
          return Uint8Array.of(1);
        },
      }),
    /disposed/,
  );
});

test('mapped storage growth preserves existing aliases state and retained code', async () => {
  const cpu = await createCpu({
    ...options(),
    memoryLimits: { maxBackings: 8, maxMappings: 16, maxBackingBytes: 32 * 1024 * 1024 },
  });
  try {
    const initial = input();
    cpu.setState(initial);
    await cpu.run({ budget: 1n });
    cpu.addBacking({ id: 'grow', bytes: new Uint8Array(16 * 1024 * 1024).fill(0x5a) });
    cpu.setMappings([
      mapping(BASE, '__proto__', 5, RX),
      mapping(0x4000n, '__proto__', 5, RW),
      mapping(0x100000000n, 'grow', 16 * 1024 * 1024, RW),
    ]);
    assert.deepEqual(cpu.readMemory(0x4000n, 5), hex('b801000000'));
    assert.deepEqual(cpu.readMemory(0x100ffffffn, 1), Uint8Array.of(0x5a));
    cpu.setState(initial);
    const retained = await cpu.run({ budget: 1n });
    assert.equal(retained.resources.compilations, 0);
    assert.equal(retained.state.registers[0], 1n);
    cpu.writeMemory(0x4001n, Uint8Array.of(9));
    cpu.setState(initial);
    const changed = await cpu.run({ budget: 1n });
    assert.equal(changed.state.registers[0], 9n);
    assert.equal(changed.resources.compilations, 1);
  } finally {
    cpu.dispose();
  }
});
