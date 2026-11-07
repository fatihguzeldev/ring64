import { createCpu } from '../../../host/index.js';
import { LIMITS, equal, fault, hex, memory } from '../../support/fixture.js';
import { LONG, changed, context, input, outcome, using, type Scenario } from './fixture.js';

export function boundaryScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'repeat work admission suppresses operands but preserves decode and source failure priority',
      async run() {
        for (const code of ['f3a5', 'f3a7'])
          await using(
            compiler,
            code,
            LONG,
            async (cpu) => {
              const before = input(0x1000n, { 1: 2n, 6: 0x4000n, 7: 0x5000n });
              cpu.setState(before);
              outcome(
                await cpu.run({ budget: 1n, repeatBudget: 0n }),
                'repeat-budget',
                1n,
                0n,
                0n,
                0n,
                before,
              );
              const failed = await cpu.run({ budget: 1n, repeatBudget: 1n });
              outcome(failed, 'data-fault', 1n, 0n, 1n, 0n, before);
              fault(failed, {
                instructionPc: 0x1000n,
                address: 0x4000n,
                width: 4,
                access: 'read',
                cause: 'permission',
                failingAddress: 0x4000n,
                segment: 'ds',
              });
            },
            { data: [{ base: 0x4000n, bytes: '01020304', read: false }] },
          );
        for (const [code, reason] of [
          ['f2a4', 'unsupported'],
          ['f0a4', 'invalid-encoding'],
          ['f3', 'fetch-fault'],
          ['66'.repeat(15), 'invalid-encoding'],
        ])
          await using(compiler, code!, LONG, async (cpu) => {
            const before = input(0x1000n, { 1: 2n, 6: 0x4000n, 7: 0x5000n });
            cpu.setState(before);
            const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
            outcome(result, reason!, 1n, 0n, 0n, 0n, before);
            if (reason === 'fetch-fault')
              fault(result, {
                instructionPc: 0x1000n,
                address: 0x1001n,
                width: 1,
                access: 'execute',
                cause: 'unmapped',
                failingAddress: 0x1001n,
                segment: 'cs',
              });
          });
      },
    },
    {
      name: 'word repeat checks the full unwrapped segment span and repairs independently of SS.B',
      async run() {
        for (const stack32 of [false, true]) {
          const execution = context('protected', false, stack32);
          execution.segments.ds.base = 0x10000n;
          execution.segments.ds.limit = 0xffff;
          execution.segments.es.base = 0x30000n;
          await using(
            compiler,
            'f3a5',
            execution,
            async (cpu) => {
              const before = input(0x1000n, {
                1: 0xaabbccdd12340001n,
                6: 0x112233445566ffffn,
                7: 0x99aabbccddee0010n,
              });
              cpu.setState(before);
              const failed = await cpu.run({ budget: 1n, repeatBudget: 1n });
              outcome(failed, 'segment-fault', 1n, 0n, 1n, 0n, before);
              equal(failed.fault, undefined, 'segment failure has no linear fault');
              for (const [name, expected] of Object.entries({
                segment: 'ds',
                instructionPc: 0x1000n,
                offset: 0xffffn,
                width: 2,
                access: 'read',
                cause: 'limit',
                failingOffset: 0x10000n,
              }))
                equal(
                  failed.segmentFault?.[name as keyof NonNullable<typeof failed.segmentFault>],
                  expected,
                  `full element segment ${name}`,
                );
              memory(cpu, 0x30010n, 'a5a5');
              execution.segments.ds.limit = 0x10000;
              cpu.setContext(execution);
              outcome(
                await cpu.run({ budget: 1n, repeatBudget: 1n }),
                'budget',
                1n,
                1n,
                1n,
                1n,
                changed(before, 0x1002n, {
                  1: 0xaabbccdd12340000n,
                  6: 0x1122334455660001n,
                  7: 0x99aabbccddee0012n,
                }),
              );
              memory(cpu, 0x30010n, '7856');
            },
            {
              data: [
                { base: 0x1ffffn, bytes: '7856' },
                { base: 0x30010n, bytes: 'a5a5' },
              ],
            },
          );
        }
      },
    },
    {
      name: 'LODS faults retain the last completed accumulator and STOS resumes accept idle changes',
      async run() {
        await using(
          compiler,
          'f3ac',
          LONG,
          async (cpu) => {
            const before = input(0x1000n, { 1: 3n, 6: 0x4000n });
            cpu.setState(before);
            const failed = await cpu.run({ budget: 1n, repeatBudget: 3n });
            outcome(
              failed,
              'data-fault',
              1n,
              0n,
              3n,
              2n,
              changed(before, 0x1000n, { 0: 0x1122334455667702n, 1: 1n, 6: 0x4002n }),
            );
            fault(failed, {
              instructionPc: 0x1000n,
              address: 0x4002n,
              width: 1,
              access: 'read',
              cause: 'unmapped',
              failingAddress: 0x4002n,
              segment: 'ds',
            });
          },
          { data: [{ base: 0x4000n, bytes: '0102' }] },
        );
        await using(
          compiler,
          'f3aa',
          LONG,
          async (cpu) => {
            const before = input(0x1000n, { 1: 2n, 7: 0x5001n });
            cpu.setState(before);
            const first = await cpu.run({ budget: 1n, repeatBudget: 1n });
            const suspended = changed(before, 0x1000n, { 1: 1n, 7: 0x5002n });
            outcome(first, 'repeat-budget', 1n, 0n, 1n, 1n, suspended);
            memory(cpu, 0x5000n, 'a588a5');
            const edited = changed(suspended, 0x1000n, { 0: 0x112233445566777bn }, 0xcd7n);
            cpu.setState(edited);
            outcome(
              await cpu.run({ budget: 1n, repeatBudget: 1n }),
              'budget',
              1n,
              1n,
              1n,
              1n,
              changed(edited, 0x1002n, { 1: 0n, 7: 0x5001n }),
            );
            memory(cpu, 0x5000n, 'a5887b');
          },
          { data: [{ base: 0x5000n, bytes: 'a5a5a5' }] },
        );
      },
    },
    {
      name: 'separate repeated instructions share one allowance while ordinary instructions still retire',
      async run() {
        await using(
          compiler,
          'f3acb902000000f3ac',
          LONG,
          async (cpu) => {
            const before = input(0x1000n, { 1: 1n, 6: 0x4000n });
            cpu.setState(before);
            const first = await cpu.run({ budget: 3n, repeatBudget: 2n });
            outcome(
              first,
              'repeat-budget',
              3n,
              2n,
              2n,
              2n,
              changed(before, 0x1007n, { 0: 0x1122334455667702n, 1: 1n, 6: 0x4002n }),
            );
            outcome(
              await cpu.run({ budget: 1n, repeatBudget: 1n }),
              'budget',
              1n,
              1n,
              1n,
              1n,
              changed(before, 0x1009n, { 0: 0x1122334455667703n, 1: 0n, 6: 0x4003n }),
            );
          },
          { data: [{ base: 0x4000n, bytes: '010203' }] },
        );
      },
    },
    {
      name: 'FS and GS address32 repeats span the element before wrapping source and destination indices',
      async run() {
        for (const prefix of ['64', '65'])
          for (const descending of [false, true]) {
            const execution = {
              mode: 'long64' as const,
              fsBase: 0x100000000n,
              gsBase: 0x100000000n,
            };
            const start = descending ? 4n : 0xfffffffcn;
            const end = descending ? 0xfffffff4n : 12n;
            await using(
              compiler,
              `${prefix}67f348a5`,
              execution,
              async (cpu) => {
                const before = input(
                  0x1000n,
                  {
                    1: 0x1122334400000002n,
                    6: 0x9988776600000000n | start,
                    7: 0xaabbccdd00000000n | start,
                  },
                  descending ? 0xcd7n : 0x8d7n,
                );
                cpu.setState(before);
                outcome(
                  await cpu.run({ budget: 1n, repeatBudget: 2n }),
                  'budget',
                  1n,
                  1n,
                  2n,
                  2n,
                  changed(before, 0x1005n, { 1: 0n, 6: end, 7: end }),
                );
                memory(cpu, 0xfffffffcn, '1122334455667788');
                memory(cpu, 4n, '99aabbccddeeff00');
                memory(cpu, 0x1fffffffcn, '1122334455667788');
                memory(cpu, 0x100000004n, '99aabbccddeeff00');
              },
              {
                data: [
                  { base: 0x1fffffffcn, bytes: '1122334455667788' },
                  { base: 0x100000004n, bytes: '99aabbccddeeff00' },
                  { base: 0xfffffffcn, bytes: 'a5a5a5a5a5a5a5a5' },
                  { base: 4n, bytes: 'a5a5a5a5a5a5a5a5' },
                ],
              },
            );
          }
      },
    },
    {
      name: 'unchanged REP bytes still invalidate ownership and retain quota across resource refusal',
      async run() {
        const cpu = await createCpu({
          compiler,
          memory: {
            backings: [
              { id: 'code', bytes: hex('f3a4f5') },
              { id: 'source', bytes: hex('f3a4') },
            ],
            mappings: [
              {
                base: 0x1000n,
                backing: 'code',
                offset: 0,
                length: 3,
                permissions: { read: true, write: false, execute: true },
              },
              {
                base: 0x2000n,
                backing: 'code',
                offset: 0,
                length: 3,
                permissions: { read: true, write: true, execute: false },
              },
              {
                base: 0x4000n,
                backing: 'source',
                offset: 0,
                length: 2,
                permissions: { read: true, write: false, execute: false },
              },
            ],
          },
          entry: 0x1000n,
          memoryLimits: { maxBackings: 2, maxMappings: 3, maxBackingBytes: 5 },
          limits: { ...LIMITS, maxTranslationsPerRun: 1 },
        });
        try {
          const before = input(0x1000n, { 1: 2n, 6: 0x4000n, 7: 0x2000n });
          cpu.setState(before);
          const first = await cpu.run({ budget: 1n, repeatBudget: 2n });
          outcome(
            first,
            'resource-limit',
            1n,
            0n,
            2n,
            1n,
            changed(before, 0x1000n, { 1: 1n, 6: 0x4001n, 7: 0x2001n }),
          );
          equal(first.resources.nativeEntries, 1, 'one partial native entry');
          equal(first.resources.dispatches, 1, 'one invalidated owner dispatch');
          memory(cpu, 0x1000n, 'f3a4f5');
          outcome(
            await cpu.run({ budget: 1n, repeatBudget: 1n }),
            'budget',
            1n,
            1n,
            1n,
            1n,
            changed(before, 0x1002n, { 1: 0n, 6: 0x4002n, 7: 0x2002n }),
          );
          memory(cpu, 0x2000n, 'f3a4f5');
        } finally {
          cpu.dispose();
        }
      },
    },
  ];
}
