import { exit, fault, memory, state } from '../../support/fixture.js';
import { using } from '../modes/fixture.js';
import {
  PC,
  compoundProfiles,
  equal,
  expected,
  input,
  same,
  type Scenario,
} from './compound-fixture.js';

const long = compoundProfiles.at(-1)!;
const legacy = compoundProfiles.find((profile) => profile.name === 'protected/32/32')!;
const data = [{ base: 0x4ff0n, bytes: 'a5'.repeat(32) }];

export function compoundDecodeScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'compound required ENTER immediate bytes precede LOCK legality and operand refusal',
      async run() {
        for (const complete of ['c8ffff1f', 'f0c8000000', '6648c8000000', '4866c8000000'])
          for (let length = 1; length < complete.length / 2; length++) {
            const code = complete.slice(0, 2 * length);
            await using(
              compiler,
              code,
              long.execution,
              async (cpu) => {
                const before = input(long, { 4: 0x7000n }, 2n);
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                exit(result, 'fetch-fault', 1n, 0n, before);
                fault(result, {
                  instructionPc: PC,
                  address: PC + BigInt(length),
                  width: 1,
                  access: 'execute',
                  cause: 'unmapped',
                  failingAddress: PC + BigInt(length),
                });
                memory(cpu, 0x4ff0n, 'a5'.repeat(32));
              },
              { data },
            );
          }
      },
    },
    {
      name: 'compound fifteen-byte admission and deciding illegal prefixes preserve exact fault frontiers',
      async run() {
        const valid = '66'.repeat(11) + 'c8000000';
        await using(
          compiler,
          valid,
          long.execution,
          async (cpu) => {
            const before = input(long, {}, 2n);
            cpu.setState(before);
            const result = await cpu.run({ budget: 1n });
            exit(result, 'budget', 1n, 1n, expected(before, PC + 15n, { 4: 0x4ffen, 5: 0x4ffen }));
            memory(cpu, 0x4ffen, '0060');
          },
          { data },
        );
        for (const [profile, code, reason, vector, errorCode] of [
          [long, '66'.repeat(12) + 'c80000', 'invalid-encoding', 13, 0],
          [long, 'f0c8000000', 'invalid-encoding', 6, undefined],
          [legacy, 'f060', 'invalid-encoding', 6, undefined],
          [legacy, 'f061', 'invalid-encoding', 6, undefined],
          [long, '60', 'invalid-encoding', 6, undefined],
          [long, '664f61', 'invalid-encoding', 6, undefined],
        ] as const)
          await using(
            compiler,
            code,
            profile.execution,
            async (cpu) => {
              const before = input(profile, { 4: 0x7000n }, 0x10202n);
              cpu.setState(before);
              const report = await cpu.run({ budget: 1n });
              equal(report.reason, reason, code + ' report');
              state(report.state, before);
              const delivered = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
              equal(delivered.reason, 'event-budget', code + ' pending');
              same(
                delivered.state.event,
                {
                  kind: 'pending',
                  exception: {
                    vector,
                    instructionPc: PC,
                    returnPc: PC,
                    savedFlags: 0x10202n,
                    ...(errorCode === undefined ? {} : { errorCode }),
                  },
                },
                code + ' exact exception',
              );
              equal(delivered.retired, 0n, 'decode has no completion');
              equal(delivered.resources.compilations, 0, 'decode beats tiny artifact quota');
              memory(cpu, 0x4ff0n, 'a5'.repeat(32));
            },
            { data, limits: { maxArtifactBytes: 1 } },
          );
        for (const code of ['f2c8', 'f3c8', 'f0f0c8', 'f2f0c8'])
          await using(
            compiler,
            code,
            long.execution,
            async (cpu) => {
              const before = input(long, {}, 2n);
              cpu.setState(before);
              exit(await cpu.run({ budget: 1n }), 'unsupported', 1n, 0n, before);
            },
            { data },
          );
      },
    },
    {
      name: 'compound entry budget stop and execute debug precede decode resources and all stack effects',
      async run() {
        for (const [profile, code] of [
          [long, 'c8000000'],
          [legacy, '60'],
          [legacy, '61'],
          [long, 'c8'],
          [long, '60'],
        ] as const)
          await using(
            compiler,
            code,
            profile.execution,
            async (cpu) => {
              const before = input(profile, { 4: 0x7000n }, 0x202n);
              cpu.setState(before);
              for (const [budget, reason] of [
                [0n, 'budget'],
                [1n, 'stop'],
              ] as const) {
                const result = await cpu.run({ budget, stop: PC });
                exit(result, reason, budget, 0n, before);
                equal(result.resources.nativeEntries, 0, 'gate excludes native entry');
                equal(result.resources.compilations, 0, 'gate excludes compile');
              }
              cpu.setDebugState({ addresses: [PC, 0x4ff8n, 0n, 0n], dr6: 0n, dr7: 0x00d00405n });
              const result = await cpu.run({ budget: 1n });
              equal(result.reason, 'debug-exception', 'execute breakpoint wins');
              equal(result.debugException?.class, 'fault', 'execute fault class');
              equal(result.debugException?.breakpoints, 1, 'only execute comparator');
              equal(result.retired, 0n, 'execute fault never retires');
              equal(result.resources.compilations, 0, 'execute debug precedes quota');
              state(result.state, before);
              memory(cpu, 0x4ff0n, 'a5'.repeat(32));
            },
            { data, limits: { maxArtifactBytes: 1 } },
          );
      },
    },
    {
      name: 'compound completion gates hide successor fetch until the next admitted resume',
      async run() {
        await using(
          compiler,
          'c8200000',
          long.execution,
          async (cpu) => {
            const before = input(long, {}, 2n);
            cpu.setState(before);
            const after = expected(before, PC + 4n, { 4: 0x4fd8n, 5: 0x4ff8n });
            exit(await cpu.run({ budget: 1n }), 'budget', 1n, 1n, after);
            memory(cpu, 0x4ff8n, '0060000000000000');
            exit(await cpu.run({ budget: 0n }), 'budget', 0n, 0n, after);
            exit(await cpu.run({ budget: 1n, stop: PC + 4n }), 'stop', 1n, 0n, after);
            const failure = await cpu.run({ budget: 1n });
            exit(failure, 'fetch-fault', 1n, 0n, after);
            fault(failure, {
              instructionPc: PC + 4n,
              address: PC + 4n,
              width: 1,
              access: 'execute',
              cause: 'unmapped',
              failingAddress: PC + 4n,
            });
          },
          {
            data: [{ base: 0x4fd8n, bytes: 'a5'.repeat(48) }],
            limits: { maxInstructions: 1, maxTranslationsPerRun: 1 },
          },
        );
      },
    },
  ];
}
