import { reviewBoundaryScenarios } from './review-boundaries.js';
import { activityReviewScenarios } from './review-activity.js';
import { registerMatrixScenarios } from './register-matrix.js';
import { correctnessReviewScenarios } from './review-correctness.js';
import { transitionScenarios } from './transitions.js';
import { operandScenarios } from './operands.js';
import { shadowScenarios } from './shadows.js';
import { dataScenarios } from './data.js';
import { bankScenarios } from './bank.js';
import type { Scenario } from '../../support/fixture.js';
import { registerScenarios } from './registers.js';
import { executeScenarios } from './execute.js';
import { recoveryScenarios } from './recovery.js';
export function hardwareDebugScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...bankScenarios(compiler),
    ...dataScenarios(compiler),
    ...operandScenarios(compiler),
    ...shadowScenarios(compiler),
    ...transitionScenarios(compiler),
    ...registerScenarios(compiler),
    ...registerMatrixScenarios(compiler),
    ...correctnessReviewScenarios(compiler),
    ...reviewBoundaryScenarios(compiler),
    ...activityReviewScenarios(compiler),
    ...executeScenarios(compiler),
    ...recoveryScenarios(compiler),
  ];
}
