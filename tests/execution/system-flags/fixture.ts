import type { RunResult, StateSnapshot } from '../../../host/index.js';
import { input } from '../modes/fixture.js';
import { check, equal } from '../../support/fixture.js';
export { createCpu } from '../../../host/index.js';
export type { Cpu, ExecutionContextSnapshot, State } from '../../../host/index.js';
export { using } from '../modes/fixture.js';
export {
  snapshot,
  profiles,
  bytes,
  same,
  preserveNumeric,
  loadedData,
  CODE16,
  CODE32,
  CODE64,
  DATA16,
  DATA32,
} from '../far-control/fixture.js';
export { hex, check, equal, LIMITS, throws, state, type Scenario } from '../../support/fixture.js';

export const FLAGS_MASK = 0x3d7fd7n;
export const RF = 0x10000n;
export const TF = 0x100n;

export function initial(
  rip = 0x1000n,
  registers: Record<number, bigint> = {},
  flags = 2n,
  interruptibility = { sti: false, ss: false },
): StateSnapshot {
  return {
    ...input(rip, registers, flags),
    interruptibility: { ...interruptibility },
    event: { kind: 'ready' },
  };
}

export function outcome(
  result: RunResult,
  reason: string,
  budget: bigint,
  retired: bigint,
  repeatBudget = budget,
  iterations = 0n,
): void {
  equal(result.reason, reason, 'exit reason');
  equal(result.retired, retired, 'retirement');
  equal(result.remaining, budget - retired, 'instruction allowance');
  equal(result.repeatIterations, iterations, 'completed elements');
  equal(result.remainingRepeatBudget, repeatBudget - iterations, 'repeat allowance');
}

export function debug(
  result: RunResult,
  source: bigint,
  resume: bigint,
  completed: boolean,
  resumeFlags: bigint,
): void {
  equal(result.reason, 'debug-exception', 'single-step reason');
  const trap = result.debugException;
  check(trap, 'typed single-step trap');
  equal(trap.vector, 1, 'debug vector');
  equal(trap.class, 'trap', 'debug class');
  equal(trap.cause, 'single-step', 'debug cause');
  equal(trap.instructionPc, source, 'completed source PC');
  equal(trap.resumePc, resume, 'prepared continuation');
  equal(trap.instructionCompleted, completed, 'instruction completion');
  equal(trap.resumeFlags, resumeFlags, 'architectural saved flags');
  equal(result.state.rip, resume, 'published continuation');
  equal(result.fault, undefined, 'no data fault');
  equal(result.segmentFault, undefined, 'no segment fault');
  equal(result.protectionFault, undefined, 'no protection fault');
  equal(result.x87Exception, undefined, 'no numeric exception');
  equal(result.state.interruptibility.sti, false, 'trap clears STI interval');
  equal(result.state.interruptibility.ss, false, 'trap clears SS interval');
}

export function flagPrefix(
  execution: { mode: string; segments: { cs: { default32: boolean } } },
  width: number,
): string {
  const normal = execution.mode === 'long64' ? 8 : execution.segments.cs.default32 ? 4 : 2;
  return normal === width ? '' : '66';
}
