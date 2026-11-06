import {
  createFixture,
  type Scenario,
  changed,
  equal,
  exit,
  fault,
  memory,
} from '../../../support/fixture.js';
import { defaultRam, input, logicalExit, noFault } from './fixture.js';

export function boundaryScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createFixture(core);
  const pc = 0x7ffffffffff0n;
  const target = 0x800000000000n;
  return [
    {
      name: 'every short and near condition preserves AF and reports noncanonical target metadata',
      run: async () => {
        const outcomes = [
          [0x12n, 0x812n],
          [0x812n, 0x12n],
          [0x12n, 0x13n],
          [0x13n, 0x12n],
          [0x12n, 0x52n],
          [0x52n, 0x12n],
          [0x12n, 0x53n],
          [0x53n, 0x12n],
          [0x12n, 0x92n],
          [0x92n, 0x12n],
          [0x12n, 0x16n],
          [0x16n, 0x12n],
          [0x892n, 0x812n],
          [0x812n, 0x892n],
          [0x892n, 0x852n],
          [0x8d2n, 0x892n],
        ];
        for (const [condition, flags] of outcomes.entries())
          for (const near of [false, true]) {
            const code = near
              ? `0f${(0x80 + condition).toString(16)}0a000000`
              : `${(0x70 + condition).toString(16)}0e`;
            await using(
              code,
              async (cpu) => {
                const untakenInput = input(pc, {}, flags[0]!);
                cpu.setState(untakenInput);
                const untaken = await cpu.run({ budget: 1n });
                exit(untaken, 'budget', 1n, 1n, changed(untakenInput, pc + (near ? 6n : 2n)));
                noFault(untaken);
                memory(cpu, 0x4000n, '00');
                const takenInput = input(pc, {}, flags[1]!);
                cpu.setState(takenInput);
                const taken = await cpu.run({ budget: 1n });
                exit(taken, 'target-fault', 1n, 0n, takenInput);
                fault(taken, {
                  instructionPc: pc,
                  address: target,
                  width: 0,
                  access: 'execute',
                  cause: 'noncanonical',
                  failingAddress: target,
                });
                equal(
                  taken.resources.compilations,
                  0,
                  'changed condition reuses the target artifact',
                );
                memory(cpu, 0x4000n, '00');
              },
              { ...defaultRam, codeBase: pc },
            );
          }
      },
    },
    {
      name: 'logical producer commits before a taken noncanonical condition with complete metadata',
      run: async () => {
        await using(
          '09c0780c',
          async (cpu) => {
            const falseInput = input(pc, { 0: 0n });
            cpu.setState(falseInput);
            const untaken = await cpu.run({ budget: 2n });
            logicalExit(untaken, 'budget', 2n, 2n, changed(falseInput, pc + 4n, {}, 0x46n));
            noFault(untaken);
            memory(cpu, 0x4000n, '00');

            const trueInput = input(pc, { 0: 0x1122334480000000n });
            cpu.setState(trueInput);
            const failed = await cpu.run({ budget: 2n });
            logicalExit(
              failed,
              'target-fault',
              2n,
              1n,
              changed(trueInput, pc + 2n, { 0: 0x80000000n }, 0x86n),
            );
            fault(failed, {
              instructionPc: pc + 2n,
              address: target,
              width: 0,
              access: 'execute',
              cause: 'noncanonical',
              failingAddress: target,
            });
            memory(cpu, 0x4000n, '00');

            cpu.setState(trueInput);
            const produced = await cpu.run({ budget: 1n });
            logicalExit(
              produced,
              'budget',
              1n,
              1n,
              changed(trueInput, pc + 2n, { 0: 0x80000000n }, 0x86n),
            );
            noFault(produced);
            const zero = await cpu.run({ budget: 0n, stop: pc + 2n });
            exit(zero, 'budget', 0n, 0n, produced.state);
            noFault(zero);
            const stopped = await cpu.run({ budget: 1n, stop: pc + 2n });
            exit(stopped, 'stop', 1n, 0n, produced.state);
            noFault(stopped);
            const resumed = await cpu.run({ budget: 1n });
            exit(resumed, 'target-fault', 1n, 0n, produced.state);
            fault(resumed, {
              instructionPc: pc + 2n,
              address: target,
              width: 0,
              access: 'execute',
              cause: 'noncanonical',
              failingAddress: target,
            });
            equal(resumed.resources.compilations, 0, 'target fault reuses its admitted entry');
            memory(cpu, 0x4000n, '00');
          },
          { ...defaultRam, codeBase: pc },
        );
      },
    },
    {
      name: 'reached condition truncation precedes translation caps and caps precede target evaluation',
      run: async () => {
        for (const complete of [false, true])
          await using(
            complete ? '31c00f8408000000' : '31c00f8408',
            async (cpu) => {
              const before = input(pc);
              cpu.setState(before);
              const result = await cpu.run({ budget: 3n });
              logicalExit(
                result,
                complete ? 'resource-limit' : 'fetch-fault',
                3n,
                1n,
                changed(before, pc + 2n, { 0: 0n }, 0x46n),
              );
              equal(
                result.resources.compilations,
                1,
                'only the producer is compiled before refusal',
              );
              memory(cpu, 0x4000n, '00');
              if (complete) {
                noFault(result);
                const resumed = await cpu.run({ budget: 1n });
                exit(resumed, 'target-fault', 1n, 0n, result.state);
                fault(resumed, {
                  instructionPc: pc + 2n,
                  address: target,
                  width: 0,
                  access: 'execute',
                  cause: 'noncanonical',
                  failingAddress: target,
                });
                memory(cpu, 0x4000n, '00');
              } else {
                fault(result, {
                  instructionPc: pc + 2n,
                  address: pc + 5n,
                  width: 1,
                  access: 'execute',
                  cause: 'unmapped',
                  failingAddress: pc + 5n,
                });
              }
            },
            {
              ...defaultRam,
              codeBase: pc,
              limits: { maxInstructions: 1, maxTranslationsPerRun: 1 },
            },
          );
      },
    },
  ];
}
