import { faultScenarios } from './faults.js';
import { reuseScenarios } from './reuse.js';
import type { Scenario } from './fixture.js';
export function farControlScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [...faultScenarios(compiler), ...reuseScenarios(compiler)];
}
