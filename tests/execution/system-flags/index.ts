import { stateScenarios } from './state.js';
import { transferScenarios } from './transfers.js';
import { privilegeScenarios } from './privileges.js';
import { steppingScenarios } from './stepping.js';
import { repeatedScenarios } from './repeated.js';
import { shadowScenarios } from './shadows.js';
import { aliasScenarios } from './aliases.js';
import { preservationScenarios } from './preservation.js';
import { memoryScenarios } from './memory.js';
import { cacheScenarios } from './cache.js';
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
    ...cacheScenarios(compiler),
  ];
}
