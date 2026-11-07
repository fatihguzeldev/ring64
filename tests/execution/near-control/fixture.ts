import type { RunResult, State } from '../../../host/index.js';
import { equal, exit } from '../../support/fixture.js';
export { LONG, context, input, changed, using, type Scenario } from '../modes/fixture.js';

export function outcome(
  result: RunResult,
  reason: RunResult['reason'],
  budget: bigint,
  retired: bigint,
  expected: State,
): void {
  exit(result, reason, budget, retired, expected);
  equal(result.repeatIterations, 0n, 'bounded instruction has no repeated elements');
  equal(result.remainingRepeatBudget, 0n, 'zero repetition quota is unchanged');
}

export function bytes(value: bigint, width: number): string {
  return Array.from({ length: width }, (_, index) =>
    Number((value >> BigInt(index * 8)) & 0xffn)
      .toString(16)
      .padStart(2, '0'),
  ).join('');
}

export function patch(frame: string, offset: number, value: string): string {
  return frame.slice(0, offset * 2) + value + frame.slice(offset * 2 + value.length);
}
