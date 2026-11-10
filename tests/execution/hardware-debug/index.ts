import { transitionScenarios } from './transitions.js';
import { operandScenarios } from './operands.js';
import { shadowScenarios } from './shadows.js';
import { dataScenarios } from './data.js';
import { bankScenarios } from './bank.js';
import type { Scenario } from '../../support/fixture.js';
import { registerScenarios } from './registers.js';
import { executeScenarios } from './execute.js';
import { recoveryScenarios } from './recovery.js';
export function hardwareDebugScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...bankScenarios(compiler),
    ...dataScenarios(compiler),
    ...operandScenarios(compiler),
    ...shadowScenarios(compiler),
    ...transitionScenarios(compiler),
    ...registerScenarios(compiler),
    ...executeScenarios(compiler),
    ...recoveryScenarios(compiler),
  ];
}
