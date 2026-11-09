import { modeScenarios } from './modes.js';
import { valueScenarios } from './values.js';
import { returnScenarios } from './returns.js';
import { reuseScenarios } from './reuse.js';
import { faultScenarios } from './faults.js';
import type { Scenario } from './fixture.js';
export function farControlScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...modeScenarios(compiler),
    ...valueScenarios(compiler),
    ...returnScenarios(compiler),
    ...faultScenarios(compiler),
    ...reuseScenarios(compiler),
  ];
}
