import test from 'node:test';
import assert from 'node:assert/strict';
import { arithmetic, lane, round, rational } from './reference.js';
test('independent rational float reference matches fixed ties tiny and exponent boundaries', () => {
  assert.deepEqual(
    [0, 1, 2, 3].map((rc) => lane('add', 0x3f800000n, 0x33800000n, 32, 0x1f80 | (rc << 13)).bits),
    [0x3f800000n, 0x3f800000n, 0x3f800001n, 0x3f800000n],
  );
  assert.deepEqual(lane('mul', 0x00800000n, 0x3f000000n, 32, 0x1f80), {
    bits: 0x00400000n,
    pre: 0,
    post: 0,
  });
  assert.deepEqual(lane('mul', 0x00800000n, 0x3f000000n, 32, 0x9f80), {
    bits: 0n,
    pre: 0,
    post: 48,
  });
  assert.deepEqual(lane('mul', 0x00800000n, 0x3f000000n, 32, 0x1780), {
    bits: 0x00400000n,
    pre: 0,
    post: 16,
  });
  assert.equal(lane('mul', 0x7f7fffffn, 0x40000000n, 32, 0x1b80).post, 8);
  assert.equal(lane('div', 0x3f800000n, 0x40400000n, 32, 0x1f80).bits, 0x3eaaaaabn);
  assert.equal(lane('sqrt', 0n, 0x4000000000000000n, 64, 0x1f80).bits, 0x3ff6a09e667f3bcdn);
  assert.equal(lane('sqrt', 0n, 0x40000000n, 32, 0x1f80).bits, 0x3fb504f3n);
  assert.equal(lane('sqrt', 0n, 0x80000000n, 32, 0x1f80).bits, 0x80000000n);
  for (const f of [32, 64] as const)
    for (const bits of f === 32
      ? [1n, 0x007fffffn, 0x00800000n, 0x3f800001n, 0x7f7fffffn]
      : [1n, 0x000fffffffffffffn, 0x0010000000000000n, 0x3ff0000000000001n, 0x7fefffffffffffffn])
      assert.equal(round(rational(bits, f), f, 0x1f80).bits, bits);
});
test('independent reference retains MXCSR phases and raw NaN/minimum selection', () => {
  assert.equal(lane('min', 0x3f800000n, 0x7f800022n, 32, 0x1f80).bits, 0x7f800022n);
  assert.deepEqual(lane('min', 0x3f800000n, 1n, 32, 0x1fc0), { bits: 0n, pre: 0, post: 0 });
  const packed = (a: bigint[]) => a.reduce((v, x, i) => v | (x << BigInt(32 * i)), 0n);
  const a = packed([0n, 0x3f800000n, 0x7f7fffffn, 0x3f800000n]),
    b = packed([0n, 0n, 0x3f000000n, 0x40400000n]);
  assert.deepEqual(arithmetic('div', a, b, 32, false, 0x1f00), {
    bits: a,
    mxcsr: 0x1f05,
    raised: 5,
    unmasked: 1,
    stage: 'pre-computation',
  });
  const after = arithmetic('div', a, b, 32, false, 0x1f85);
  assert.equal(after.bits, packed([0xffc00000n, 0x7f800000n, 0x7f800000n, 0x3eaaaaabn]));
  assert.equal(after.mxcsr, 0x1fad);
});
