import { carryScenarios } from './carry.js';

export function integerArithmeticScenarios(core: WebAssembly.Module) {
  return [...carryScenarios(core)];
}
