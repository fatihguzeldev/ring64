import {
  type Scenario,
  CODE,
  changed,
  check,
  equal,
  exit,
  hex,
  memory,
} from '../../support/fixture.js';
import { FLAGS, RAM, createStackFixture, input, noFault, stack, word } from './fixture.js';

export function routingScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createStackFixture(core);
  return [
    {
      name: 'cached register CALL and JMP routes consume fresh targets banks flags and stack pointers',
      run: async () => {
        for (const calling of [false, true]) {
          const code = calling
            ? 'ffd0c30000000000b911000000c3ba22000000c3'
            : 'ffe0b911000000eb05ba22000000';
          await using(code, async (cpu) => {
            for (let round = 0; round < 4; round++) {
              const second = round % 2 === 1;
              const target = calling ? (second ? 0x100en : 0x1008n) : second ? 0x1009n : 0x1002n;
              const sp = calling ? (second ? 0x4020n : 0x4018n) : 0x800000000000n;
              const before = input(
                CODE,
                { 0: target, 4: sp, 1: 0x5566778800000033n, 2: 0x9988776600000044n },
                FLAGS[round]!,
              );
              cpu.writeMemory(0x4000n, hex(RAM));
              cpu.setState(before);
              const result = await cpu.run({ budget: 4n, stop: calling ? 0x1002n : 0x100en });
              exit(
                result,
                'stop',
                4n,
                calling || !second ? 3n : 2n,
                changed(before, calling ? 0x1002n : 0x100en, second ? { 2: 0x22n } : { 1: 0x11n }),
              );
              noFault(result);
              if (round >= 2)
                equal(
                  result.resources.compilations,
                  0,
                  'changing target uses retained instruction entries',
                );
              memory(cpu, 0x4000n, calling ? stack(0x1002n, Number(sp - 8n - 0x4000n)) : RAM);
              memory(cpu, CODE, code);
            }
          });
        }
      },
    },
    {
      name: 'dynamic jumps into another instruction byte decode their own entries rather than accepting a range hit',
      run: async () => {
        const code = 'ffe0b8b903000000';
        await using(code, async (cpu) => {
          for (const [round, target] of [0x1002n, 0x1003n, 0x1002n, 0x1003n].entries()) {
            const before = input(CODE, { 0: target }, 0x12n);
            cpu.setState(before);
            const result = await cpu.run({ budget: 2n });
            exit(
              result,
              'budget',
              2n,
              2n,
              changed(
                before,
                target === 0x1002n ? 0x1007n : 0x1008n,
                target === 0x1002n ? { 0: 0x3b9n } : { 1: 3n },
              ),
            );
            noFault(result);
            equal(
              result.resources.compilations,
              round === 0 ? 2 : round === 1 ? 1 : 0,
              'only distinct missing instruction entries compile',
            );
            memory(cpu, 0x4000n, RAM);
            memory(cpu, CODE, code);
          }
        });
      },
    },
    {
      name: 'dynamic target entry indexes retain their current owner through overlap eviction and reinstallation',
      run: async () => {
        const code = 'ffe0b801000000b902000000ebf9ba03000000';
        await using(
          code,
          async (cpu) => {
            const enter = async (
              target: bigint,
              rip: bigint,
              registers: Record<number, bigint>,
              compilations: number,
            ) => {
              const before = input(CODE, { 0: target }, 0x12n);
              cpu.setState(before);
              const result = await cpu.run({ budget: 2n });
              exit(result, 'budget', 2n, 2n, changed(before, rip, registers));
              noFault(result);
              equal(result.resources.compilations, compilations, 'dynamic route compilation count');
              memory(cpu, 0x4000n, RAM);
              memory(cpu, CODE, code);
            };
            await enter(0x1002n, 0x1007n, { 0: 1n }, 2);
            await enter(0x100cn, 0x1007n, {}, 1);
            const owners = cpu.inspectTranslations();
            check(
              owners.some((unit) => unit.entries[0] === 0x1002n && unit.entries[1] === 0x1007n),
              'first target owner metadata',
            );
            check(
              owners.some((unit) => unit.entries[0] === 0x1007n && unit.entries[1] === 0x100cn),
              'replacement owner changes the shared entry index',
            );
            await enter(0x1007n, 0x100cn, { 1: 2n }, 0);
            await enter(0x100en, 0x1013n, { 2: 3n }, 1);
            check(
              !cpu.inspectTranslations().some((unit) => unit.entries.includes(0x1002n)),
              'old target artifact is evicted',
            );
            await enter(0x1007n, 0x100cn, { 1: 2n }, 0);
            await enter(0x1002n, 0x1007n, { 0: 1n }, 1);
            await enter(0x1007n, 0x100cn, { 1: 2n }, 0);
            await enter(0x100cn, 0x1007n, {}, 0);
          },
          { limits: { maxInstructions: 2, maxCachedArtifacts: 3 } },
        );
      },
    },
    {
      name: 'deep guest calls publish the real stack at maximum depth and resume without host recursion authority',
      run: async () => {
        const depth = 16384;
        const code = 'e80b000000eb190000000000000000004883e9017405e8f5ffffffc3';
        const original = 'a5'.repeat(depth * 8 + 32);
        const words =
          'a5'.repeat(16) + word(0x101bn).repeat(depth - 1) + word(0x1005n) + 'a5'.repeat(16);
        const sp = 0x4000n + BigInt(depth * 8 + 16);
        await using(
          code,
          async (cpu) => {
            const before = input(CODE, { 1: BigInt(depth), 4: sp });
            cpu.setState(before);
            const deepest = await cpu.run({ budget: BigInt(depth * 3 + 1), stop: 0x101bn });
            const atDepth = changed(before, 0x101bn, { 1: 0n, 4: 0x4010n }, 0x46n);
            exit(deepest, 'stop', BigInt(depth * 3 + 1), BigInt(depth * 3), atDepth);
            noFault(deepest);
            memory(cpu, 0x4000n, words);
            const resumed = await cpu.run({ budget: BigInt(depth + 2), stop: 0x1020n });
            exit(
              resumed,
              'stop',
              BigInt(depth + 2),
              BigInt(depth + 1),
              changed(atDepth, 0x1020n, { 4: sp }),
            );
            noFault(resumed);
            equal(
              resumed.resources.compilations,
              0,
              'return continuations were statically admitted',
            );
            memory(cpu, 0x4000n, words);
            memory(cpu, CODE, code);
          },
          { ram: original },
        );
      },
    },
  ];
}
