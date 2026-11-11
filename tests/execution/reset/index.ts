import { transitionScenarios } from './transitions.js';
import { lifecycleScenarios } from './lifecycle.js';
export const resetScenarios = (compiler: WebAssembly.Module) => [
  ...transitionScenarios(compiler),
  ...lifecycleScenarios(compiler),
];
