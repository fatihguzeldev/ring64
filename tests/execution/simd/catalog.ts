import { MASK128, lanes, signed, vector } from './fixture.js';

export interface PackedCase {
  name: string;
  prefix: string;
  opcode: string;
  immediate?: number;
  group?: number;
  countWidth?: number;
  model(a: bigint, b: bigint): bigint;
}
const both = (a: bigint, b: bigint, w: number, f: (x: bigint, y: bigint) => bigint) => {
  const rhs = lanes(b, w);
  return vector(
    lanes(a, w).map((x, i) => f(x, rhs[i]!)),
    w,
  );
};
const clamp = (x: bigint, low: bigint, high: bigint) => (x < low ? low : x > high ? high : x);
export function packedCases(): PackedCase[] {
  const result: PackedCase[] = [];
  const add = (
    name: string,
    opcode: string,
    model: PackedCase['model'],
    extra: Partial<PackedCase> = {},
  ) => result.push({ name, prefix: '66', opcode, model, ...extra });
  for (const [name, opcode, w, subtract] of [
    ['paddb', 'fc', 8, false],
    ['paddw', 'fd', 16, false],
    ['paddd', 'fe', 32, false],
    ['paddq', 'd4', 64, false],
    ['psubb', 'f8', 8, true],
    ['psubw', 'f9', 16, true],
    ['psubd', 'fa', 32, true],
    ['psubq', 'fb', 64, true],
  ] as const)
    add(name, opcode, (a, b) => both(a, b, w, (x, y) => (subtract ? x - y : x + y)));
  for (const [name, opcode, w, subtract, isSigned] of [
    ['paddsb', 'ec', 8, false, true],
    ['paddsw', 'ed', 16, false, true],
    ['paddusb', 'dc', 8, false, false],
    ['paddusw', 'dd', 16, false, false],
    ['psubsb', 'e8', 8, true, true],
    ['psubsw', 'e9', 16, true, true],
    ['psubusb', 'd8', 8, true, false],
    ['psubusw', 'd9', 16, true, false],
  ] as const)
    add(name, opcode, (a, b) =>
      both(a, b, w, (x, y) => {
        const lhs = isSigned ? signed(x, w) : x,
          rhs = isSigned ? signed(y, w) : y;
        return clamp(
          subtract ? lhs - rhs : lhs + rhs,
          isSigned ? -(1n << BigInt(w - 1)) : 0n,
          (1n << BigInt(isSigned ? w - 1 : w)) - 1n,
        );
      }),
    );
  add('pand', 'db', (a, b) => a & b);
  add('pandn', 'df', (a, b) => ~a & b & MASK128);
  add('por', 'eb', (a, b) => a | b);
  add('pxor', 'ef', (a, b) => a ^ b);
  for (const [name, opcode, w, greater] of [
    ['pcmpeqb', '74', 8, false],
    ['pcmpeqw', '75', 16, false],
    ['pcmpeqd', '76', 32, false],
    ['pcmpgtb', '64', 8, true],
    ['pcmpgtw', '65', 16, true],
    ['pcmpgtd', '66', 32, true],
  ] as const)
    add(name, opcode, (a, b) =>
      both(a, b, w, (x, y) => ((greater ? signed(x, w) > signed(y, w) : x === y) ? -1n : 0n)),
    );
  for (const [name, opcode, w, isSigned, max] of [
    ['pminub', 'da', 8, false, false],
    ['pmaxub', 'de', 8, false, true],
    ['pminsw', 'ea', 16, true, false],
    ['pmaxsw', 'ee', 16, true, true],
  ] as const)
    add(name, opcode, (a, b) =>
      both(a, b, w, (x, y) => {
        const l = isSigned ? signed(x, w) : x,
          r = isSigned ? signed(y, w) : y;
        return max ? (l > r ? l : r) : l < r ? l : r;
      }),
    );
  for (const [name, opcode, w] of [
    ['pavgb', 'e0', 8],
    ['pavgw', 'e3', 16],
  ] as const)
    add(name, opcode, (a, b) => both(a, b, w, (x, y) => (x + y + 1n) >> 1n));
  add('pmullw', 'd5', (a, b) => both(a, b, 16, (x, y) => x * y));
  add('pmulhw', 'e5', (a, b) => both(a, b, 16, (x, y) => (signed(x, 16) * signed(y, 16)) >> 16n));
  add('pmulhuw', 'e4', (a, b) => both(a, b, 16, (x, y) => (x * y) >> 16n));
  add('pmuludq', 'f4', (a, b) => {
    const l = lanes(a, 32),
      r = lanes(b, 32);
    return vector([l[0]! * r[0]!, l[2]! * r[2]!], 64);
  });
  add('pmaddwd', 'f5', (a, b) => {
    const l = lanes(a, 16).map((x) => signed(x, 16)),
      r = lanes(b, 16).map((x) => signed(x, 16));
    return vector(
      Array.from({ length: 4 }, (_, i) => l[2 * i]! * r[2 * i]! + l[2 * i + 1]! * r[2 * i + 1]!),
      32,
    );
  });
  add('psadbw', 'f6', (a, b) => {
    const l = lanes(a, 8),
      r = lanes(b, 8);
    return vector(
      [0, 1].map((half) =>
        Array.from({ length: 8 }, (_, i) => {
          const d = l[half * 8 + i]! - r[half * 8 + i]!;
          return d < 0n ? -d : d;
        }).reduce((x, y) => x + y, 0n),
      ),
      64,
    );
  });
  for (const [name, opcode, inputWidth, outputWidth, unsigned] of [
    ['packsswb', '63', 16, 8, false],
    ['packssdw', '6b', 32, 16, false],
    ['packuswb', '67', 16, 8, true],
  ] as const)
    add(name, opcode, (a, b) =>
      vector(
        [...lanes(a, inputWidth), ...lanes(b, inputWidth)].map((x) =>
          clamp(
            signed(x, inputWidth),
            unsigned ? 0n : -(1n << BigInt(outputWidth - 1)),
            (1n << BigInt(unsigned ? outputWidth : outputWidth - 1)) - 1n,
          ),
        ),
        outputWidth,
      ),
    );
  for (const [name, opcode, w, high] of [
    ['punpcklbw', '60', 8, false],
    ['punpcklwd', '61', 16, false],
    ['punpckldq', '62', 32, false],
    ['punpcklqdq', '6c', 64, false],
    ['punpckhbw', '68', 8, true],
    ['punpckhwd', '69', 16, true],
    ['punpckhdq', '6a', 32, true],
    ['punpckhqdq', '6d', 64, true],
  ] as const)
    add(name, opcode, (a, b) => {
      const l = lanes(a, w),
        r = lanes(b, w),
        n = l.length / 2,
        start = high ? n : 0;
      return vector(Array.from({ length: n }, (_, i) => [l[start + i]!, r[start + i]!]).flat(), w);
    });
  for (const imm of [0, 0x1b, 0x55, 0xe4, 0xff]) {
    add(
      'pshufd',
      '70',
      (_a, b) => {
        const v = lanes(b, 32);
        return vector(
          Array.from({ length: 4 }, (_, i) => v[(imm >> (2 * i)) & 3]!),
          32,
        );
      },
      { immediate: imm },
    );
    for (const high of [false, true])
      add(
        high ? 'pshufhw' : 'pshuflw',
        '70',
        (_a, b) => {
          const v = lanes(b, 16),
            out = v.slice(),
            start = high ? 4 : 0;
          for (let i = 0; i < 4; i++) out[start + i] = v[start + ((imm >> (2 * i)) & 3)]!;
          return vector(out, 16);
        },
        { prefix: high ? 'f3' : 'f2', immediate: imm },
      );
    add(
      'shufps',
      'c6',
      (a, b) => {
        const l = lanes(a, 32),
          r = lanes(b, 32);
        return vector(
          [l[imm & 3]!, l[(imm >> 2) & 3]!, r[(imm >> 4) & 3]!, r[(imm >> 6) & 3]!],
          32,
        );
      },
      { prefix: '', immediate: imm },
    );
    add(
      'shufpd',
      'c6',
      (a, b) => {
        const l = lanes(a, 64),
          r = lanes(b, 64);
        return vector([l[imm & 1]!, r[(imm >> 1) & 1]!], 64);
      },
      { immediate: imm },
    );
  }
  for (const [name, opcode, w, right, arithmetic, groupOpcode, group] of [
    ['psllw', 'f1', 16, false, false, '71', 6],
    ['pslld', 'f2', 32, false, false, '72', 6],
    ['psllq', 'f3', 64, false, false, '73', 6],
    ['psrlw', 'd1', 16, true, false, '71', 2],
    ['psrld', 'd2', 32, true, false, '72', 2],
    ['psrlq', 'd3', 64, true, false, '73', 2],
    ['psraw', 'e1', 16, true, true, '71', 4],
    ['psrad', 'e2', 32, true, true, '72', 4],
  ] as const) {
    const shift = (a: bigint, count: bigint) =>
      vector(
        lanes(a, w).map((x) => {
          if (count >= BigInt(w)) return arithmetic && signed(x, w) < 0n ? -1n : 0n;
          return arithmetic ? signed(x, w) >> count : right ? x >> count : x << count;
        }),
        w,
      );
    add(name, opcode, (a, b) => shift(a, b & ((1n << 64n) - 1n)), { countWidth: w });
    for (const imm of [0, 1, w - 1, w, w + 1, 255])
      add(name + '-immediate', groupOpcode, (a) => shift(a, BigInt(imm)), {
        group,
        immediate: imm,
      });
  }
  for (const [name, group, right] of [
    ['pslldq', 7, false],
    ['psrldq', 3, true],
  ] as const)
    for (const imm of [0, 1, 15, 16, 17, 255])
      add(
        name,
        '73',
        (a) => (imm >= 16 ? 0n : (right ? a >> BigInt(imm * 8) : a << BigInt(imm * 8)) & MASK128),
        { group, immediate: imm },
      );
  return result;
}
export function encoding(row: PackedCase, dst = 0, src = 1, rex = ''): string {
  const modrm =
    row.group === undefined
      ? 0xc0 | ((dst & 7) << 3) | (src & 7)
      : 0xc0 | (row.group << 3) | (dst & 7);
  return (
    row.prefix +
    rex +
    '0f' +
    row.opcode +
    modrm.toString(16).padStart(2, '0') +
    (row.immediate === undefined ? '' : row.immediate.toString(16).padStart(2, '0'))
  );
}
