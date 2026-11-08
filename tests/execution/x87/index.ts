import type { Scenario } from './fixture.js';
import { literalScenarios } from './literals.js';

export function x87Scenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...literalScenarios(compiler),
  ];
}
