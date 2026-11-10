export {
  using,
  snapshot,
  initial,
  same,
  image,
  encoded,
  gate,
  withGate,
  loadedCode,
  loadedData,
  CODE16,
  CODE32,
  CODE64,
  DATA16,
  DATA32,
  preserveNumeric,
  equal,
  check,
  hex,
  throws,
  createCpu,
  LIMITS,
  type Cpu,
  type Scenario,
} from '../software-events/fixture.js';
export { noDeliveryFault } from '../software-events/fixture.js';

import { equal, same } from '../software-events/fixture.js';
import type { RunResult } from '../../../host/index.js';

export const STACK = 0x7f00n;
export const FILL = 'a5'.repeat(256);

export function delivery(
  result: RunResult,
  reason: string,
  retired: bigint,
  attempts: bigint,
  remaining: bigint,
): void {
  equal(result.reason, reason, 'delivery exit');
  equal(result.retired, retired, 'retired guest instructions');
  equal(result.deliveryAttempts, attempts, 'automatic entry attempts');
  equal(result.remainingDeliveryBudget, remaining, 'remaining entry allowance');
}

export function ready(result: RunResult): void {
  same(result.state.event, { kind: 'ready' }, 'ready event state');
}
