import { fastTransferScenarios } from './transfers.js';
import { fastSystemFaultScenarios } from './faults.js';
import { fastSystemBoundaryScenarios } from './boundaries.js';
import { fastSystemCurrentnessScenarios } from './currentness.js';
import type { Scenario } from '../../support/fixture.js';

export function fastSystemScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...fastTransferScenarios(compiler),
    ...fastSystemFaultScenarios(compiler),
    ...fastSystemBoundaryScenarios(compiler),
    ...fastSystemCurrentnessScenarios(compiler),
  ];
}
