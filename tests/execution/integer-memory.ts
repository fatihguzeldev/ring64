import { operandScenarios } from './integer-memory/operands.js';
import { addressingScenarios } from './integer-memory/addressing.js';

export function integerMemoryScenarios(core: WebAssembly.Module) {
  return [...operandScenarios(core), ...addressingScenarios(core)];
}
