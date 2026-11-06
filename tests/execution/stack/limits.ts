import { type Scenario, CODE, changed, equal, exit, fault, memory } from '../../support/fixture.js';
import { PROGRAM, RAM, createStackFixture, input, noFault, stack } from './fixture.js';

export function limitScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createStackFixture(core);
  return [
    {
      name: 'budget and stop precede stack and target diagnostics without installing an artifact',
      run: async () => {
        for (const code of [
          '50',
          '58',
          '6a80',
          '6800000080',
          'e80b000000',
          'ffd0',
          'ffe0',
          'c3',
          'c2ffff',
        ]) {
          await using(code, async (cpu) => {
            const before = input(CODE, { 0: 0x800000000000n, 4: 0x7000n });
            cpu.setState(before);
            for (const gate of [
              { budget: 0n, reason: 'budget' },
              { budget: 1n, reason: 'stop' },
            ]) {
              const result = await cpu.run({ budget: gate.budget, stop: CODE });
              exit(result, gate.reason, gate.budget, 0n, before);
              noFault(result);
              equal(result.resources.compilations, 0, 'initial gate prevents translation');
              equal(result.resources.nativeEntries, 0, 'initial gate prevents generated execution');
              memory(cpu, CODE, code);
              memory(cpu, 0x4000n, RAM);
            }
          });
        }
      },
    },
    {
      name: 'completed CALL and RET retain their stack effects across translation refusal and resume',
      run: async () => {
        for (const returning of [false, true]) {
          const original = returning ? stack(0x1005n, 24) : RAM;
          await using(
            PROGRAM,
            async (cpu) => {
              const before = input(returning ? 0x1015n : CODE, returning ? { 4: 0x4018n } : {});
              cpu.setState(before);
              const refused = await cpu.run({ budget: 2n });
              const after = changed(before, returning ? 0x1005n : 0x1010n, {
                4: returning ? 0x4020n : 0x4018n,
              });
              exit(refused, 'resource-limit', 2n, 1n, after);
              noFault(refused);
              equal(refused.resources.compilations, 1, 'one translation admitted before transfer');
              memory(cpu, 0x4000n, stack(0x1005n, 24));
              const resumed = await cpu.run({ budget: 1n });
              exit(
                resumed,
                'budget',
                1n,
                1n,
                changed(after, returning ? 0x100an : 0x1015n, returning ? { 1: 1n } : { 2: 2n }),
              );
              noFault(resumed);
              memory(cpu, 0x4000n, stack(0x1005n, 24));
              memory(cpu, CODE, PROGRAM);
            },
            { ram: original, limits: { maxInstructions: 1, maxTranslationsPerRun: 1 } },
          );
        }
      },
    },
    {
      name: 'reached stack decode failures beat translation caps while unexecuted stack effects stay absent',
      run: async () => {
        for (const suffix of ['50', 'c3', 'e800', 'ff', '8f']) {
          const code = 'b802000000' + suffix;
          await using(
            code,
            async (cpu) => {
              const before = input(CODE, { 4: 0x7000n });
              cpu.setState(before);
              const result = await cpu.run({ budget: 3n });
              const reason =
                suffix === '50' || suffix === 'c3'
                  ? 'resource-limit'
                  : suffix === '8f'
                    ? 'unsupported'
                    : 'fetch-fault';
              const after = changed(before, 0x1005n, { 0: 2n });
              exit(result, reason, 3n, 1n, after);
              equal(result.resources.compilations, 1, 'only the completed prefix was translated');
              if (reason === 'fetch-fault') {
                const missing = CODE + BigInt(code.length / 2);
                fault(result, {
                  instructionPc: 0x1005n,
                  address: missing,
                  width: 1,
                  access: 'execute',
                  cause: 'unmapped',
                  failingAddress: missing,
                });
              } else noFault(result);
              memory(cpu, CODE, code);
              memory(cpu, 0x4000n, RAM);
            },
            { limits: { maxInstructions: 1, maxTranslationsPerRun: 1 } },
          );
        }
      },
    },
  ];
}
