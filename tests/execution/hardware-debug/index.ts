import { bankScenarios } from './bank.js';
import type { Scenario } from '../../support/fixture.js';
export function hardwareDebugScenarios(compiler: WebAssembly.Module): Scenario[] {
  return bankScenarios(compiler);
}
