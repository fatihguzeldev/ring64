import { basicGateScenarios } from './basic.js';
import type { Scenario } from './fixture.js';

export function callGateScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...basicGateScenarios(compiler),
  ];
}
