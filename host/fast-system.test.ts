import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captureFastSystemState,
  fastSystemStateFromJson,
  zeroFastSystemState,
} from './fast-system.js';

const bank = () => ({
  star: 0x0020000800000000n,
  lstar: 0xffff800000001000n,
  fmask: 0xffffffffn,
  sysenterCs: 0x12340008n,
  sysenterEip: 0x7fffffffffffn,
  sysenterEsp: 0xffff800000000000n,
  kernelGsBase: 0xffffffffffffffffn,
});
const fields = [
  'star',
  'lstar',
  'fmask',
  'sysenterCs',
  'sysenterEip',
  'sysenterEsp',
  'kernelGsBase',
] as const;

test('fast-system capture reads exactly seven primitive words once and owns the result', () => {
  const source = bank();
  const reads = new Map<PropertyKey, number>();
  const captured = captureFastSystemState(
    new Proxy(source, {
      get(target, key, receiver) {
        reads.set(key, (reads.get(key) ?? 0) + 1);
        return Reflect.get(target, key, receiver) as unknown;
      },
    }),
  );
  assert.deepEqual(captured, bank());
  assert.deepEqual(
    [...reads],
    fields.map((field) => [field, 1]),
  );
  source.lstar = 0n;
  assert.equal(captured.lstar, 0xffff800000001000n);
  const zeros = zeroFastSystemState();
  assert.deepEqual(Object.keys(zeros), fields);
  assert.ok(Object.values(zeros).every((value) => value === 0n));
  zeros.star = 1n;
  assert.equal(zeroFastSystemState().star, 0n);
});

test('fast-system capture rejects incomplete, coercible and out-of-range records without coercion', () => {
  for (const field of fields) {
    for (const value of [undefined, null, 0, '0x0', Object(0n), -1n, 1n << 64n])
      assert.throws(
        () => captureFastSystemState({ ...bank(), [field]: value } as never),
        TypeError,
      );
    const missing: Partial<ReturnType<typeof bank>> = bank();
    delete missing[field];
    assert.throws(() => captureFastSystemState(missing as never), TypeError);
  }
  for (const value of [undefined, null, [], 1, 1n])
    assert.throws(() => captureFastSystemState(value as never), TypeError);
  // Rust owns canonicality, reserved fields and the complete normalized bank.
  assert.equal(captureFastSystemState({ ...bank(), star: 1n }).star, 1n);
});

test('fast-system JSON projection decodes camelcase hex words and rejects malformed backend records', () => {
  const wire = {
    star: '0x0020000800000000',
    lstar: '0xffff800000001000',
    fmask: '0xffffffff',
    sysenterCs: '0x12340008',
    sysenterEip: '0x7fffffffffff',
    sysenterEsp: '0xffff800000000000',
    kernelGsBase: '0xffffffffffffffff',
  };
  assert.deepEqual(fastSystemStateFromJson(wire), bank());
  const output = fastSystemStateFromJson(wire);
  output.sysenterCs = 0n;
  assert.deepEqual(fastSystemStateFromJson(wire), bank());
  for (const value of [
    null,
    {},
    { ...wire, sysenterCs: undefined },
    { ...wire, lstar: 0n },
    { ...wire, fmask: '4294967295' },
    { ...wire, star: '-0x1' },
    { ...wire, kernelGsBase: '0x10000000000000000' },
    { ...wire, sysenterEip: '0x' },
  ])
    assert.throws(() => fastSystemStateFromJson(value), /fast-system/);
});
