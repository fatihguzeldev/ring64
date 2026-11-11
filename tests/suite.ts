import { ioScenarios } from './execution/io/index.js';
import { numericControlScenarios } from './execution/numeric-controls.js';
import { integerScenarios } from './execution/integer/index.js';
import { stackScenarios } from './execution/stack/index.js';
import { addressingScenarios } from './execution/addressing/index.js';
import { memoryScenarios } from './execution/memory.js';
import { mappedMemoryScenarios } from './execution/mapped-memory/index.js';
import { controlScenarios } from './execution/control.js';
import { translationsScenarios } from './execution/translations.js';
import { embeddingScenarios } from './embedding/scenarios.js';
import { modeScenarios } from './execution/modes/index.js';
import { stringScenarios } from './execution/strings/index.js';
import { nearControlScenarios } from './execution/near-control/index.js';
import { exchangeScenarios } from './execution/exchange/index.js';
import { simdScenarios } from './execution/simd/index.js';
import { floatingScenarios } from './execution/floating/index.js';
import { x87Scenarios } from './execution/x87/index.js';
import { numericStateScenarios } from './execution/mmx/index.js';
import { farControlScenarios } from './execution/far-control/index.js';
import { protectionScenarios } from './execution/protection/index.js';
import { streamingScenarios } from './execution/streaming/index.js';
import { systemFlagScenarios } from './execution/system-flags/index.js';
import { softwareEventScenarios } from './execution/software-events/index.js';
import { exceptionDeliveryScenarios } from './execution/exception-delivery/index.js';
import { externalInterruptScenarios } from './execution/external-interrupts/index.js';

import { accessFaultScenarios } from './execution/access-faults/index.js';

import { hardwareDebugScenarios } from './execution/hardware-debug/index.js';
import { pagingScenarios } from './execution/paging/index.js';
import { fastSystemScenarios } from './execution/fast-system/index.js';
import { contextReuseScenarios } from './execution/context-reuse/index.js';

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
    ...mappedMemoryScenarios(core),
    ...controlScenarios(core),
    ...translationsScenarios(core),
    ...embeddingScenarios(core),
    ...modeScenarios(core),
    ...stringScenarios(core),
    ...ioScenarios(core),
    ...nearControlScenarios(core),
    ...exchangeScenarios(core),
    ...simdScenarios(core),
    ...floatingScenarios(core),
    ...x87Scenarios(core),
    ...numericStateScenarios(core),
    ...streamingScenarios(core),
    ...protectionScenarios(core),
    ...farControlScenarios(core),
    ...systemFlagScenarios(core),
    ...softwareEventScenarios(core),
    ...exceptionDeliveryScenarios(core),
    ...externalInterruptScenarios(core),
    ...accessFaultScenarios(core),
    ...hardwareDebugScenarios(core),
    ...pagingScenarios(core),
    ...fastSystemScenarios(core),
    ...contextReuseScenarios(core),
    ...numericControlScenarios(core),
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
