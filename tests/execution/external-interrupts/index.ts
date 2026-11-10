import { activityScenarios } from './activity.js';
import type { Scenario } from './fixture.js';

export function externalInterruptScenarios(compiler: WebAssembly.Module): Scenario[] {
  return activityScenarios(compiler);
}
