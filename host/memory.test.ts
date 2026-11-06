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
  const bytes = new Uint8Array(8);
  Object.defineProperty(bytes, 'length', {
    get: () => assert.fail('preflight must use the actual typed-array length'),
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
test('backing capture ignores shadow lengths and never truncates an oversized view', () => {
  const bytes = Uint8Array.of(1, 2, 3, 4);
  Object.defineProperty(bytes, 'length', { value: 1 });
  assert.throws(
    () => captureBackings([{ id: 'a', bytes }], { ...limits, maxBackingBytes: 1 }),
    RangeError,
  );
  assert.deepEqual(
    captureBackings([{ id: 'a', bytes }], limits)[0]!.bytes,
    Uint8Array.of(1, 2, 3, 4),
  );
});
test('detachment during later input capture rejects instead of silently zero-filling', () => {
  const bytes = Uint8Array.of(1, 2, 3, 4);
  const other = {
    get id() {
      structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
      return 'b';
    },
    bytes: Uint8Array.of(5),
  };
  assert.throws(() => captureBackings([{ id: 'a', bytes }, other], limits), TypeError);
});
test('legacy mapping capacity is rejected before backing copy allocations', () => {
  const Native = Uint8Array;
  const code = new Native(4);
  const ram = new Native(4);
  let allocations = 0;
  globalThis.Uint8Array = new Proxy(Native, {
    construct(target, args, newTarget) {
      allocations++;
      return Reflect.construct(target, args, newTarget) as Uint8Array;
    },
  });
  try {
    assert.throws(
      () =>
        captureInitialMemory({
          code: { base: 0x1000n, bytes: code },
          ram: { base: 0x2000n, bytes: ram },
          memoryLimits: { ...limits, maxMappings: 1 },
        }),
      RangeError,
    );
    assert.equal(allocations, 0);
  } finally {
    globalThis.Uint8Array = Native;
  }
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
