import type { Scenario } from './fixture.js';
import { literalScenarios } from './literals.js';
import { modeScenarios } from './modes.js';
import { memoryScenarios } from './memory.js';
import { boundaryScenarios } from './boundaries.js';

export function x87Scenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...literalScenarios(compiler),
    ...modeScenarios(compiler),
    ...memoryScenarios(compiler),
    ...boundaryScenarios(compiler),
  ];
}
