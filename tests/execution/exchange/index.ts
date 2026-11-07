import { type Scenario } from './fixture.js';
import { matrixScenarios } from './matrix.js';
import { boundaryScenarios } from './boundaries.js';
import { literalPackets } from './literal-packets.js';

export function exchangeScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...literalPackets(compiler),
    ...matrixScenarios(compiler),
    ...boundaryScenarios(compiler),
  ];
}
