import { equal } from '../../../support/fixture.js';
import { view } from './fixture.js';

export const ALL = 0x8d7n;
export type Shift = 'SHL' | 'SHR' | 'SAR' | 'ROL' | 'ROR' | 'RCL' | 'RCR';
export type Unary = 'INC' | 'DEC' | 'NOT' | 'NEG';
export interface Value {
  result: bigint;
  flags: bigint;
  mask: bigint;
}

export function parity(value: bigint) {
  let ones = 0;
  while (value) {
    ones += Number(value % 2n);
    value /= 2n;
  }
  return ones % 2 === 0;
}

function status(value: bigint, width: number) {
  return (
    2n |
    (parity(value % 256n) ? 4n : 0n) |
    (value === 0n ? 0x40n : 0n) |
    (value >= 2n ** BigInt(width - 1) ? 0x80n : 0n)
  );
}

export function carry(
  a: bigint,
  b: bigint,
  width: number,
  incoming: bigint,
  subtract = false,
): Value {
  a = view(a, width);
  b = view(b, width);
  const c = incoming & 1n;
  const limit = 2n ** BigInt(width);
  const bound = limit / 2n;
  const signedA = a < bound ? a : a - limit;
  const signedB = b < bound ? b : b - limit;
  const raw = subtract ? a - b - c : a + b + c;
  const signed = subtract ? signedA - signedB - c : signedA + signedB + c;
  const result = ((raw % limit) + limit) % limit;
  const cf = subtract ? a < b + c : raw >= limit;
  const af = subtract ? a % 16n < (b % 16n) + c : (a % 16n) + (b % 16n) + c >= 16n;
  return {
    result,
    flags:
      status(result, width) |
      (cf ? 1n : 0n) |
      (af ? 0x10n : 0n) |
      (signed < -bound || signed >= bound ? 0x800n : 0n),
    mask: ALL,
  };
}

export function unary(kind: Unary, value: bigint, width: number, flags: bigint): Value {
  value = view(value, width);
  if (kind === 'NOT') return { result: 2n ** BigInt(width) - 1n - value, flags, mask: ALL };
  if (kind === 'NEG') return carry(0n, value, width, 0n, true);
  const answer = carry(value, 1n, width, 0n, kind === 'DEC');
  return { ...answer, flags: (answer.flags & ~1n) | (flags & 1n) };
}

// One-bit vector steps deliberately avoid the production shift expressions.
export function shift(
  kind: Shift,
  value: bigint,
  width: number,
  raw: number,
  flags: bigint,
): Value {
  value = view(value, width);
  const k = raw % (width === 64 ? 64 : 32);
  if (k === 0) return { result: value, flags, mask: ALL };
  const bits = Array.from({ length: width }, (_, index) =>
    Number((value / 2n ** BigInt(index)) % 2n),
  );
  const originalSign = bits[width - 1]!;
  let cf = Number(flags & 1n);
  const rotate = ['ROL', 'ROR', 'RCL', 'RCR'].includes(kind);
  const n =
    kind === 'ROL' || kind === 'ROR'
      ? k % width
      : (kind === 'RCL' || kind === 'RCR') && width < 32
        ? k % (width + 1)
        : k;
  for (let count = 0; count < n; count++) {
    if (kind === 'SHL' || kind === 'ROL' || kind === 'RCL') {
      const outgoing = bits[width - 1]!;
      bits.pop();
      bits.unshift(kind === 'SHL' ? 0 : kind === 'ROL' ? outgoing : cf);
      cf = outgoing;
    } else {
      const incoming =
        kind === 'SHR' ? 0 : kind === 'SAR' ? bits[width - 1]! : kind === 'ROR' ? bits[0]! : cf;
      cf = bits.shift()!;
      bits.push(incoming);
    }
  }
  const result = bits.reduce((value, bit, index) => value + BigInt(bit) * 2n ** BigInt(index), 0n);
  if (kind === 'ROL') cf = bits[0]!;
  if (kind === 'ROR') cf = bits[width - 1]!;
  let mask = rotate ? 0xd7n : 0xc6n;
  let output = rotate ? flags & 0xd6n : status(result, width);
  if (rotate || kind === 'SAR' || k < width) {
    mask |= 1n;
    output |= BigInt(cf);
  }
  if (k === 1) {
    const of =
      kind === 'SHR'
        ? originalSign
        : kind === 'SAR'
          ? 0
          : kind === 'ROR' || kind === 'RCR'
            ? bits[width - 1]! ^ bits[width - 2]!
            : bits[width - 1]! ^ cf;
    mask |= 0x800n;
    output |= BigInt(of) * 0x800n;
  }
  return { result, flags: output, mask };
}

export function doubleShift(
  right: boolean,
  a: bigint,
  b: bigint,
  width: number,
  raw: number,
  flags: bigint,
): Value {
  a = view(a, width);
  b = view(b, width);
  const k = raw % (width === 64 ? 64 : 32);
  if (k === 0) return { result: a, flags, mask: ALL };
  if (k > width) return { result: a, flags: 2n, mask: 2n };
  const vector = (value: bigint) =>
    Array.from({ length: width }, (_, index) => Number((value / 2n ** BigInt(index)) % 2n));
  const combined = right ? [...vector(a), ...vector(b)] : [...vector(b), ...vector(a)];
  let cf = 0;
  for (let count = 0; count < k; count++) {
    if (right) {
      cf = combined.shift()!;
      combined.push(0);
    } else {
      cf = combined.pop()!;
      combined.unshift(0);
    }
  }
  const bits = right ? combined.slice(0, width) : combined.slice(width);
  const result = bits.reduce((value, bit, index) => value + BigInt(bit) * 2n ** BigInt(index), 0n);
  const of = Number(a / 2n ** BigInt(width - 1)) ^ bits[width - 1]!;
  return {
    result,
    flags: status(result, width) | BigInt(cf) | (k === 1 ? BigInt(of) * 0x800n : 0n),
    mask: k === 1 ? 0x8c7n : 0xc7n,
  };
}

export function bit(
  kind: number,
  value: bigint,
  width: number,
  index: bigint,
  flags: bigint,
): Value {
  value = view(value, width);
  const position = Number(((index % BigInt(width)) + BigInt(width)) % BigInt(width));
  const weight = 2n ** BigInt(position);
  const set = (value / weight) % 2n;
  const result =
    kind === 0
      ? value
      : kind === 1
        ? value + (set ? 0n : weight)
        : kind === 2
          ? value - (set ? weight : 0n)
          : value + (set ? -weight : weight);
  return { result, flags: (flags & 0x42n) | set, mask: 0x43n };
}

export function bitAddress(base: bigint, index: bigint, width: number) {
  const signed = BigInt.asIntN(width, index);
  const divisor = BigInt(width);
  const q = signed < 0n ? -((-signed + divisor - 1n) / divisor) : signed / divisor;
  return BigInt.asUintN(64, base + q * BigInt(width / 8));
}

export function scan(reverse: boolean, value: bigint, width: number): Value {
  value = view(value, width);
  let index = 0n;
  if (value) {
    let remaining = value;
    while (reverse ? remaining > 1n : remaining % 2n === 0n) {
      remaining /= 2n;
      index++;
    }
  }
  return {
    result: index,
    flags: 2n | (parity(value) ? 4n : 0n) | (value === 0n ? 0x40n : 0n),
    mask: ALL,
  };
}

export function oracleChecks() {
  equal(carry(0n, 255n, 8, 1n, true).flags, 0x57n, 'full b+c borrow oracle');
  equal(carry(127n, 0n, 8, 1n).flags, 0x892n, 'carry signed-range oracle');
  equal(shift('RCL', 0x88n, 8, 10, ALL).result, 0x11n, 'reduced carry-ring oracle');
  equal(shift('RCL', 0x55667788n, 32, 33, ALL).flags, 0x8d6n, 'masked one carry-ring oracle');
  equal(doubleShift(false, 1n, 0x1234n, 16, 16, ALL).result, 0x1234n, 'double-shift width oracle');
  equal(bitAddress(0x4010n, -1n, 16), 0x400en, 'negative floor bit address oracle');
  equal(scan(true, 0x180n, 32).flags, 6n, 'full-source parity oracle');
}
