import { activityScenarios } from './activity.js';
import { sourceScenarios } from './sources.js';
import { boundaryScenarios } from './boundaries.js';
import type { Scenario } from './fixture.js';

export function externalInterruptScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...activityScenarios(compiler),
    ...sourceScenarios(compiler),
    ...boundaryScenarios(compiler),
  ];
}
