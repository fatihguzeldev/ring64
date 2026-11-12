import { basicGateScenarios } from './basic.js';
import { widthScenarios } from './widths.js';
import { privilegeScenarios } from './privilege.js';
import { longGateScenarios } from './long64.js';
import { gateCanonicalScenarios } from './canonical.js';
import { gatePublicationScenarios } from './publication.js';
import { gateDebugScenarios } from './debug.js';
import type { Scenario } from './fixture.js';

export function callGateScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...basicGateScenarios(compiler),
    ...widthScenarios(compiler),
    ...privilegeScenarios(compiler),
    ...longGateScenarios(compiler),
    ...gateCanonicalScenarios(compiler),
    ...gatePublicationScenarios(compiler),
    ...gateDebugScenarios(compiler),
  ];
}
