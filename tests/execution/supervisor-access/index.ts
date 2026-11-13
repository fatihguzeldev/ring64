import { createCpu } from '../../../host/index.js';
import type { Scenario } from '../../support/fixture.js';
import { checkSupervisorAccess, groups } from './oracle.js';
import { supervisorFlagScenarios } from './flags.js';
import { supervisorIoScenarios } from './io.js';
import { supervisorNumericScenarios } from './numeric.js';
import { supervisorControlScenarios } from './controls.js';
import { supervisorProfileScenarios } from './profiles.js';
import { supervisorContextScenarios } from './contexts.js';
import { supervisorMetadataScenarios } from './metadata.js';
import { supervisorBoundaryScenarios } from './boundaries.js';
import { supervisorFlowScenarios } from './flow.js';
import { supervisorPositiveScenarios } from './positive.js';
import { supervisorNoWorkScenarios } from './no-work.js';
import { supervisorOrderingScenarios } from './ordering.js';
import { supervisorEventScenarios } from './events.js';
import { supervisorEntryScenarios } from './entry.js';

export function supervisorAccessScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...groups.map((group) => ({
      name: `supervisor access protection independent ${group} packets`,
      async run() {
        await checkSupervisorAccess({ createCpu, compiler }, [group]);
      },
    })),
    ...supervisorFlagScenarios(compiler),
    ...supervisorIoScenarios(compiler),
    ...supervisorNumericScenarios(compiler),
    ...supervisorControlScenarios(compiler),
    ...supervisorProfileScenarios(compiler),
    ...supervisorContextScenarios(compiler),
    ...supervisorMetadataScenarios(compiler),
    ...supervisorBoundaryScenarios(compiler),
    ...supervisorFlowScenarios(compiler),
    ...supervisorPositiveScenarios(compiler),
    ...supervisorNoWorkScenarios(compiler),
    ...supervisorOrderingScenarios(compiler),
    ...supervisorEventScenarios(compiler),
    ...supervisorEntryScenarios(compiler),
  ];
}
