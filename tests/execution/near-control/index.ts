import { type Scenario } from './fixture.js';
import { literalPackets } from './literal-packets.js';
import { matrixScenarios } from './matrix.js';
import { boundaryScenarios } from './boundaries.js';

export function nearControlScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...literalPackets(compiler),
    ...matrixScenarios(compiler),
    ...boundaryScenarios(compiler),
  ];
}
