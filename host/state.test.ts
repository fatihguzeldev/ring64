import assert from 'node:assert/strict';
import test from 'node:test';
import { captureState, type State } from './core.js';

function input(): State {
  return { registers: Array<bigint>(16).fill(7n), flags: 2n, rip: 0x1000n };
}

test('scalar capture normalizes omitted boundaries and owns explicit interruptibility', () => {
  assert.deepEqual(captureState(input()), {
    ...input(),
    interruptibility: { sti: false, ss: false },
    event: { kind: 'ready' },
  });
  const interruptibility = { sti: false, ss: true };
  const source = { ...input(), interruptibility };
  const captured = captureState(source);
  assert.deepEqual(captured.interruptibility, interruptibility);
  assert.notEqual(captured.interruptibility, interruptibility);
  source.registers[0] = 9n;
  interruptibility.ss = false;
  assert.equal(captured.registers[0], 7n);
  assert.deepEqual(captured.interruptibility, { sti: false, ss: true });
});

test('scalar capture reads the boundary object and each field exactly once', () => {
  const reads = { object: 0, sti: 0, ss: 0 };
  const source = {
    ...input(),
    get interruptibility() {
      reads.object++;
      return {
        get sti() {
          reads.sti++;
          return false;
        },
        get ss() {
          reads.ss++;
          return true;
        },
      };
    },
  };
  assert.deepEqual(captureState(source).interruptibility, { sti: false, ss: true });
  assert.deepEqual(reads, { object: 1, sti: 1, ss: 1 });
});

test('scalar capture rejects malformed boundary structure without coercing booleans', () => {
  for (const interruptibility of [
    null,
    true,
    0,
    [],
    {},
    { sti: false },
    { ss: false },
    { sti: 0, ss: false },
    { sti: false, ss: 'false' },
  ]) {
    assert.throws(
      () => captureState({ ...input(), interruptibility } as State),
      /interruptibility|boolean/,
    );
  }
});
