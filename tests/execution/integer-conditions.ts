import { logicalScenarios } from './integer-conditions/logical.js';

export function integerConditionsScenarios(core: WebAssembly.Module) {
  return logicalScenarios(core);
}
