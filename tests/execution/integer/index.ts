import { registerScenarios } from './registers.js';
import { integerConditionsScenarios } from './conditions/index.js';
import { integerMemoryScenarios } from './memory/index.js';
import { scalarDataScenarios } from './data/index.js';
import { integerArithmeticScenarios } from './arithmetic/index.js';
import { multiplyAndDivideScenarios } from './multiply/index.js';

export function integerScenarios(core: WebAssembly.Module) {
  return [
    ...registerScenarios(core),
    ...integerConditionsScenarios(core),
    ...integerMemoryScenarios(core),
    ...scalarDataScenarios(core),
    ...integerArithmeticScenarios(core),
    ...multiplyAndDivideScenarios(core),
  ];
}
