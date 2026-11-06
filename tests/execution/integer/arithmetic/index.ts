import { carryScenarios } from './carry.js';
import { unaryScenarios } from './unary.js';
import { shiftScenarios } from './shifts.js';
import { bitScenarios } from './bits.js';
import { arithmeticLiteralScenarios } from './literals.js';
import { arithmeticBoundaryScenarios } from './boundaries.js';
import { arithmeticObservationScenarios } from './observation.js';

export function integerArithmeticScenarios(core: WebAssembly.Module) {
  return [
    ...carryScenarios(core),
    ...unaryScenarios(core),
    ...shiftScenarios(core),
    ...bitScenarios(core),
    ...arithmeticLiteralScenarios(core),
    ...arithmeticBoundaryScenarios(core),
    ...arithmeticObservationScenarios(core),
  ];
}
