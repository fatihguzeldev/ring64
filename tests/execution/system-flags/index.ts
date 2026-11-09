import { stateScenarios } from './state.js';
import { transferScenarios } from './transfers.js';
import { privilegeScenarios } from './privileges.js';
import { steppingScenarios } from './stepping.js';
import { repeatedScenarios } from './repeated.js';
import { shadowScenarios } from './shadows.js';
import { memoryScenarios } from './memory.js';
import type { Scenario } from './fixture.js';

export function systemFlagScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...stateScenarios(compiler),
    ...transferScenarios(compiler),
    ...privilegeScenarios(compiler),
    ...steppingScenarios(compiler),
    ...repeatedScenarios(compiler),
    ...shadowScenarios(compiler),
    ...memoryScenarios(compiler),
  ];
}
