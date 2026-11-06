export interface Pair {
  low: bigint;
  high: bigint;
}

export function unsigned(value: bigint, width: number) {
  const modulus = 2n ** BigInt(width);
  return ((value % modulus) + modulus) % modulus;
}

export function signed(value: bigint, width: number) {
  const valueBits = unsigned(value, width);
  const sign = 2n ** BigInt(width - 1);
  return valueBits < sign ? valueBits : valueBits - sign * 2n;
}

export function multiply(a: bigint, b: bigint, width: number, isSigned: boolean) {
  const modulus = 2n ** BigInt(width);
  const product = isSigned
    ? signed(a, width) * signed(b, width)
    : unsigned(a, width) * unsigned(b, width);
  const bits = unsigned(product, width * 2);
  const bound = modulus / 2n;
  const overflow = isSigned ? product < -bound || product >= bound : product >= modulus;
  return {
    low: bits % modulus,
    high: bits / modulus,
    flags: overflow ? 0x803n : 2n,
  };
}

export function divide(
  dividend: bigint,
  divisor: bigint,
  width: number,
  isSigned: boolean,
): Pair | undefined {
  const numerator = isSigned ? signed(dividend, width * 2) : unsigned(dividend, width * 2);
  const denominator = isSigned ? signed(divisor, width) : unsigned(divisor, width);
  if (denominator === 0n) return undefined;
  const quotient = numerator / denominator;
  const modulus = 2n ** BigInt(width);
  const lower = isSigned ? -modulus / 2n : 0n;
  const upper = isSigned ? modulus / 2n : modulus;
  if (quotient < lower || quotient >= upper) return undefined;
  return {
    low: unsigned(quotient, width),
    high: unsigned(numerator - quotient * denominator, width),
  };
}
