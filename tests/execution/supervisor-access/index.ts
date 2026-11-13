import { createCpu } from '../../../host/index.js';
import type { Scenario } from '../../support/fixture.js';
import { checkSupervisorAccess, groups } from './oracle.js';

export function supervisorAccessScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...groups.map((group) => ({
      name: `supervisor access protection independent ${group} packets`,
      async run() {
        await checkSupervisorAccess({ createCpu, compiler }, [group]);
      },
    })),
  ];
}
