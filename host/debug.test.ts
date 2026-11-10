import assert from 'node:assert/strict';
import test from 'node:test';
import { captureDebugState, captureDebugSource, captureDebugContinuation } from './debug.js';

test('debug bank capture detaches all four raw addresses and reads caller values once', () => {
  let reads = 0;
  const addresses = [0x800000000000n, 2n, 3n, 4n];
  const captured = captureDebugState({
    get addresses() {
      reads++;
      return addresses;
    },
    dr6: 0n,
    dr7: 0n,
  });
  assert.equal(reads, 1);
  addresses[0] = 0n;
  assert.deepEqual(captured, { addresses: [0x800000000000n, 2n, 3n, 4n], dr6: 0n, dr7: 0n });
  for (const bad of [
    { addresses: [0n], dr6: 0n, dr7: 0n },
    { addresses, dr6: 1n << 32n, dr7: 0n },
  ])
    assert.throws(() => captureDebugState(bad), TypeError);
});
test('debug source variants and historical continuations capture shape without current bank assumptions', () => {
  assert.deepEqual(
    captureDebugSource({
      class: 'trap',
      cause: 'data-breakpoint',
      breakpoints: 3,
      singleStep: true,
      instructionCompleted: false,
      deferredOriginPc: 0xffn,
    }),
    {
      class: 'trap',
      cause: 'data-breakpoint',
      breakpoints: 3,
      singleStep: true,
      instructionCompleted: false,
      deferredOriginPc: 0xffn,
    },
  );
  assert.deepEqual(captureDebugContinuation({ breakpoints: 8, originPc: 0n }), {
    breakpoints: 8,
    originPc: 0n,
  });
  assert.throws(
    () => captureDebugSource({ class: 'fault', cause: 'general-detect', breakpoints: 1 } as never),
    TypeError,
  );
  assert.throws(() => captureDebugContinuation({ breakpoints: 0, originPc: 0n }), TypeError);
});
