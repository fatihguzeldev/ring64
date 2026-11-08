import { storeScenarios } from './stores.js';
import { maskScenarios } from './masks.js';
import { boundaryScenarios } from './boundaries.js';
import { hintScenarios } from './hints.js';
import { adversarialScenarios } from './adversarial.js';
import type { Scenario } from './fixture.js';

export function streamingScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...storeScenarios(compiler),
    ...maskScenarios(compiler),
    ...boundaryScenarios(compiler),
    ...hintScenarios(compiler),
    ...adversarialScenarios(compiler),
  ];
}
