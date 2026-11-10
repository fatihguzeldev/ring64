import assert from 'node:assert/strict';
import test from 'node:test';
import { captureState, type State } from './core.js';
import {
  captureEventState,
  readEvent,
  writeEvent,
  readInterrupts,
  writeInterrupts,
  validateInterruptLayout,
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

test('halted and source-aware external checkpoints retain independent IRQ and NMI meanings', () => {
  assert.deepEqual(captureEventState({ kind: 'halted' } as EventState), { kind: 'halted' });
  for (const source of [{ kind: 'irq', vector: 2 }, { kind: 'irq', vector: 13 }, { kind: 'nmi' }]) {
    const input = {
      kind: 'pending-interrupt',
      interrupt: { source, returnPc: 0x1000n, savedFlags: 0x202n },
    } as EventState;
    assert.deepEqual(captureEventState(input), input);
    const bytes = new Uint8Array(40).fill(0xa5);
    writeEvent(new DataView(bytes.buffer), layout, input);
    assert.equal(new DataView(bytes.buffer).getUint32(0, true), source.kind === 'irq' ? 4 : 5);
    assert.equal(
      new DataView(bytes.buffer).getBigUint64(8, true),
      0n,
      'external source has no instruction producer PC',
    );
    assert.equal(
      new DataView(bytes.buffer).getUint32(32, true),
      0,
      'external sources have no exception error code',
    );
    assert.equal(new DataView(bytes.buffer).getUint32(36, true), 0, 'no error code tag');
    assert.deepEqual(readEvent(new DataView(bytes.buffer), layout), input);
  }
});

test('interrupt checkpoint capture owns each field and omission differs from explicit undefined', () => {
  const reads = { interrupts: 0, irq: 0, nmiPending: 0, nmiBlocked: 0 };
  const input = {
    registers: Array<bigint>(16).fill(0n),
    flags: 2n,
    rip: 0x1000n,
    get interrupts() {
      reads.interrupts++;
      return {
        get irq() {
          reads.irq++;
          return 255;
        },
        get nmiPending() {
          reads.nmiPending++;
          return true;
        },
        get nmiBlocked() {
          reads.nmiBlocked++;
          return false;
        },
      };
    },
  };
  assert.deepEqual(captureState(input).interrupts, {
    irq: 255,
    nmiPending: true,
    nmiBlocked: false,
  });
  assert.deepEqual(reads, { interrupts: 1, irq: 1, nmiPending: 1, nmiBlocked: 1 });
  const bare = { registers: input.registers, flags: 2n, rip: 0x1000n };
  assert.deepEqual(captureState(bare).interrupts, {
    irq: null,
    nmiPending: false,
    nmiBlocked: false,
  });
  for (const interrupts of [
    undefined,
    null,
    [],
    {},
    { irq: null, nmiPending: 0, nmiBlocked: false },
    { irq: 256, nmiPending: false, nmiBlocked: false },
  ])
    assert.throws(() => captureState({ ...bare, interrupts } as State), TypeError);
});

test('external checkpoint capture rejects vector and exception fields on the wrong source kind', () => {
  for (const source of [
    { kind: 'irq', vector: -1 },
    { kind: 'irq', vector: 256 },
    { kind: 'irq', vector: '2' },
    { kind: 'nmi', vector: 2 },
    { kind: 'nmi', vector: undefined },
    { kind: 'unknown' },
  ])
    assert.throws(
      () =>
        captureEventState({
          kind: 'pending-interrupt',
          interrupt: { source, returnPc: 0x1000n, savedFlags: 2n },
        } as EventState),
      TypeError,
    );
  for (const extra of [{ errorCode: 0 }, { errorCode: undefined }, { exception: {} }])
    assert.throws(
      () =>
        captureEventState({
          kind: 'pending-interrupt',
          interrupt: {
            source: { kind: 'irq', vector: 13 },
            returnPc: 0x1000n,
            savedFlags: 0x202n,
            ...extra,
          },
        } as EventState),
      TypeError,
    );
});

test('queued interrupt transport uses explicit little-endian occupancy and boolean fields', () => {
  const interrupts = { offset: 604, bytes: 12, irq: 0, nmiPending: 4, nmiBlocked: 8 };
  const bytes = Uint8Array.of(0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0);
  const expected = { irq: 255, nmiPending: true, nmiBlocked: false };
  assert.deepEqual(readInterrupts(new DataView(bytes.buffer), interrupts), expected);
  const output = new Uint8Array(12).fill(0xa5);
  writeInterrupts(new DataView(output.buffer), interrupts, expected);
  assert.deepEqual(output, bytes);
  writeInterrupts(new DataView(output.buffer), interrupts, {
    irq: null,
    nmiPending: false,
    nmiBlocked: true,
  });
  assert.deepEqual(output, Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0));
  validateInterruptLayout(interrupts, 616, 604);
  for (const change of [
    { offset: 600 },
    { bytes: 16 },
    { irq: 4 },
    { nmiBlocked: 12 },
    { nmiPending: NaN },
  ])
    assert.throws(() => validateInterruptLayout({ ...interrupts, ...change }, 616, 604));
  assert.throws(() => validateInterruptLayout(interrupts, 615, 604));
  for (const [offset, value] of [
    [0, 257],
    [4, 2],
    [8, 2],
  ]) {
    const malformed = new Uint8Array(12);
    new DataView(malformed.buffer).setUint32(offset!, value!, true);
    assert.throws(() => readInterrupts(new DataView(malformed.buffer), interrupts));
  }
});
