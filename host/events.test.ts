import assert from 'node:assert/strict';
import test from 'node:test';
import { captureState, Core, type State } from './core.js';
import { createCpu } from './cpu.js';
import {
  captureEventState,
  readEvent,
  validateEventLayout,
  writeEvent,
  readPagingSource,
  writePagingSource,
  validatePagingSourceLayout,
  type EventState,
} from './events.js';

const layout = {
  offset: 560,
  bytes: 40,
  kind: 0,
  vector: 4,
  instructionPc: 8,
  returnPc: 16,
  savedFlags: 24,
  errorCode: 32,
  hasErrorCode: 36,
};

const pending = (): Extract<EventState, { kind: 'pending' }> => ({
  kind: 'pending',
  exception: {
    vector: 13,
    instructionPc: 0x1122334455667788n,
    returnPc: 0x8877665544332211n,
    savedFlags: 0x10202n,
    errorCode: 0x1234,
  },
});

test('paging source transport appends a literal address without reusing mutable CR2 or event slots', () => {
  const sourceLayout = { offset: 712, bytes: 16, address: 0, hasAddress: 8, reserved: 12 };
  validatePagingSourceLayout(sourceLayout, 728, 712);
  const event = {
    kind: 'pending',
    exception: {
      instructionPc: 0x1122334455667788n,
      returnPc: 0x8877665544332211n,
      savedFlags: 0x10202n,
      vector: 14,
      errorCode: 21,
      pageFaultAddress: 0xffff800000001234n,
    },
  } as const;
  const bytes = new Uint8Array(728);
  const view = new DataView(bytes.buffer);
  writeEvent(new DataView(bytes.buffer, layout.offset, layout.bytes), layout, event);
  writePagingSource(
    new DataView(bytes.buffer, sourceLayout.offset, sourceLayout.bytes),
    sourceLayout,
    event.exception.pageFaultAddress,
  );
  assert.deepEqual(
    bytes.slice(712),
    Uint8Array.of(0x34, 0x12, 0, 0, 0, 0x80, 0xff, 0xff, 1, 0, 0, 0, 0, 0, 0, 0),
  );
  assert.equal(view.getUint32(layout.offset + layout.vector, true), 14);
  assert.equal(view.getUint32(layout.offset + layout.errorCode, true), 21);
  assert.deepEqual(readEvent(view, layout, layout.offset, sourceLayout), event);
  assert.throws(() => readEvent(view, layout, layout.offset), /paging|page fault/);
  writePagingSource(new DataView(bytes.buffer, 712, 16), sourceLayout, undefined);
  assert.ok(bytes.slice(712).every((byte) => byte === 0));
  assert.throws(() => readEvent(view, layout, layout.offset, sourceLayout), /page fault/);
});

test('paging source descriptor controls member offsets and rejects overlap, malformed tags and noncanonical addresses', () => {
  const layout = { offset: 712, bytes: 16, address: 8, hasAddress: 0, reserved: 4 };
  validatePagingSourceLayout(layout, 728, 712);
  const bytes = new Uint8Array(16).fill(0xa5);
  const view = new DataView(bytes.buffer);
  writePagingSource(view, layout, 0x1234n);
  assert.deepEqual(bytes, Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0, 0x34, 0x12, 0, 0, 0, 0, 0, 0));
  assert.equal(readPagingSource(view, layout), 0x1234n);
  for (const change of [
    { offset: 704 },
    { bytes: 15 },
    { hasAddress: 8 },
    { address: 4 },
    { reserved: NaN },
  ])
    assert.throws(
      () => validatePagingSourceLayout({ ...layout, ...change }, 728, 712),
      /paging source/,
    );
  view.setUint32(layout.hasAddress, 2, true);
  assert.throws(() => readPagingSource(view, layout), /paging source/);
  writePagingSource(view, layout, 0n);
  view.setUint32(layout.reserved, 1, true);
  assert.throws(() => readPagingSource(view, layout), /paging source/);
  const before = bytes.slice();
  assert.throws(() => writePagingSource(view, layout, 0x800000000000n), TypeError);
  assert.deepEqual(bytes, before, 'invalid source cannot partially replace the caller packet');
});

test('pending page faults capture a canonical frozen address and error shape without live paging state', () => {
  const source = { ...pending().exception, vector: 14, errorCode: 6, pageFaultAddress: 0x501000n };
  const reads = new Map<PropertyKey, number>();
  const exception = new Proxy(source, {
    get(target, key, receiver) {
      reads.set(key, (reads.get(key) ?? 0) + 1);
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  assert.deepEqual(captureEventState({ kind: 'pending', exception } as never), {
    kind: 'pending',
    exception: source,
  });
  assert.deepEqual([...reads.values()], Array<number>(6).fill(1));
  for (const value of [undefined, null, 0, Object(0n), -1n, 1n << 64n, 0x800000000000n])
    assert.throws(
      () =>
        captureEventState({
          kind: 'pending',
          exception: { ...source, pageFaultAddress: value },
        } as never),
      TypeError,
    );
  for (const errorCode of [undefined, 8, 16 | 2, 32, -1, 1.5])
    assert.throws(
      () => captureEventState({ kind: 'pending', exception: { ...source, errorCode } } as never),
      TypeError,
    );
  for (const vector of [0, 1, 6, 8, 10, 11, 12, 13, 16, 19])
    assert.throws(
      () => captureEventState({ kind: 'pending', exception: { ...source, vector } } as never),
      TypeError,
    );
});

test('event capture owns nested state and reads each selected field once', () => {
  const input = pending();
  const reads = new Map<string, number>();
  const exception = new Proxy(input.exception, {
    get(target, key, receiver) {
      reads.set(String(key), (reads.get(String(key)) ?? 0) + 1);
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  let kindReads = 0,
    exceptionReads = 0;
  const captured = captureEventState({
    get kind() {
      kindReads++;
      return 'pending' as const;
    },
    get exception() {
      exceptionReads++;
      return exception;
    },
  });
  assert.deepEqual(captured, pending());
  assert.equal(kindReads, 1);
  assert.equal(exceptionReads, 1);
  assert.deepEqual([...reads.values()], Array<number>(5).fill(1));
  input.exception.returnPc = 0n;
  assert.deepEqual(captured, pending());
});

test('event capture rejects malformed records and primitive fields without coercion', () => {
  for (const input of [undefined, null, [], {}, 'ready', { kind: 'other' }])
    assert.throws(() => captureEventState(input as EventState), TypeError);
  for (const input of [undefined, null, [], {}, 0])
    assert.throws(
      () => captureEventState({ kind: 'pending', exception: input } as EventState),
      TypeError,
    );
  const source = pending();
  for (const [name, values] of [
    ['vector', [-1, 2, 7, 14, 256, 1.5, '13', undefined]],
    ['instructionPc', [-1n, 1n << 64n, 1, '1', undefined]],
    ['returnPc', [-1n, 1n << 64n, 1, '1', undefined]],
    ['savedFlags', [-1n, 1n << 64n, 2, '2', undefined]],
    ['errorCode', [-1, 65536, 1.5, NaN, 0n, undefined]],
  ] as const)
    for (const value of values)
      assert.throws(
        () =>
          captureEventState({
            kind: 'pending',
            exception: { ...source.exception, [name]: value },
          } as EventState),
        TypeError,
        name,
      );
});

test('scalar event omission selects ready but explicitly undefined is rejected', () => {
  const source: State = { registers: Array<bigint>(16).fill(0n), flags: 2n, rip: 0x1000n };
  assert.deepEqual(captureState(source).event, { kind: 'ready' });
  for (const event of [undefined, null])
    assert.throws(() => captureState({ ...source, event } as unknown as State), TypeError);
  assert.deepEqual(captureState({ ...source, event: { kind: 'shutdown' } }).event, {
    kind: 'shutdown',
  });
});

test('event transport preserves independent little-endian exception fields', () => {
  const bytes = Uint8Array.from([
    1, 0, 0, 0, 13, 0, 0, 0, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11, 0x11, 0x22, 0x33, 0x44,
    0x55, 0x66, 0x77, 0x88, 2, 2, 1, 0, 0, 0, 0, 0, 0x34, 0x12, 0, 0, 1, 0, 0, 0,
  ]);
  assert.deepEqual(readEvent(new DataView(bytes.buffer), layout), pending());
  const full = new Uint8Array(600);
  full.set(bytes, layout.offset);
  assert.deepEqual(readEvent(new DataView(full.buffer), layout, layout.offset), pending());
  const output = new Uint8Array(40).fill(0xa5);
  writeEvent(new DataView(output.buffer), layout, pending());
  assert.deepEqual(output, bytes);
  for (const input of [{ kind: 'ready' }, { kind: 'shutdown' }] as const) {
    writeEvent(new DataView(output.buffer), layout, input);
    assert.deepEqual(readEvent(new DataView(output.buffer), layout), input);
    assert.ok(output.subarray(4).every((byte) => byte === 0));
  }
});

test('event layout rejects overlap, invalid extents and noninteger fields', () => {
  validateEventLayout(layout, 600, 560);
  for (const change of [
    { offset: 552 },
    { bytes: 39 },
    { vector: 0 },
    { instructionPc: 9 },
    { hasErrorCode: 40 },
    { savedFlags: NaN },
  ])
    assert.throws(() => validateEventLayout({ ...layout, ...change }, 600, 560), Error);
  assert.throws(() => validateEventLayout(layout, 599, 560), Error);
});

test('disposal during event capture prevents scalar publication and later capture', async () => {
  const imports: State[] = [];
  const original = Core.create;
  Core.create = async () =>
    ({
      setState: (input: State) => imports.push(input),
      releaseIo() {},
      dispose() {},
    }) as unknown as Core;
  let cpu;
  try {
    cpu = await createCpu({
      compiler: new Uint8Array(),
      code: { base: 0x1000n, bytes: Uint8Array.of(0x90) },
      ram: { base: 0x8000n, bytes: new Uint8Array(1) },
      limits: {
        maxInstructions: 1,
        maxSourceBytes: 16,
        maxArtifactBytes: 65536,
        maxCachedArtifacts: 1,
        maxCachedBytes: 65536,
        maxTranslationsPerRun: 1,
      },
    });
  } finally {
    Core.create = original;
  }
  let reads = 0;
  const source: State = {
    registers: Array<bigint>(16).fill(0n),
    flags: 2n,
    rip: 0x1000n,
    get event() {
      reads++;
      cpu.dispose();
      return { kind: 'ready' as const };
    },
  };
  assert.throws(() => cpu.setState(source), /disposed/);
  assert.deepEqual(imports, []);
  assert.equal(reads, 1);
  assert.throws(() => cpu.setState(source), /disposed/);
  assert.equal(reads, 1, 'lifecycle gate precedes caller-controlled event capture');
});
