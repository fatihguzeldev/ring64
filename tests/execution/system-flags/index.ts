import { stateScenarios } from './state.js';
import { transferScenarios } from './transfers.js';
import { privilegeScenarios } from './privileges.js';
import type { Scenario } from './fixture.js';

export function systemFlagScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...stateScenarios(compiler),
    ...transferScenarios(compiler),
    ...privilegeScenarios(compiler),
  ];
}
