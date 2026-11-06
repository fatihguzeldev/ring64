import { registerScenarios } from './registers.js';
import { integerConditionsScenarios } from './conditions/index.js';
import { integerMemoryScenarios } from './memory/index.js';

export function integerScenarios(core: WebAssembly.Module) {
  return [
    ...registerScenarios(core),
    ...integerConditionsScenarios(core),
    ...integerMemoryScenarios(core),
  ];
}
