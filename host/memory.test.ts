import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captureBackings,
  captureInitialMemory,
  captureMappings,
  validateBackings,
  validateMappings,
  type MemoryLimits,
  type MemoryMapping,
} from './memory.js';
const limits: MemoryLimits = { maxBackingBytes: 16, maxBackings: 2, maxMappings: 2 };
const mapping = (base = 0x1000n): MemoryMapping => ({
  base,
  backing: '__proto__',
  offset: 0,
  length: 2,
  permissions: { read: false, write: true, execute: false },
});
test('backing capacity precedes indexed access and proportional copying', () => {
  const oversized = new Array(3);
  Object.defineProperty(oversized, 0, {
    get: () => assert.fail('rejected count must not be captured'),
  });
  assert.throws(() => captureBackings(oversized, limits), RangeError);
  const bytes = new Proxy(new Uint8Array(8), {
    get(target, key) {
      if (key === '0') assert.fail('later backing exceeds capacity');
      return Reflect.get(target, key, target) as unknown;
    },
  });
  assert.throws(
    () =>
      captureBackings(
        [
          { id: 'a', bytes },
          { id: 'b', bytes: new Uint8Array(9) },
        ],
        limits,
      ),
    RangeError,
  );
});
test('backings own their bytes and use exact map keys', () => {
  const bytes = Uint8Array.of(1, 2);
  const captured = captureBackings([{ id: '__proto__', bytes }], limits);
  bytes[0] = 9;
  assert.deepEqual(captured[0]!.bytes, Uint8Array.of(1, 2));
  const lengths = validateBackings(captured, new Map(), limits);
  validateMappings(captureMappings([mapping()], limits), lengths);
  assert.throws(() => validateBackings(captured, lengths, limits), TypeError);
});
test('mapping capture owns permissions and bounds counts before getters', () => {
  const input = mapping();
  const captured = captureMappings([input], limits);
  input.permissions.execute = true;
  assert.equal(captured[0]!.permissions.execute, false);
  const oversized = new Array(3);
  Object.defineProperty(oversized, 0, {
    get: () => assert.fail('rejected map must not be captured'),
  });
  assert.throws(() => captureMappings(oversized, limits), RangeError);
});
test('mapping spans check canonical boundaries, last u64 byte and backing bounds', () => {
  for (const base of [0x7fffffffffffn, 0xffff7fffffffffffn, 0xffffffffffffffffn])
    assert.throws(() => captureMappings([mapping(base)], limits), TypeError);
  validateMappings(
    captureMappings([{ ...mapping(0xffffffffffffffffn), length: 1 }], limits),
    new Map([['__proto__', 2]]),
  );
  assert.throws(() => validateMappings([mapping()], new Map([['__proto__', 1]])), TypeError);
  assert.throws(
    () => validateMappings([mapping(), mapping(0x1001n)], new Map([['__proto__', 2]])),
    TypeError,
  );
});
test('constructor preflights table count before backing capture', () => {
  const backings = new Array(1);
  Object.defineProperty(backings, 0, {
    get: () => assert.fail('must not inspect rejected layout'),
  });
  assert.throws(
    () =>
      captureInitialMemory({
        memory: { backings, mappings: [mapping(), mapping(), mapping()] },
        entry: 0n,
        memoryLimits: limits,
      }),
    RangeError,
  );
});
test('empty mapped layout accepts a raw entry checked only on reached fetch', () => {
  const input = captureInitialMemory({
    memory: { backings: [], mappings: [] },
    entry: 0x800000000000n,
    memoryLimits: limits,
  });
  assert.equal(input.entry, 0x800000000000n);
  assert.deepEqual(input.backings, []);
});
