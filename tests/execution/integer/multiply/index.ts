import { multiplyLiteralScenarios } from './literals.js';
import { multiplyFormScenarios } from './forms.js';
import { multiplyBoundaryScenarios } from './boundaries.js';
import { multiplyConsumerScenarios } from './consumers.js';
import { multiplyRestartScenarios } from './restart.js';
import { multiplyEntryScenarios } from './entries.js';

export function multiplyAndDivideScenarios(core: WebAssembly.Module) {
  return [
    ...multiplyLiteralScenarios(core),
    ...multiplyFormScenarios(core),
    ...multiplyBoundaryScenarios(core),
    ...multiplyConsumerScenarios(core),
    ...multiplyRestartScenarios(core),
    ...multiplyEntryScenarios(core),
  ];
}
