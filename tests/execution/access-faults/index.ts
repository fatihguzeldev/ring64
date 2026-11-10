import type { Scenario } from '../../support/fixture.js';
import { decodeScenarios } from './decode.js';

export function accessFaultScenarios(compiler: WebAssembly.Module): Scenario[] {
  return decodeScenarios(compiler);
}
