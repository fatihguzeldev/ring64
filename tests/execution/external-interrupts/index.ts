import { activityScenarios } from './activity.js';
import { boundaryScenarios } from './boundaries.js';
import { sourceScenarios } from './sources.js';
import { stateScenarios } from './state.js';
import { frontierScenarios } from './frontiers.js';
import { cacheScenarios } from './cache.js';
import { architectureReviewScenarios } from './architecture-review.js';
import type { Scenario } from './fixture.js';

export function externalInterruptScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...activityScenarios(compiler),
    ...boundaryScenarios(compiler),
    ...sourceScenarios(compiler),
    ...stateScenarios(compiler),
    ...frontierScenarios(compiler),
    ...cacheScenarios(compiler),
    ...architectureReviewScenarios(compiler),
  ];
}
