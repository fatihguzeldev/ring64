import { modeScenarios as descriptorModeScenarios } from './modes.js';
import { reuseScenarios } from './reuse.js';
import { queryScenarios } from './queries.js';
import { valueScenarios } from './values.js';
import { faultScenarios } from './faults.js';
import type { Scenario } from './fixture.js';
export function protectionScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...descriptorModeScenarios(compiler),
    ...valueScenarios(compiler),
    ...queryScenarios(compiler),
    ...faultScenarios(compiler),
    ...reuseScenarios(compiler),
  ];
}
