import { operandScenarios } from './integer-memory/operands.js';

export function integerMemoryScenarios(core: WebAssembly.Module) {
  return operandScenarios(core);
}
