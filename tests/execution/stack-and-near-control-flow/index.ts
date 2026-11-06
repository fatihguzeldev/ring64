import { operandScenarios } from './operands.js';
import { boundaryScenarios } from './boundaries.js';

export function stackAndNearControlFlowScenarios(core: WebAssembly.Module) {
  return [...operandScenarios(core), ...boundaryScenarios(core)];
}
