import { type Scenario } from './fixture.js';
import { literalScenarios } from './literals.js';
import { widthScenarios } from './widths.js';
import { boundaryScenarios } from './boundaries.js';
export function modeScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...literalScenarios(compiler),
    ...widthScenarios(compiler),
    ...boundaryScenarios(compiler),
  ];
}
