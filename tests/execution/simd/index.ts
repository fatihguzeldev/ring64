import { type Scenario } from './fixture.js';
import { registerScenarios } from './registers.js';
import { transferScenarios } from './transfers.js';
import { memoryScenarios } from './memory.js';
import { reuseScenarios } from './reuse.js';
import { boundaryScenarios } from './boundaries.js';
import { literalScenarios } from './literal-packets.js';
import { decodingScenarios } from './decoding.js';
export function simdScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...registerScenarios(compiler),
    ...transferScenarios(compiler),
    ...memoryScenarios(compiler),
    ...reuseScenarios(compiler),
    ...boundaryScenarios(compiler),
    ...literalScenarios(compiler),
    ...decodingScenarios(compiler),
  ];
}
