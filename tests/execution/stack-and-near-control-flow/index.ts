import { operandScenarios } from './operands.js';
import { boundaryScenarios } from './boundaries.js';
import { observationScenarios } from './observation.js';
import { routingScenarios } from './routing.js';

export function stackAndNearControlFlowScenarios(core: WebAssembly.Module) {
  return [
    ...operandScenarios(core),
    ...boundaryScenarios(core),
    ...observationScenarios(core),
    ...routingScenarios(core),
  ];
}
