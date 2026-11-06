import { operandScenarios } from './operands.js';
import { addressingScenarios } from './addressing.js';
import { boundaryScenarios } from './boundaries.js';
import { observationScenarios } from './observation.js';

export function integerMemoryScenarios(core: WebAssembly.Module) {
  return [
    ...operandScenarios(core),
    ...addressingScenarios(core),
    ...boundaryScenarios(core),
    ...observationScenarios(core),
  ];
}
