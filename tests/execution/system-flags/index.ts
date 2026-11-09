import { stateScenarios } from './state.js';
import { transferScenarios } from './transfers.js';
import { privilegeScenarios } from './privileges.js';
import { steppingScenarios } from './stepping.js';
import { repeatedScenarios } from './repeated.js';
import { shadowScenarios } from './shadows.js';
import { aliasScenarios } from './aliases.js';
import { preservationScenarios } from './preservation.js';
import { memoryScenarios } from './memory.js';
import { numericBoundaryScenarios } from './numeric-boundaries.js';
import { cacheScenarios } from './cache.js';
import { acceptanceBoundaryScenarios } from './acceptance-boundaries.js';
import { reviewScenarios } from './review.js';
import type { Scenario } from './fixture.js';

export function systemFlagScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...stateScenarios(compiler),
    ...transferScenarios(compiler),
    ...privilegeScenarios(compiler),
    ...steppingScenarios(compiler),
    ...repeatedScenarios(compiler),
    ...shadowScenarios(compiler),
    ...aliasScenarios(compiler),
    ...preservationScenarios(compiler),
    ...memoryScenarios(compiler),
    ...numericBoundaryScenarios(compiler),
    ...cacheScenarios(compiler),
    ...acceptanceBoundaryScenarios(compiler),
    ...reviewScenarios(compiler),
  ];
}
