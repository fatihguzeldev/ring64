import { legacyControlScenarios } from './controls.js';
import { createCpu } from '../../../host/index.js';
import {
  legacyCpu,
  legacyOptions,
  word,
  little,
  initial,
  equal,
  check,
  type Scenario,
} from './fixture.js';

export function legacyPagingScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...legacyControlScenarios(compiler),
    ...[false, true].map((pae) => ({
      name: `legacy ${pae ? 'PAE' : 'nonPAE'} public generated access and raw bank`,
      async run() {
        const cpu = await legacyCpu(compiler, pae, 'b8443322118903', false);
        try {
          cpu.setState(initial(0x1000n, { 0: 0x1122334455667788n, 3: 0x6000n }));
          const result = await cpu.run({ budget: 2n });
          equal(result.reason, 'budget', 'completion');
          equal(result.retired, 2n, 'retirements');
          equal(result.state.rip, 0x1007n, 'PC');
          equal(result.state.registers[0], 0x1122334411223344n, 'legacy EAX merge');
          equal(word(cpu, 0xa000n, 4), 0x11223344n, 'nonidentity store');
          equal(word(cpu, pae ? 0x4030n : 0x2018n, pae ? 8 : 4), 0xa067n, 'leaf AD');
          equal(cpu.readContext().mode, 'protected', 'initial native context');
          const bank = cpu.readPagingState();
          bank.cr3 = 0x0008000000001038n;
          bank.cr2 = 0xffffffffffffffffn;
          cpu.setPagingState(bank);
          equal(cpu.readPagingState().cr3, bank.cr3, 'raw ignored CR3 retention');
          equal(cpu.readPagingState().cr2, bank.cr2, 'raw CR2 retention');
          if (pae) {
            bank.pdpte![0] = 0x5001n;
            cpu.setPagingState(bank);
            bank.pdpte![0] = 0n;
            equal(cpu.readPagingState().pdpte![0], 0x5001n, 'detached latch');
            cpu.setState(initial(0x1005n, { 0: 0x11223344n, 3: 0x6000n }));
            await cpu.run({ budget: 1n });
            equal(word(cpu, 0xb000n, 4), 0x11223344n, 'host quartet repair without RAM root');
          }
        } finally {
          cpu.dispose();
        }
      },
    })),
    {
      name: 'physical constructor rejects incomplete and wrong-family banks atomically',
      async run() {
        const original = legacyOptions(compiler);
        for (const changes of [
          { context: undefined },
          { paging: undefined },
          { context: { mode: 'long64', fsBase: 0n, gsBase: 0n } },
          { paging: { ...original.paging!, pdpte: [0n, 0n, 0n, 0n] } },
          { fastSystem: undefined },
        ]) {
          let rejected = false;
          try {
            const cpu = await createCpu({ ...original, ...changes } as never);
            cpu.dispose();
          } catch (error) {
            rejected = error instanceof TypeError;
          }
          check(rejected, 'invalid physical constructor rejected');
        }
        const cpu = await createCpu(original);
        try {
          let rejected = false;
          try {
            cpu.setContext({ mode: 'long64', fsBase: 0n, gsBase: 0n });
          } catch (error) {
            rejected = error instanceof TypeError;
          }
          check(rejected, 'wrong context rejected');
          equal(cpu.readContext().mode, 'protected', 'failed context retained');
          const bank = cpu.readPagingState();
          try {
            cpu.setPagingState({ ...bank, cr4: 0x628n });
            throw new Error('accepted missing quartet');
          } catch (error) {
            check(error instanceof TypeError, 'PAE quartet required');
          }
          equal(cpu.readPagingState().cr4, 0x608n, 'failed bank retained');
          cpu.writePhysicalMemory(0x1000n, little(0xdeadbeefn, 4));
          equal(word(cpu, 0x1000n, 4), 0xdeadbeefn, 'physical host bypass');
        } finally {
          cpu.dispose();
        }
      },
    },
  ];
}
