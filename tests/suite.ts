import { integerScenarios } from './execution/integer/index.js';
import { stackScenarios } from './execution/stack/index.js';
import { addressingScenarios } from './execution/addressing/index.js';
import { memoryScenarios } from './execution/memory.js';
import { controlScenarios } from './execution/control.js';
import { translationsScenarios } from './execution/translations.js';
import { embeddingScenarios } from './embedding/scenarios.js';

export async function runScenarios(
  compiler: Uint8Array | WebAssembly.Module,
): Promise<{ passed: string[] }> {
  const core =
    compiler instanceof WebAssembly.Module
      ? compiler
      : await WebAssembly.compile(new Uint8Array(compiler));
  const scenarios = [
    ...integerScenarios(core),
    ...stackScenarios(core),
    ...addressingScenarios(core),
    ...memoryScenarios(core),
    ...controlScenarios(core),
    ...translationsScenarios(core),
    ...embeddingScenarios(core),
  ];
  const passed: string[] = [];
  for (const { name, run } of scenarios) {
    try {
      await run();
      passed.push(name);
    } catch (error) {
      throw new Error(`scenario failed: ${name}`, { cause: error });
    }
  }
  return { passed };
}
