import {
  createFixture,
  type Scenario,
  CODE,
  changed,
  equal,
  exit,
  fault,
  hex,
  memory,
} from '../../../support/fixture.js';
import { defaultRam, input, logicalExit, noFault } from './fixture.js';

export function observationScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createFixture(core);
  const ram = '1011121314151617a0a1a2a3a4a5a6a7f0f1f2f3f4f5f6f7';
  return [
    {
      name: 'different logical producers join at one condition without leaking into middle entries',
      run: async () => {
        await using(
          '740431c0eb0383c8017405ba22000000b933000000',
          async (cpu) => {
            for (const path of [
              { flags: 2n, rax: 0n, rdx: 0x1122334400000002n, outputFlags: 0x46n },
              { flags: 0x42n, rax: 1n, rdx: 0x22n, outputFlags: 2n },
            ]) {
              const before = input(CODE, {}, path.flags);
              cpu.setState(before);
              const result = await cpu.run({ budget: 5n });
              logicalExit(
                result,
                'budget',
                5n,
                5n,
                changed(before, 0x1015n, { 0: path.rax, 1: 0x33n, 2: path.rdx }, path.outputFlags),
              );
              noFault(result);
              equal(
                result.resources.nativeEntries,
                1,
                'joined path stays in one generated invocation',
              );
              memory(cpu, 0x4000n, '00');
            }
            equal(cpu.inspectTranslations().length, 1, 'joined paths share one artifact');
            equal(
              cpu.inspectTranslations()[0]!.entries.map(String).join(','),
              [0x1000n, 0x1002n, 0x1004n, 0x1006n, 0x1009n, 0x100bn, 0x1010n].map(String).join(','),
              'every producer and join entry admitted',
            );
            for (const path of [
              { flags: 0x52n, budget: 2n, writes: { 1: 0x33n } },
              { flags: 0x12n, budget: 3n, writes: { 1: 0x33n, 2: 0x22n } },
            ]) {
              const fresh = input(0x1009n, {}, path.flags);
              cpu.setState(fresh);
              const reused = await cpu.run({ budget: path.budget });
              exit(
                reused,
                'budget',
                path.budget,
                path.budget,
                changed(fresh, 0x1015n, path.writes),
              );
              noFault(reused);
              equal(reused.resources.compilations, 0, 'fresh flags reuse the existing join entry');
              memory(cpu, 0x4000n, '00');
            }
          },
          defaultRam,
        );
      },
    },
    {
      name: 'TEST conditions skip an unmapped operand and preserve observed flags through store boundaries',
      run: async () => {
        await using(
          '85c07403488b16488903',
          async (cpu) => {
            const before = input(CODE, { 0: 0x1122334400000000n, 3: 0x4000n, 6: 0x7000n }, 0x883n);
            for (const path of [
              {
                budget: 3n,
                stop: undefined,
                reason: 'budget',
                retired: 3n,
                pc: 0x100an,
                stored: true,
              },
              {
                budget: 3n,
                stop: 0x1007n,
                reason: 'stop',
                retired: 2n,
                pc: 0x1007n,
                stored: false,
              },
              {
                budget: 2n,
                stop: 0x1007n,
                reason: 'budget',
                retired: 2n,
                pc: 0x1007n,
                stored: false,
              },
            ]) {
              cpu.writeMemory(0x3ff8n, hex(ram));
              cpu.setState(before);
              const result = await cpu.run(
                path.stop === undefined
                  ? { budget: path.budget }
                  : { budget: path.budget, stop: path.stop },
              );
              logicalExit(
                result,
                path.reason,
                path.budget,
                path.retired,
                changed(before, path.pc, {}, 0x46n),
              );
              noFault(result);
              memory(
                cpu,
                0x3ff8n,
                path.stored ? '10111213141516170000000044332211f0f1f2f3f4f5f6f7' : ram,
              );
            }

            cpu.setState(before);
            const produced = await cpu.run({ budget: 1n });
            logicalExit(produced, 'budget', 1n, 1n, changed(before, 0x1002n, {}, 0x46n));
            noFault(produced);
            const branch = await cpu.run({ budget: 1n });
            exit(branch, 'budget', 1n, 1n, changed(produced.state, 0x1007n));
            noFault(branch);
            equal(branch.resources.compilations, 0, 'observed flags survive a reused Jcc');
            memory(cpu, 0x3ff8n, ram);
            const stored = await cpu.run({ budget: 1n });
            exit(stored, 'budget', 1n, 1n, changed(branch.state, 0x100an));
            noFault(stored);
            equal(stored.resources.compilations, 0, 'store resumes its admitted entry');
            memory(cpu, 0x3ff8n, '10111213141516170000000044332211f0f1f2f3f4f5f6f7');
          },
          { ramBase: 0x3ff8n, ram },
        );
      },
    },
    {
      name: 'logical flags survive a later fault while repair never replays a committed store',
      run: async () => {
        await using(
          '4889034883e001488b16',
          async (cpu) => {
            const before = input(CODE, { 0: 0x1122334400000002n, 3: 0x4000n, 6: 0x7000n }, 0x883n);
            cpu.setState(before);
            const failed = await cpu.run({ budget: 4n });
            logicalExit(failed, 'data-fault', 4n, 2n, changed(before, 0x1007n, { 0: 0n }, 0x46n));
            fault(failed, {
              instructionPc: 0x1007n,
              address: 0x7000n,
              width: 8,
              access: 'read',
              cause: 'unmapped',
              failingAddress: 0x7000n,
            });
            memory(cpu, 0x3ff8n, '10111213141516170200000044332211f0f1f2f3f4f5f6f7');

            cpu.writeMemory(0x4000n, hex('0807060504030201'));
            const repaired = changed(failed.state, 0x1007n, { 6: 0x4000n });
            cpu.setState(repaired);
            const resumed = await cpu.run({ budget: 1n });
            exit(resumed, 'budget', 1n, 1n, changed(repaired, 0x100an, { 2: 0x0102030405060708n }));
            noFault(resumed);
            equal(resumed.resources.compilations, 0, 'repair reuses the failed entry');
            memory(cpu, 0x3ff8n, '10111213141516170807060504030201f0f1f2f3f4f5f6f7');
          },
          { ramBase: 0x3ff8n, ram },
        );
      },
    },
  ];
}
