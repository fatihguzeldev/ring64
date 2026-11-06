import { carryScenarios } from './carry.js';
import { unaryScenarios } from './unary.js';
import { shiftScenarios } from './shifts.js';

export function integerArithmeticScenarios(core: WebAssembly.Module) {
  return [...carryScenarios(core), ...unaryScenarios(core), ...shiftScenarios(core)];
}
