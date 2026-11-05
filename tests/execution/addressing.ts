import type { Scenario } from './fixture.js';
import { addressingOperandScenarios } from './addressing/operands.js';

export function addressingScenarios(core: WebAssembly.Module): Scenario[] {
  return addressingOperandScenarios(core);
}
