import type { Scenario } from './fixture.js';
import { literalScenarios } from './literals.js';
import { modeScenarios } from './modes.js';
import { memoryScenarios } from './memory.js';
import { boundaryScenarios } from './boundaries.js';
import { specialScenarios } from './specials.js';
import { specialMemoryScenarios } from './special-memory.js';

export function x87Scenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...literalScenarios(compiler),
    ...specialScenarios(compiler),
    ...specialMemoryScenarios(compiler),
    ...modeScenarios(compiler),
    ...memoryScenarios(compiler),
    ...boundaryScenarios(compiler),
  ];
}
