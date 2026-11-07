export { LONG, context, input, changed, using, type Scenario } from '../modes/fixture.js';
export { bytes, outcome, patch } from '../near-control/fixture.js';

export function mask(width: number): bigint {
  return (1n << BigInt(width)) - 1n;
}

export function merge(
  bank: bigint,
  value: bigint,
  width: number,
  long64: boolean,
  shift = 0,
): bigint {
  const selected = mask(width);
  if (width === 64 || (width === 32 && long64)) return value & selected;
  const start = BigInt(shift);
  return (bank & ~(selected << start)) | ((value & selected) << start);
}

export function arithmeticFlags(
  left: bigint,
  right: bigint,
  width: number,
  subtract = false,
): bigint {
  const selected = mask(width);
  const full = subtract ? left - right : left + right;
  const value = full & selected;
  const sign = 1n << BigInt(width - 1);
  let result = 0x402n;
  if (subtract ? left < right : full > selected) result |= 1n;
  let parity = 0;
  for (let byte = Number(value & 0xffn); byte !== 0; byte >>= 1) parity ^= byte & 1;
  if (parity === 0) result |= 4n;
  if (((left ^ right ^ value) & 0x10n) !== 0n) result |= 0x10n;
  if (value === 0n) result |= 0x40n;
  if ((value & sign) !== 0n) result |= 0x80n;
  if (((subtract ? left ^ right : ~(left ^ right)) & (left ^ value) & sign) !== 0n)
    result |= 0x800n;
  return result;
}
