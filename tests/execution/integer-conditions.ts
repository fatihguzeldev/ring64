import { logicalScenarios } from './integer-conditions/logical.js';
import { flagScenarios } from './integer-conditions/flags.js';
import { conditionScenarios } from './integer-conditions/conditions.js';
import { observationScenarios } from './integer-conditions/observation.js';
import { boundaryScenarios } from './integer-conditions/boundaries.js';

export function integerConditionsScenarios(core: WebAssembly.Module) {
  return [
    ...logicalScenarios(core),
    ...flagScenarios(core),
    ...conditionScenarios(core),
    ...observationScenarios(core),
    ...boundaryScenarios(core),
  ];
}
