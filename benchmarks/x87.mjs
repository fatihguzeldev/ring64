const ONE = 0x3fff8000000000000000n;
const TWO = 0x40008000000000000000n;
const CODE = 0x1000n;
const MASK64 = (1n << 64n) - 1n;
const integer = (value) => {
  if (!value) return 0n;
  const bit = BigInt(value.toString(2).length - 1);
  return ((16383n + bit) << 64n) | (value << (63n - bit));
};
const little = (bytes, at, value, length) => {
  for (let i = 0; i < length; i++) bytes[at + i] = Number((value >> BigInt(8 * i)) & 255n);
};
function setup(s, sample, values = {}, pc = 3) {
  s.x87.controlWord = 0x7f | (pc << 8) | ((sample % 4) << 10);
  s.x87.statusWord = 0;
  s.x87.tagWord = 0xffff;
  for (const [key, value] of Object.entries(values)) {
    const bank = Number(key);
    s.x87.registers[bank] = value;
    s.x87.tagWord = (s.x87.tagWord & ~(3 << (bank * 2))) | ((value ? 0 : 1) << (bank * 2));
  }
}
function metadata(s, offset, memory = false) {
  s.x87.instructionPointer = CODE + BigInt(offset);
  if (memory) s.x87.dataPointer = s.gpr[3];
}
const rows = [];
for (const [format, body, bytes] of [
  ['m32', 'd903d91b', 4],
  ['m64', 'dd03dd1b', 8],
  ['m80', 'db2bdb3b', 10],
])
  rows.push({
    name: `x87-load-store-${format}`,
    body,
    instructions: 2,
    setup(s, _n, sample) {
      setup(s, sample);
      little(s.ram, 16, bytes === 4 ? 0x3f800000n : bytes === 8 ? 0x3ff0000000000000n : ONE, bytes);
    },
    expected(s) {
      s.x87.registers[7] = ONE;
      metadata(s, 2, true);
    },
  });
for (const [pc, encoding] of [
  [24, 0],
  [53, 2],
  [64, 3],
])
  rows.push({
    name: `x87-add-dependent-pc${pc}`,
    body: 'd8c1',
    instructions: 1,
    setup(s, _n, sample) {
      setup(s, sample, { 0: 0n, 1: ONE }, encoding);
    },
    expected(s, n) {
      s.x87.registers[0] = integer(n);
      s.x87.tagWord &= ~3;
      metadata(s, 0);
    },
  });
rows.push(
  {
    name: 'x87-add-inexact-pc53',
    body: 'd8c1',
    instructions: 1,
    setup(s, _n, sample) {
      setup(s, sample, { 0: ONE, 1: 0x3fc38000000000000000n }, 2);
      s.x87.statusWord = sample % 2 ? 0x20 : 0;
    },
    expected(s, n, sample) {
      const up = sample % 4 === 2;
      s.x87.registers[0] = ONE + (up ? n << 11n : 0n);
      s.x87.statusWord = 0x20 | (up ? 0x200 : 0);
      metadata(s, 0);
    },
  },
  {
    name: 'x87-sqrt-with-stack-reset',
    body: 'd9c1d9faddd8',
    instructions: 3,
    setup(s, _n, sample) {
      setup(s, sample, { 0: ONE, 1: TWO });
    },
    expected(s, _n, sample) {
      s.x87.registers[7] = 0x3fffb504f333f9de6484n + (sample % 4 === 2 ? 1n : 0n);
      s.x87.statusWord = 0x20;
      metadata(s, 4);
    },
  },
  {
    name: 'x87-round-with-stack-reset',
    body: 'd9c1d9fcddd8',
    instructions: 3,
    setup(s, _n, sample) {
      setup(s, sample, { 0: ONE, 1: 0x3fffc000000000000000n }, 0);
    },
    expected(s, _n, sample) {
      s.x87.registers[7] = sample % 4 === 0 || sample % 4 === 2 ? TWO : ONE;
      s.x87.statusWord = 0x20;
      metadata(s, 4);
    },
  },
  {
    name: 'x87-stack-churn',
    body: 'd9e8d9eed9c9ddd8ddd8',
    instructions: 5,
    setup(s, _n, sample) {
      setup(s, sample);
    },
    expected(s) {
      s.x87.registers[6] = ONE;
      s.x87.registers[7] = 0n;
      metadata(s, 8);
    },
  },
  {
    name: 'x87-control-memory-loop',
    body: 'd92bd93b',
    instructions: 2,
    x87StatusMask: 0xb8ff,
    setup(s, _n, sample) {
      setup(s, sample);
      little(s.ram, 16, BigInt(0x37f | (((sample + 1) % 4) << 10)), 2);
    },
    expected(s, _n, sample) {
      s.x87.controlWord = 0x37f | (((sample + 1) % 4) << 10);
    },
  },
  {
    name: 'x87-eight-live-slots',
    body: 'dcc7',
    instructions: 1,
    setup(s, _n, sample) {
      setup(
        s,
        sample,
        Object.fromEntries(
          Array.from({ length: 8 }, (_, i) => [i, i === 7 ? 0n : integer(BigInt(i + 1))]),
        ),
      );
    },
    expected(s, n) {
      s.x87.registers[7] = integer(n);
      s.x87.tagWord = 0;
      metadata(s, 0);
    },
  },
  {
    name: 'x87-mixed-integer-simd',
    body: 'd8c1660fd4c1',
    instructions: 2,
    setup(s, _n, sample) {
      setup(s, sample, { 0: 0n, 1: ONE });
      s.xmm[1] = 7n | (11n << 64n);
    },
    expected(s, n) {
      s.x87.registers[0] = integer(n);
      s.x87.tagWord &= ~3;
      s.xmm[0] =
        (((s.xmm[0] & MASK64) + 7n * n) & MASK64) |
        ((((s.xmm[0] >> 64n) + 11n * n) & MASK64) << 64n);
      metadata(s, 0);
    },
  },
  {
    name: 'x87-budget-one-resume',
    body: 'd8c1',
    instructions: 1,
    resume: true,
    setup(s, _n, sample) {
      setup(s, sample, { 0: 0n, 1: ONE });
    },
    expected(s, n) {
      s.x87.registers[0] = integer(n);
      s.x87.tagWord &= ~3;
      metadata(s, 0);
    },
  },
);

export const x87Rows = rows.map((row) => ({ ...row, requiresX87: true }));
