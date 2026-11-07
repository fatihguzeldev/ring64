import type { Cpu, RunResult } from '../../../host/index.js';
import { equal } from '../../support/fixture.js';
export * from '../simd/fixture.js';
export function mxcsr(cpu: Cpu, expected: number) {
  equal(cpu.readMxcsr(), expected, 'MXCSR');
}
export function noFault(result: RunResult) {
  for (const key of [
    'fault',
    'segmentFault',
    'alignmentFault',
    'simdException',
    'generalProtectionFault',
  ] as const)
    equal(result[key], undefined, `no ${key}`);
}
export function simdFault(
  result: RunResult,
  before: number,
  after: number,
  raised: number,
  unmasked: number,
  stage: 'pre-computation' | 'post-computation',
  pc = 0x1000n,
) {
  const actual = result.simdException;
  equal(actual !== undefined, true, 'numeric fault record');
  const expected = {
    instructionPc: pc,
    vector: 19,
    stage,
    raised,
    unmasked,
    mxcsrBefore: before,
    mxcsrAfter: after,
  };
  for (const key of Object.keys(expected) as (keyof typeof expected)[])
    equal(actual?.[key], expected[key], `SIMD fault ${key}`);
  for (const key of ['fault', 'segmentFault', 'alignmentFault', 'generalProtectionFault'] as const)
    equal(result[key], undefined, `exclusive ${key}`);
}
