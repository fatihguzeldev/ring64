import type { Cpu } from '../../../host/index.js';
import { equal } from '../../support/fixture.js';
export { LONG, changed, context, input, using, type Scenario } from '../modes/fixture.js';
export { outcome } from '../strings/fixture.js';
export const MASK128 = (1n << 128n) - 1n;
export function banks(): bigint[] {
  return Array.from(
    { length: 16 },
    (_, i) => (0x102030405060708090a0b0c0d0e0f001n * BigInt(i + 1)) & MASK128,
  );
}
export function xmm(cpu: Cpu, expected: bigint[]): void {
  const actual = cpu.readXmmState();
  equal(actual.length, 16, 'XMM bank count');
  actual.forEach((value, i) => equal(value, expected[i], `XMM${i}`));
}
export function lanes(value: bigint, width: number): bigint[] {
  const mask = (1n << BigInt(width)) - 1n;
  return Array.from({ length: 128 / width }, (_, i) => (value >> BigInt(i * width)) & mask);
}
export function vector(values: bigint[], width: number): bigint {
  const mask = (1n << BigInt(width)) - 1n;
  return values.reduce((result, value, i) => result | ((value & mask) << BigInt(i * width)), 0n);
}
export function signed(value: bigint, width: number): bigint {
  return value & (1n << BigInt(width - 1)) ? value - (1n << BigInt(width)) : value;
}
export function bytes(value: bigint, length = 16): string {
  return Array.from({ length }, (_, i) =>
    Number((value >> BigInt(i * 8)) & 255n)
      .toString(16)
      .padStart(2, '0'),
  ).join('');
}
export const profiles = [
  { name: 'long64', mode: 'long64' as const, code32: true, stack32: true },
  ...(['real', 'protected', 'compatibility'] as const).flatMap((mode) =>
    [false, true].flatMap((code32) =>
      [false, true].map((stack32) => ({
        name: `${mode}/${+code32}/${+stack32}`,
        mode,
        code32,
        stack32,
      })),
    ),
  ),
  { name: 'virtual8086', mode: 'virtual8086' as const, code32: false, stack32: false },
];
