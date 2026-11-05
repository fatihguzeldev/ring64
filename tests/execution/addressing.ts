import type { Scenario } from './fixture.js';
import { addressingOperandScenarios } from './addressing/operands.js';
import { addressingObservationScenarios } from './addressing/observation.js';

export function addressingScenarios(core: WebAssembly.Module): Scenario[] {
  return [...addressingOperandScenarios(core), ...addressingObservationScenarios(core)];
}
