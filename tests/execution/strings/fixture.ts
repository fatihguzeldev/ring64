import type { RunResult, State } from '../../../host/index.js';
import { equal, exit } from '../../support/fixture.js';
export { LONG, context, input, changed, using, type Scenario } from '../modes/fixture.js';

export function outcome(
  result: RunResult,
  reason: RunResult['reason'],
  budget: bigint,
  retired: bigint,
  repeatBudget: bigint,
  iterations: bigint,
  expected: State,
): void {
  exit(result, reason, budget, retired, expected);
  equal(result.repeatIterations, iterations, 'completed repeated elements');
  equal(result.remainingRepeatBudget, repeatBudget - iterations, 'repeat remaining');
  if (!['data-fault', 'fetch-fault', 'target-fault', 'segment-fault'].includes(reason)) {
    equal(result.fault, undefined, 'no linear fault');
    equal(result.segmentFault, undefined, 'no segment fault');
  }
}
