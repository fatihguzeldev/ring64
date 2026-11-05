import { logicalScenarios } from './integer-conditions/logical.js';
import { flagScenarios } from './integer-conditions/flags.js';

export function integerConditionsScenarios(core: WebAssembly.Module) {
  return [...logicalScenarios(core), ...flagScenarios(core)];
}
