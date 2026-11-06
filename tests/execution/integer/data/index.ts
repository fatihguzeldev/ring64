import { literalScenarios } from './literals.js';
import { movementScenarios } from './movement.js';
import { arithmeticScenarios } from './arithmetic.js';
import { dataConditionScenarios } from './conditions.js';
import { dataBoundaryScenarios } from './boundaries.js';
import { dataObservationScenarios } from './observation.js';

export function scalarDataScenarios(core: WebAssembly.Module) {
  return [
    ...literalScenarios(core),
    ...movementScenarios(core),
    ...arithmeticScenarios(core),
    ...dataConditionScenarios(core),
    ...dataBoundaryScenarios(core),
    ...dataObservationScenarios(core),
  ];
}
