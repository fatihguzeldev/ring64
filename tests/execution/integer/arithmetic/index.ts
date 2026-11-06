import { carryScenarios } from './carry.js';
import { unaryScenarios } from './unary.js';

export function integerArithmeticScenarios(core: WebAssembly.Module) {
  return [...carryScenarios(core), ...unaryScenarios(core)];
}
