import { literalScenarios } from './literals.js';
import { imageScenarios } from './images.js';
import type { Scenario } from '../modes/fixture.js';

export function numericStateScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...literalScenarios(compiler),
    ...imageScenarios(compiler),
  ];
}
