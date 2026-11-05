import { operandScenarios } from './integer-memory/operands.js';
import { addressingScenarios } from './integer-memory/addressing.js';
import { boundaryScenarios } from './integer-memory/boundaries.js';

export function integerMemoryScenarios(core: WebAssembly.Module) {
  return [...operandScenarios(core), ...addressingScenarios(core), ...boundaryScenarios(core)];
}
