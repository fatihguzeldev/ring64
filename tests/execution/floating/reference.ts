// Independent integer/rational reference: no host floating-point arithmetic.
export type Format = 32 | 64;
export type Arithmetic = 'add' | 'sub' | 'mul' | 'div' | 'sqrt' | 'min' | 'max';
type Rational = { n: bigint; d: bigint };
const abs = (n: bigint) => (n < 0n ? -n : n);
export const shape = (f: Format) => ({
  fraction: f === 32 ? 23 : 52,
  bias: f === 32 ? 127 : 1023,
  min: f === 32 ? -126 : -1022,
  max: f === 32 ? 127 : 1023,
});
export function classify(raw: bigint, f: Format) {
  const s = shape(f),
    sign = raw >> BigInt(f - 1) !== 0n,
    fraction = raw & ((1n << BigInt(s.fraction)) - 1n);
  const exponent = Number((raw >> BigInt(s.fraction)) & BigInt(2 * s.bias + 1));
  const nan = exponent === 2 * s.bias + 1 && fraction !== 0n;
  return {
    sign,
    exponent,
    fraction,
    nan,
    snan: nan && (fraction & (1n << BigInt(s.fraction - 1))) === 0n,
    inf: exponent === 2 * s.bias + 1 && fraction === 0n,
    zero: exponent === 0 && fraction === 0n,
    denormal: exponent === 0 && fraction !== 0n,
  };
}
function pow2(e: number): Rational {
  return e >= 0 ? { n: 1n << BigInt(e), d: 1n } : { n: 1n, d: 1n << BigInt(-e) };
}
function mul(a: Rational, b: Rational): Rational {
  return { n: a.n * b.n, d: a.d * b.d };
}
function add(a: Rational, b: Rational): Rational {
  return { n: a.n * b.d + b.n * a.d, d: a.d * b.d };
}
function divide(a: Rational, b: Rational): Rational {
  return { n: a.n * b.d * (b.n < 0n ? -1n : 1n), d: a.d * abs(b.n) };
}
export function rational(raw: bigint, f: Format): Rational {
  const c = classify(raw, f),
    s = shape(f);
  if (c.nan || c.inf) throw Error('finite reference required');
  return mul(
    {
      n:
        (c.sign ? -1n : 1n) *
        (c.exponent === 0 ? c.fraction : (1n << BigInt(s.fraction)) | c.fraction),
      d: 1n,
    },
    pow2((c.exponent === 0 ? s.min : c.exponent - s.bias) - s.fraction),
  );
}
function less(a: Rational, b: Rational) {
  return a.n * b.d < b.n * a.d;
}
function equal(a: Rational, b: Rational) {
  return a.n * b.d === b.n * a.d;
}
function intRound(n: bigint, d: bigint, rc: number, negative: boolean) {
  const q = n / d,
    r = n % d;
  return (
    q +
    (r === 0n
      ? 0n
      : rc === 0
        ? 2n * r > d || (2n * r === d && (q & 1n) !== 0n)
          ? 1n
          : 0n
        : rc === 1
          ? negative
            ? 1n
            : 0n
          : rc === 2
            ? !negative
              ? 1n
              : 0n
            : 0n)
  );
}
function scaled(v: Rational, e: number) {
  return e >= 0 ? { n: v.n, d: v.d << BigInt(e) } : { n: v.n << BigInt(-e), d: v.d };
}
export function round(value: Rational, f: Format, mxcsr: number, zeroNegative = false) {
  const s = shape(f),
    rc = (mxcsr >>> 13) & 3,
    negative = value.n < 0n || (value.n === 0n && zeroNegative),
    sign = negative ? 1n << BigInt(f - 1) : 0n;
  const v = { n: abs(value.n), d: value.d };
  if (v.n === 0n) return { bits: sign, post: 0 };
  let e = v.n.toString(2).length - v.d.toString(2).length;
  if (less(v, pow2(e))) e--;
  const u = scaled(v, e - s.fraction);
  let m = intRound(u.n, u.d, rc, negative);
  const unboundedInexact = u.n % u.d !== 0n;
  if (m === 1n << BigInt(s.fraction + 1)) {
    m >>= 1n;
    e++;
  }
  if (e > s.max) {
    const masked = (mxcsr & 0x400) !== 0,
      inf = rc === 0 || (rc === 2 && !negative) || (rc === 1 && negative);
    return {
      bits:
        sign |
        (inf
          ? BigInt(2 * s.bias + 1) << BigInt(s.fraction)
          : (BigInt(2 * s.bias + 1) << BigInt(s.fraction)) - 1n),
      post: 8 | (masked || unboundedInexact ? 32 : 0),
    };
  }
  const tiny = e < s.min;
  if (tiny) {
    const b = scaled(v, s.min - s.fraction),
      q = intRound(b.n, b.d, rc, negative),
      inexact = b.n % b.d !== 0n,
      um = (mxcsr & 0x800) !== 0;
    if (um && (mxcsr & 0x8000) !== 0) return { bits: sign, post: 48 };
    return {
      bits: sign | q,
      post: (um ? (inexact ? 16 : 0) : 16) | ((um ? inexact : unboundedInexact) ? 32 : 0),
    };
  }
  return {
    bits: sign | (BigInt(e + s.bias) << BigInt(s.fraction)) | (m - (1n << BigInt(s.fraction))),
    post: unboundedInexact ? 32 : 0,
  };
}
function root(raw: bigint, f: Format, mxcsr: number) {
  const v = rational(raw, f),
    s = shape(f);
  let lo = 0n,
    hi = (BigInt(2 * s.bias + 1) << BigInt(s.fraction)) - 1n;
  while (lo < hi) {
    const mid = (lo + hi + 1n) >> 1n,
      m = rational(mid, f);
    if (less(v, mul(m, m))) hi = mid - 1n;
    else lo = mid;
  }
  const floor = rational(lo, f);
  if (equal(mul(floor, floor), v)) return { bits: lo, post: 0 };
  const rc = (mxcsr >>> 13) & 3;
  if (rc === 1 || rc === 3) return { bits: lo, post: 32 };
  if (rc === 2) return { bits: lo + 1n, post: 32 };
  const upper = rational(lo + 1n, f),
    mid = mul(add(floor, upper), { n: 1n, d: 2n }),
    square = mul(mid, mid);
  return { bits: less(v, square) ? lo : equal(v, square) ? lo + (lo & 1n) : lo + 1n, post: 32 };
}
export function lane(op: Arithmetic, left: bigint, right: bigint, f: Format, mxcsr: number) {
  const mask = (1n << BigInt(f)) - 1n,
    sign = 1n << BigInt(f - 1),
    s = shape(f),
    qnan = 1n << BigInt(s.fraction - 1),
    indefinite = sign | (BigInt(2 * s.bias + 1) << BigInt(s.fraction)) | qnan;
  left &= mask;
  right &= mask;
  if (mxcsr & 64) {
    if (classify(left, f).denormal) left &= sign;
    if (classify(right, f).denormal) right &= sign;
  }
  const a = classify(left, f),
    b = classify(right, f);
  const unary = op === 'sqrt';
  if (unary) {
    left = right;
  }
  const x = unary ? b : a,
    y = b;
  if (x.nan || (!unary && y.nan)) {
    const invalid = op === 'min' || op === 'max' || x.snan || (!unary && y.snan);
    return {
      bits: op === 'min' || op === 'max' ? right : (x.nan ? left : right) | qnan,
      pre: invalid ? 1 : 0,
      post: 0,
    };
  }
  const negative = x.sign !== y.sign;
  const invalid =
    op === 'sqrt'
      ? b.sign && !b.zero
      : op === 'add' || op === 'sub'
        ? a.inf && b.inf && (op === 'add' ? a.sign !== b.sign : a.sign === b.sign)
        : op === 'mul'
          ? (a.inf && b.zero) || (b.inf && a.zero)
          : op === 'div'
            ? (a.zero && b.zero) || (a.inf && b.inf)
            : false;
  if (invalid) return { bits: indefinite, pre: 1, post: 0 };
  if (op === 'div' && b.zero && !a.zero && !a.inf)
    return {
      bits: (negative ? sign : 0n) | (BigInt(2 * s.bias + 1) << BigInt(s.fraction)),
      pre: 4,
      post: 0,
    };
  const pre = x.denormal || (!unary && y.denormal) ? 2 : 0;
  if (op === 'min' || op === 'max') {
    if (a.zero && b.zero) return { bits: right, pre, post: 0 };
    const aLess = a.inf ? a.sign : b.inf ? !b.sign : less(rational(left, f), rational(right, f));
    return { bits: (op === 'min' ? aLess : !aLess) ? left : right, pre, post: 0 };
  }
  if (op === 'sqrt') {
    if (b.inf || b.zero) return { bits: right, pre, post: 0 };
    return { ...root(right, f, mxcsr), pre };
  }
  if (a.inf || b.inf) {
    let bits: bigint;
    if (op === 'div')
      bits = b.inf
        ? negative
          ? sign
          : 0n
        : (negative ? sign : 0n) | (BigInt(2 * s.bias + 1) << BigInt(s.fraction));
    else if (op === 'mul')
      bits = (negative ? sign : 0n) | (BigInt(2 * s.bias + 1) << BigInt(s.fraction));
    else bits = a.inf ? left : right ^ (op === 'sub' ? sign : 0n);
    return { bits, pre, post: 0 };
  }
  const av = rational(left, f),
    bv = rational(right, f);
  let value: Rational;
  if (op === 'mul') value = mul(av, bv);
  else if (op === 'div') value = divide(av, bv);
  else value = add(av, { n: op === 'sub' ? -bv.n : bv.n, d: bv.d });
  const zeroNegative =
    op === 'mul' || op === 'div'
      ? negative
      : a.zero && b.zero && a.sign === (op === 'sub' ? !b.sign : b.sign)
        ? a.sign
        : ((mxcsr >>> 13) & 3) === 1;
  return { ...round(value, f, mxcsr, zeroNegative), pre };
}
export function arithmetic(
  op: Arithmetic,
  left: bigint,
  right: bigint,
  f: Format,
  scalar: boolean,
  mxcsr: number,
) {
  const count = scalar ? 1 : 128 / f,
    mask = (1n << BigInt(f)) - 1n,
    values = Array.from({ length: count }, (_, i) =>
      lane(op, (left >> BigInt(i * f)) & mask, (right >> BigInt(i * f)) & mask, f, mxcsr),
    );
  const pre = values.reduce((flags, v) => flags | v.pre, 0),
    unmaskedPre = pre & ~(mxcsr >>> 7) & 63;
  if (unmaskedPre)
    return {
      bits: left,
      mxcsr: mxcsr | pre,
      raised: pre,
      unmasked: unmaskedPre,
      stage: 'pre-computation' as const,
    };
  const post = values.reduce((flags, v) => flags | v.post, 0),
    raised = pre | post,
    unmasked = raised & ~(mxcsr >>> 7) & 63;
  if (unmasked)
    return {
      bits: left,
      mxcsr: mxcsr | raised,
      raised,
      unmasked,
      stage: 'post-computation' as const,
    };
  let bits = scalar ? left & ~mask : 0n;
  values.forEach((v, i) => {
    bits |= v.bits << BigInt(i * f);
  });
  return { bits, mxcsr: mxcsr | raised, raised, unmasked: 0, stage: undefined };
}
