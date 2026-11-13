import { createCpu } from '../../../host/index.js';
import type { Scenario } from '../../support/fixture.js';
import { checkSupervisorAccess, groups } from './oracle.js';
import { supervisorFlagScenarios } from './flags.js';
import { supervisorControlScenarios } from './controls.js';
import { supervisorProfileScenarios } from './profiles.js';
import { supervisorContextScenarios } from './contexts.js';
import { supervisorFlowScenarios } from './flow.js';
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
    ...supervisorControlScenarios(compiler),
    ...supervisorProfileScenarios(compiler),
    ...supervisorContextScenarios(compiler),
    ...supervisorFlowScenarios(compiler),
    ...supervisorEventScenarios(compiler),
    ...supervisorEntryScenarios(compiler),
  ];
}
