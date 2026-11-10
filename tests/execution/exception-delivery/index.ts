import type { Scenario } from '../../support/fixture.js';
import { basicScenarios } from './basic.js';
import { boundaryScenarios } from './boundaries.js';
import { numericScenarios } from './numeric.js';
import { escalationScenarios } from './escalation.js';

export function exceptionDeliveryScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...basicScenarios(compiler),
    ...boundaryScenarios(compiler),
    ...numericScenarios(compiler),
    ...escalationScenarios(compiler),
  ];
}
