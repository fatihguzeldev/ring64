import { logicalScenarios } from './logical.js';
import { flagScenarios } from './flags.js';
import { conditionScenarios } from './conditions.js';
import { observationScenarios } from './observation.js';
import { boundaryScenarios } from './boundaries.js';

export function integerConditionsScenarios(core: WebAssembly.Module) {
  return [
    ...logicalScenarios(core),
    ...flagScenarios(core),
    ...conditionScenarios(core),
    ...observationScenarios(core),
    ...boundaryScenarios(core),
  ];
}
