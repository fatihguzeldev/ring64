import { captureContext } from '../../../host/context.js';
import type {
  Cpu,
  ExecutionContextSnapshot,
  SegmentSnapshot,
  RunResult,
} from '../../../host/index.js';
import { context } from '../modes/fixture.js';
export { createCpu } from '../../../host/index.js';
export { using, input as initial, changed } from '../modes/fixture.js';
export { equal, check, state, hex, LIMITS, type Scenario } from '../../support/fixture.js';
import { equal } from '../../support/fixture.js';

export const CODE16 = 'ffff0000009b0000';
export const CODE32 = 'ffff0000009bcf00';
export const CODE64 = 'ffff0000009baf00';
export const DATA16 = 'ffff000000930000';
export const DATA32 = 'ffff00000093cf00';

export function completion(
  result: RunResult,
  budget = 1n,
  retired = budget,
  repeatBudget = budget,
): void {
  equal(result.reason, 'budget', 'completion reason');
  equal(result.retired, retired, 'retired instructions');
  equal(result.remaining, budget - retired, 'instruction allowance');
  equal(result.repeatIterations, 0n, 'no repeated elements');
  equal(result.remainingRepeatBudget, repeatBudget, 'repeat allowance preserved');
}

export function loadedCode(width: 16 | 32 | 64, selector = 8, cpl = 0): SegmentSnapshot {
  return {
    selector,
    base: 0n,
    limit: width === 16 ? 0xffff : 0xffffffff,
    default32: width === 32,
    usable: true,
    type: 'readable-code',
    dpl: cpl,
    present: true,
    conforming: false,
    accessed: true,
    long: width === 64,
    granularity: width !== 16,
    available: false,
  };
}
export function loadedData(width: 16 | 32, selector = 16, cpl = 0, base = 0n): SegmentSnapshot {
  return { ...loadedCode(width, selector, cpl), base, type: 'read-write', long: false };
}

export function snapshot(
  mode: ExecutionContextSnapshot['mode'] = 'long64',
  cpl = 0,
  code32 = true,
  stack32 = true,
): ExecutionContextSnapshot {
  const value = captureContext(
    mode === 'long64' ? { mode, fsBase: 0n, gsBase: 0n } : context(mode, code32, stack32),
  );
  value.cpl = mode === 'virtual8086' ? 3 : cpl;
  for (const name of ['cs', 'ss', 'ds', 'es', 'fs', 'gs'] as const) {
    value.segments[name].dpl = value.cpl;
    if (mode !== 'real' && mode !== 'virtual8086') value.segments[name].selector |= cpl;
  }
  value.gdtr = { base: 0x4000n, limit: 127 };
  return value;
}
export function profiles(): ExecutionContextSnapshot[] {
  const result: ExecutionContextSnapshot[] = [];
  for (const mode of ['real', 'protected', 'compatibility'] as const)
    for (const code32 of [false, true])
      for (const stack32 of [false, true]) result.push(snapshot(mode, 0, code32, stack32));
  result.push(snapshot('virtual8086'), snapshot());
  return result;
}
export function operandPrefix(execution: ExecutionContextSnapshot, width: number): string {
  if (width === 64) return '48';
  const normal = execution.mode === 'long64' || execution.segments.cs.default32 ? 32 : 16;
  return normal === width ? '' : '66';
}
export function addressPrefix(execution: ExecutionContextSnapshot): string {
  return execution.mode === 'long64' || execution.segments.cs.default32 ? '' : '67';
}
export function bytes(value: bigint, width: number): string {
  return Array.from({ length: width }, (_, i) =>
    Number((value >> BigInt(i * 8)) & 255n)
      .toString(16)
      .padStart(2, '0'),
  ).join('');
}
export function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) => {
    if (typeof v === 'bigint') return v.toString(16);
    if (v !== null && typeof v === 'object' && !Array.isArray(v))
      return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)));
    return v;
  });
}
export function same(actual: unknown, expected: unknown, label: string): void {
  equal(fingerprint(actual), fingerprint(expected), label);
}
export function preserveNumeric(cpu: Cpu): () => void {
  cpu.setXmmState(
    Array.from({ length: 16 }, (_, i) => (BigInt(i + 1) << 112n) | 0xfedcba9876543210n),
  );
  cpu.setMxcsr(0xffc5);
  cpu.setX87State({
    registers: Array.from({ length: 8 }, (_, i) => (BigInt(i + 1) << 64n) | 0x123456789abcdef0n),
    controlWord: 0x37e,
    statusWord: 0x8081,
    tagWord: 0xffff,
    instructionPointer: 0x1122334455667788n,
    dataPointer: 0x8877665544332211n,
    opcode: 0x5a5,
  });
  const before = fingerprint([cpu.readXmmState(), cpu.readMxcsr(), cpu.readX87State()]);
  return () =>
    equal(
      fingerprint([cpu.readXmmState(), cpu.readMxcsr(), cpu.readX87State()]),
      before,
      'complete raw numeric/pending state',
    );
}
