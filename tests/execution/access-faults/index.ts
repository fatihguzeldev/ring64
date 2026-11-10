import type { Scenario } from '../../support/fixture.js';
import { decodeScenarios } from './decode.js';
import { runtimeScenarios } from './runtime.js';

export function accessFaultScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [...decodeScenarios(compiler), ...runtimeScenarios(compiler)];
}
