import { bankScenarios } from './bank.js';
import type { Scenario } from '../../support/fixture.js';
import { registerScenarios } from './registers.js';
import { executeScenarios } from './execute.js';
import { recoveryScenarios } from './recovery.js';
export function hardwareDebugScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...bankScenarios(compiler),
    ...registerScenarios(compiler),
    ...executeScenarios(compiler),
    ...recoveryScenarios(compiler),
  ];
}
