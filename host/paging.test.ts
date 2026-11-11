import assert from 'node:assert/strict';
import test from 'node:test';
import { capturePagingState, pagingStateFromJson } from './paging.js';

const bank = () => ({ cr0: 0x80010033n, cr2: 0n, cr3: 0x1000n, cr4: 0x628n, efer: 0xd00n });

test('paging state captures five primitive words once without changing the caller bank', () => {
  const values = { ...bank(), cr2: 0x800000000000n };
  const reads = new Map<PropertyKey, number>();
  const input = new Proxy(values, {
    get(target, key, receiver) {
      reads.set(key, (reads.get(key) ?? 0) + 1);
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  const captured = capturePagingState(input);
  assert.deepEqual(captured, values);
  assert.deepEqual(
    [...reads],
    ['cr0', 'cr2', 'cr3', 'cr4', 'efer'].map((key) => [key, 1]),
  );
  values.cr3 = 0x2000n;
  assert.equal(captured.cr3, 0x1000n);
});

test('paging state rejects missing, boxed and out-of-range words without normalizing them', () => {
  for (const key of ['cr0', 'cr2', 'cr3', 'cr4', 'efer'] as const) {
    for (const value of [undefined, null, 0, '0', Object(0n), -1n, 1n << 64n])
      assert.throws(() => capturePagingState({ ...bank(), [key]: value } as never), TypeError);
    const missing = { ...bank() } as Partial<ReturnType<typeof bank>>;
    delete missing[key];
    assert.throws(() => capturePagingState(missing as never), TypeError);
  }
  for (const value of [undefined, null, [], 1, 1n])
    assert.throws(() => capturePagingState(value as never), TypeError);
  // Control-profile validity is authoritative in Rust; frontend capture stays structural.
  assert.equal(capturePagingState({ ...bank(), cr0: 0n }).cr0, 0n);
});

test('paging projection decodes owned unsigned words and rejects malformed backend shapes', () => {
  const wire = {
    cr0: '0x80010033',
    cr2: '0xffffffffffffffff',
    cr3: '0x1000',
    cr4: '0x628',
    efer: '0xd00',
  };
  assert.deepEqual(pagingStateFromJson(wire), { ...bank(), cr2: 0xffffffffffffffffn });
  for (const value of [
    null,
    {},
    { ...wire, cr2: 0 },
    { ...wire, cr3: '-1' },
    { ...wire, cr0: '0x10000000000000000' },
  ])
    assert.throws(() => pagingStateFromJson(value), /paging/);
});
