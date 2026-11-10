import type { Scenario } from '../../support/fixture.js';
import { basicScenarios } from './basic.js';
import { boundaryScenarios } from './boundaries.js';
import { numericScenarios } from './numeric.js';
import { escalationScenarios } from './escalation.js';
import { modeScenarios } from './modes.js';
import { memoryScenarios } from './memory.js';
import { stateScenarios } from './state.js';
import { frontierScenarios } from './frontiers.js';
import { lifecycleScenarios } from './lifecycle.js';

export function exceptionDeliveryScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...basicScenarios(compiler),
    ...boundaryScenarios(compiler),
    ...numericScenarios(compiler),
    ...escalationScenarios(compiler),
    ...modeScenarios(compiler),
    ...memoryScenarios(compiler),
    ...stateScenarios(compiler),
    ...frontierScenarios(compiler),
    ...lifecycleScenarios(compiler),
  ];
}
