import { createCpu } from '../../../host/index.js';
import { variantScenarios } from './variants.js';
import { warmScenarios } from './warm.js';
import type { Factory, Scenario } from './fixture.js';

export function contextReuseScenarios(
  compiler: WebAssembly.Module,
  make: Factory = createCpu,
): Scenario[] {
  return [...variantScenarios(compiler, make), ...warmScenarios(compiler, make)];
}
