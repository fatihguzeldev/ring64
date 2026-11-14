import { operandScenarios } from './operands.js';
import { accessScenarios } from './access.js';
import { decodeScenarios } from './decode.js';
import { limitScenarios } from './limits.js';
import { observationScenarios } from './observation.js';
import { routingScenarios } from './routing.js';
import { compoundMatrixScenarios } from './compound-matrix.js';
import { compoundLiteralScenarios } from './compound-literals.js';
import { compoundDecodeScenarios } from './compound-decode.js';
import { compoundPagingScenarios } from './compound-paging.js';

export function stackScenarios(core: WebAssembly.Module) {
  return [
    ...operandScenarios(core),
    ...accessScenarios(core),
    ...decodeScenarios(core),
    ...limitScenarios(core),
    ...observationScenarios(core),
    ...routingScenarios(core),
    ...compoundMatrixScenarios(core),
    ...compoundLiteralScenarios(core),
    ...compoundDecodeScenarios(core),
    ...compoundPagingScenarios(core),
  ];
}
