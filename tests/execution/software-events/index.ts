import type { Scenario } from '../../support/fixture.js';
import { taskScenarios } from './task.js';
import { realScenarios } from './real.js';
import { protectedScenarios } from './protected.js';
import { ia32eScenarios } from './ia32e.js';
import { vmScenarios } from './vm.js';
import { memoryScenarios } from './memory.js';
import { diagnosticScenarios } from './diagnostics.js';
import { returnScenarios } from './returns.js';
import { boundaryScenarios } from './boundaries.js';
import { aliasScenarios } from './aliases.js';
import { cacheReviewScenarios } from './cache-review.js';

export function softwareEventScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...taskScenarios(compiler),
    ...realScenarios(compiler),
    ...protectedScenarios(compiler),
    ...ia32eScenarios(compiler),
    ...vmScenarios(compiler),
    ...memoryScenarios(compiler),
    ...diagnosticScenarios(compiler),
    ...returnScenarios(compiler),
    ...boundaryScenarios(compiler),
    ...aliasScenarios(compiler),
    ...cacheReviewScenarios(compiler),
  ];
}
