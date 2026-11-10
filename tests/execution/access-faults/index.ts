import type { Scenario } from '../../support/fixture.js';
import { decodeScenarios } from './decode.js';
import { runtimeScenarios } from './runtime.js';
import { recoveryScenarios } from './recovery.js';
import { entryScenarios } from './entry.js';
import { correctnessReviewScenarios } from './correctness-review.js';
import { boundaryNumericScenarios } from './boundary-numeric.js';
export function accessFaultScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...decodeScenarios(compiler),
    ...runtimeScenarios(compiler),
    ...recoveryScenarios(compiler),
    ...entryScenarios(compiler),
    ...correctnessReviewScenarios(compiler),
    ...boundaryNumericScenarios(compiler),
  ];
}
