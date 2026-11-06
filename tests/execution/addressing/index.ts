import type { Scenario } from '../../support/fixture.js';
import { addressingOperandScenarios } from './operands.js';
import { addressingObservationScenarios } from './observation.js';

export function addressingScenarios(core: WebAssembly.Module): Scenario[] {
  return [...addressingOperandScenarios(core), ...addressingObservationScenarios(core)];
}
