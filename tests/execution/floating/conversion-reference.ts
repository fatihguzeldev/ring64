import { classify, rational, round, shape, type Format } from './reference.js';
export function floatConversion(raw: bigint, source: Format, target: Format, mxcsr: number) {
  const sign = 1n << BigInt(source - 1),
    t = shape(target);
  let c = classify(raw, source);
  if (mxcsr & 64 && c.denormal) {
    raw &= sign;
    c = classify(raw, source);
  }
  const targetSign = c.sign ? 1n << BigInt(target - 1) : 0n;
  if (c.nan) {
    const frac = c.fraction;
    return {
      bits:
        targetSign |
        (BigInt(2 * t.bias + 1) << BigInt(t.fraction)) |
        (target > source ? frac << 29n : frac >> 29n) |
        (1n << BigInt(t.fraction - 1)),
      pre: c.snan ? 1 : 0,
      post: 0,
    };
  }
  if (c.inf)
    return { bits: targetSign | (BigInt(2 * t.bias + 1) << BigInt(t.fraction)), pre: 0, post: 0 };
  if (c.zero) return { bits: targetSign, pre: 0, post: 0 };
  const result = round(rational(raw, source), target, mxcsr);
  return { ...result, pre: c.denormal ? 2 : 0 };
}
export function intToFloat(raw: bigint, width: 32 | 64, target: Format, mxcsr: number) {
  const mask = (1n << BigInt(width)) - 1n;
  raw &= mask;
  const value = raw & (1n << BigInt(width - 1)) ? raw - (1n << BigInt(width)) : raw;
  return { ...round({ n: value, d: 1n }, target, mxcsr), pre: 0 };
}
export function floatToInt(
  raw: bigint,
  source: Format,
  width: 32 | 64,
  truncation: boolean,
  mxcsr: number,
) {
  const c = classify(raw, source),
    indefinite = 1n << BigInt(width - 1),
    mask = (1n << BigInt(width)) - 1n;
  if (c.nan || c.inf) return { bits: indefinite, pre: 1, post: 0 };
  if (mxcsr & 64 && c.denormal) return { bits: 0n, pre: 0, post: 0 };
  const v = rational(raw, source),
    negative = v.n < 0n,
    n = negative ? -v.n : v.n,
    q = n / v.d,
    r = n % v.d,
    rc = truncation ? 3 : (mxcsr >>> 13) & 3;
  let magnitude = q;
  if (r !== 0n) {
    if (rc === 0 && (2n * r > v.d || (2n * r === v.d && (q & 1n) !== 0n))) magnitude++;
    else if ((rc === 1 && negative) || (rc === 2 && !negative)) magnitude++;
  }
  const value = negative ? -magnitude : magnitude;
  return value < -indefinite || value >= indefinite
    ? { bits: indefinite, pre: 1, post: 0 }
    : { bits: value & mask, pre: 0, post: r === 0n ? 0 : 32 };
}
