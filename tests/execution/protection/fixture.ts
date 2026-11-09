import { captureContext } from '../../../host/context.js';
import type { ExecutionContextSnapshot, SegmentName } from '../../../host/index.js';
import { context, segment } from '../modes/fixture.js';
export { using, input as initial, changed } from '../modes/fixture.js';
export { equal, check, state, hex, LIMITS, type Scenario } from '../../support/fixture.js';

export function snapshot(
  mode: ExecutionContextSnapshot['mode'] = 'long64',
  cpl = 0,
): ExecutionContextSnapshot {
  const value = captureContext(
    mode === 'long64' ? { mode, fsBase: 0n, gsBase: 0n } : context(mode),
  );
  value.cpl = mode === 'virtual8086' ? 3 : cpl;
  for (const name of ['cs', 'ss', 'ds', 'es', 'fs', 'gs'] as SegmentName[])
    value.segments[name].dpl = value.cpl;
  value.gdtr = { base: 0x4000n, limit: 31 };
  return value;
}

export { segment };
