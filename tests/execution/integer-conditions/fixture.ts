import type { RunResult, State } from '../../../host/index.js';
import { CODE, initial, equal, exit } from '../fixture.js';

export const defaultRam = { ramBase: 0x4000n, ram: '00' };

export function input(rip = CODE, registers: Record<number, bigint> = {}, flags = 0x8d7n) {
  return initial(rip, { 3: 0x1122334400000003n, ...registers }, flags);
}

export function logicalExit(
  result: RunResult,
  reason: RunResult['reason'],
  budget: bigint,
  retired: bigint,
  expected: State,
) {
  exit(result, reason, budget, retired, { ...expected, flags: result.state.flags });
  equal(result.state.flags & ~0x8d7n, 0n, 'logical flags contain only admitted bits');
  equal(result.state.flags & 2n, 2n, 'logical flags retain fixed bit one');
  equal(result.state.flags & 0x8c7n, expected.flags, 'defined logical flags');
}

export function noFault(result: RunResult) {
  equal(result.fault, undefined, 'unexpected access fault metadata');
}
