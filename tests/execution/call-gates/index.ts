import { basicGateScenarios } from './basic.js';
import { widthScenarios } from './widths.js';
import { privilegeScenarios } from './privilege.js';
import { longGateScenarios } from './long64.js';
import { gateDebugScenarios } from './debug.js';
import { gateCanonicalScenarios } from './canonical.js';
import { gatePagingScenarios } from './paging.js';
import { gateLifecycleScenarios } from './lifecycle.js';
import { gateOperandScenarios } from './operands.js';
import { gatePublicationScenarios } from './publication.js';
import { gateOwnershipScenarios } from './ownership.js';
import { gateFrontierScenarios } from './frontiers.js';
import { gatePagingBoundaryScenarios } from './paging-boundaries.js';
import type { Scenario } from './fixture.js';

export function callGateScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...basicGateScenarios(compiler),
    ...widthScenarios(compiler),
    ...privilegeScenarios(compiler),
    ...longGateScenarios(compiler),
    ...gateDebugScenarios(compiler),
    ...gateCanonicalScenarios(compiler),
    ...gatePagingScenarios(compiler),
    ...gateLifecycleScenarios(compiler),
    ...gateOperandScenarios(compiler),
    ...gatePublicationScenarios(compiler),
    ...gateOwnershipScenarios(compiler),
    ...gateFrontierScenarios(compiler),
    ...gatePagingBoundaryScenarios(compiler),
  ];
}
