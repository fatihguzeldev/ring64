import { type Scenario } from './fixture.js';
import { literalScenarios } from './literals.js';
import { matrixScenarios } from './matrix.js';
import { boundaryScenarios } from './boundaries.js';
export function stringScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...literalScenarios(compiler),
    ...matrixScenarios(compiler),
    ...boundaryScenarios(compiler),
  ];
}
