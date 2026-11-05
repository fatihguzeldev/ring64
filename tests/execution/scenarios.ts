import { integerScenarios } from './integer.js';
import { integerConditionsScenarios } from './integer-conditions.js';
import { integerMemoryScenarios } from './integer-memory.js';
import { addressingScenarios } from './addressing.js';
import { memoryScenarios } from './memory.js';
import { controlScenarios } from './control.js';
import { translationsScenarios } from './translations.js';
import { embeddingScenarios } from '../embedding/scenarios.js';

export async function runScenarios(
  compiler: Uint8Array | WebAssembly.Module,
): Promise<{ passed: string[] }> {
  const core =
    compiler instanceof WebAssembly.Module
      ? compiler
      : await WebAssembly.compile(new Uint8Array(compiler));
  const scenarios = [
    ...integerScenarios(core),
    ...integerConditionsScenarios(core),
    ...integerMemoryScenarios(core),
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
