import { operandScenarios } from './operands.js';

export function stackAndNearControlFlowScenarios(core: WebAssembly.Module) {
  return operandScenarios(core);
}
