import assert from 'node:assert/strict';
import test from 'node:test';
import { captureContext, type ExecutionContext, type LoadedSegment } from './context.js';

const data = (): LoadedSegment => ({
  base: 0n,
  limit: 0xffffffff,
  default32: true,
  usable: true,
  type: 'read-write',
});
function input(): ExecutionContext {
  return {
    mode: 'protected',
    segments: {
      cs: { ...data(), type: 'readable-code' },
      ss: data(),
      ds: data(),
      es: data(),
      fs: data(),
      gs: data(),
    },
  };
}

test('context capture owns every loaded segment and reads each field once', () => {
  const value = input();
  assert.notEqual(value.mode, 'long64');
  if (value.mode === 'long64') assert.fail();
  const expected = structuredClone(value);
  const reads: string[] = [];
  const source = value.segments.ds;
  for (const key of ['base', 'limit', 'default32', 'usable', 'type'] as const) {
    const original = source[key];
    Object.defineProperty(source, key, {
      get() {
        reads.push(key);
        return original;
      },
    });
  }
  const captured = captureContext(value);
  assert.deepEqual(captured, expected);
  assert.deepEqual(reads, ['base', 'limit', 'default32', 'usable', 'type']);
  value.segments.fs.base = 7n;
  assert.deepEqual(captured, expected);
});

test('context capture rejects malformed fields and exact address domains', () => {
  for (const value of [null, undefined, {}, { mode: '32' }, { mode: 'long64', fsBase: 0n }])
    assert.throws(() => captureContext(value as ExecutionContext), TypeError);
  for (const base of [-1n, 1n << 64n, 0x800000000000n, 0xffff7fffffffffffn])
    assert.throws(() => captureContext({ mode: 'long64', fsBase: base, gsBase: 0n }), TypeError);
  for (const base of [-1n, 1n << 32n]) {
    const value = input();
    if (value.mode === 'long64') assert.fail();
    value.segments.ds.base = base;
    assert.throws(() => captureContext(value), TypeError);
  }
  for (const key of ['default32', 'usable', 'type', 'limit'] as const) {
    const value = input();
    if (value.mode === 'long64') assert.fail();
    Object.defineProperty(value.segments.ds, key, { value: key === 'type' ? 'memory' : NaN });
    assert.throws(() => captureContext(value), TypeError);
  }
});
