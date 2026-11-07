import type { Scenario } from './fixture.js';
import { arithmeticScenarios } from './arithmetic.js';
import { conversionScenarios } from './conversions.js';
import { literalScenarios } from './literal-packets.js';
import { reuseScenarios } from './reuse.js';
import { controlScenarios } from './controls.js';
import { relationScenarios } from './relations.js';
import { accessScenarios } from './access.js';
import { decodeScenarios } from './decoding.js';
export function floatingScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...arithmeticScenarios(compiler),
    ...conversionScenarios(compiler),
    ...literalScenarios(compiler),
    ...reuseScenarios(compiler),
    ...controlScenarios(compiler),
    ...relationScenarios(compiler),
    ...accessScenarios(compiler),
    ...decodeScenarios(compiler),
  ];
}
