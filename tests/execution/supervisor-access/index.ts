import { createCpu } from '../../../host/index.js';
import type { Scenario } from '../../support/fixture.js';
import { checkSupervisorAccess, groups } from './oracle.js';
import { supervisorFlagScenarios } from './flags.js';
import { supervisorContextScenarios } from './contexts.js';

export function supervisorAccessScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...groups.map((group) => ({
      name: `supervisor access protection independent ${group} packets`,
      async run() {
        await checkSupervisorAccess({ createCpu, compiler }, [group]);
      },
    })),
    ...supervisorFlagScenarios(compiler),
    ...supervisorContextScenarios(compiler),
  ];
}
