import { type Scenario } from '../../support/fixture.js';
import { accessScenarios } from './access.js';
import { literalScenarios } from './literals.js';
import { mutationScenarios } from './mutations.js';

export function mappedMemoryScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...literalScenarios(compiler),
    ...accessScenarios(compiler),
    ...mutationScenarios(compiler),
  ];
}
