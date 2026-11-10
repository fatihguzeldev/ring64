import type { Scenario } from '../../support/fixture.js';
import { basicScenarios } from './basic.js';
import { boundaryScenarios } from './boundaries.js';

export function exceptionDeliveryScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [...basicScenarios(compiler), ...boundaryScenarios(compiler)];
}
