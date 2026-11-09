import type {
  Cpu,
  ExecutionContextSnapshot,
  RunResult,
  StateSnapshot,
} from '../../../host/index.js';
import { hex, equal } from '../../support/fixture.js';
import { same } from '../far-control/fixture.js';
export { createCpu } from '../../../host/index.js';
export type {
  Cpu,
  ExecutionContext,
  ExecutionContextSnapshot,
  StateSnapshot,
} from '../../../host/index.js';
export { using } from '../modes/fixture.js';
export { check, equal, hex, LIMITS, throws, type Scenario } from '../../support/fixture.js';
export {
  snapshot,
  loadedCode,
  loadedData,
  same,
  bytes,
  CODE16,
  CODE32,
  CODE64,
  DATA16,
  DATA32,
  preserveNumeric,
} from '../far-control/fixture.js';
export { initial, outcome, debug } from '../system-flags/fixture.js';

export const FILL = 'a5'.repeat(256);
export const STACK = 0x6f80n;
export const TSS = { selector: 0x28, valid: true, base: 0x5000n, limit: 0x67, attributes: 0x8b };

function little(value: bigint, width: number): number[] {
  return Array.from({ length: width }, (_, index) => Number((value >> BigInt(index * 8)) & 255n));
}
export function image(values: readonly bigint[], width: number): Uint8Array {
  return Uint8Array.from(values.flatMap((value) => little(value, width)));
}
export function encoded(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Independent byte encoders for authored descriptors; execution expectations use explicit slots.
export function gate(
  width: 16 | 32 | 64,
  selector = 8,
  target = 0x2000n,
  dpl = 3,
  trap = false,
  ist = 0,
): string {
  const bytes = [
    ...little(target, 2),
    ...little(BigInt(selector), 2),
    width === 64 ? ist : 0,
    0x80 | (dpl << 5) | (width === 16 ? 6 : 14) | Number(trap),
    ...(width === 16 ? [0, 0] : little(target >> 16n, 2)),
  ];
  if (width === 64) bytes.push(...little(target >> 32n, 4), 0, 0, 0, 0);
  return encoded(Uint8Array.from(bytes));
}
export function tssDescriptor(base = 0x5000n, limit = 0x67, type = 9, wide = false): string {
  const bytes = [
    ...little(BigInt(limit), 2),
    ...little(base, 3),
    0x80 | type,
    (limit >>> 16) & 15,
    ...little(base >> 24n, 1),
  ];
  if (wide) bytes.push(...little(base >> 32n, 4), 0, 0, 0, 0);
  return encoded(Uint8Array.from(bytes));
}
export function withGate(execution: ExecutionContextSnapshot, vector = 0x40): bigint {
  execution.idtr = { base: 0x8000n, limit: 0xfff };
  return (
    0x8000n +
    BigInt(
      vector *
        (execution.mode === 'real'
          ? 4
          : execution.mode === 'long64' || execution.mode === 'compatibility'
            ? 16
            : 8),
    )
  );
}
export function fullState(
  actual: RunResult,
  before: StateSnapshot,
  rip: bigint,
  sp = before.registers[4]!,
  flags = before.flags,
): void {
  noDeliveryFault(actual);
  same(
    actual.state,
    {
      ...before,
      registers: before.registers.map((value, index) => (index === 4 ? sp : value)),
      rip,
      flags,
      interruptibility: { sti: false, ss: false },
    },
    'complete scalar continuation',
  );
}
export function guarded(
  cpu: Cpu,
  base: bigint,
  original: string,
  writes: readonly [bigint, Uint8Array][],
): void {
  const expected = hex(original);
  for (const [address, bytes] of writes) expected.set(bytes, Number(address - base));
  same(cpu.readMemory(base, expected.length), expected, 'whole memory and guards');
}
export function noDeliveryFault(result: RunResult): void {
  for (const key of [
    'fault',
    'segmentFault',
    'alignmentFault',
    'generalProtectionFault',
    'protectionFault',
    'systemMemoryFault',
    'debugException',
    'x87Exception',
    'simdException',
  ] as const)
    equal(result[key], undefined, `no ${key}`);
}
