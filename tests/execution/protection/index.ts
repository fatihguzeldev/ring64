import { modeScenarios as descriptorModeScenarios } from './modes.js';
import { reuseScenarios } from './reuse.js';
import { valueScenarios } from './values.js';
import { faultScenarios } from './faults.js';
import type { Scenario } from './fixture.js';
export function protectionScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...descriptorModeScenarios(compiler),
    ...valueScenarios(compiler),
    ...faultScenarios(compiler),
    ...reuseScenarios(compiler),
  ];
}
