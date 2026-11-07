import { createCpu } from '../../../host/index.js';
import { LIMITS, equal, fault, hex, memory } from '../../support/fixture.js';
import { LONG, changed, context, input, outcome, using, type Scenario } from './fixture.js';

export function literalScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'bare LODS ignores count and repeat allowance while writing only its accumulator view',
      async run() {
        await using(
          compiler,
          'ac',
          LONG,
          async (cpu) => {
            const before = input(0x1000n, { 1: 0n, 6: 0x4000n, 7: 0x5000n });
            cpu.setState(before);
            const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
            outcome(
              result,
              'budget',
              1n,
              1n,
              0n,
              0n,
              changed(before, 0x1001n, { 0: 0x112233445566777bn, 6: 0x4001n }),
            );
            memory(cpu, 0x4000n, '7b');
          },
          { data: [{ base: 0x4000n, bytes: '7b' }] },
        );
      },
    },
    {
      name: 'REP overlap observes earlier stores and allowance-one resumes preserve exact progress',
      async run() {
        await using(
          compiler,
          'f3a4',
          LONG,
          async (cpu) => {
            const before = input(0x1000n, { 1: 3n, 6: 0x2000n, 7: 0x2001n });
            cpu.setState(before);
            const first = await cpu.run({ budget: 1n, repeatBudget: 1n });
            outcome(
              first,
              'repeat-budget',
              1n,
              0n,
              1n,
              1n,
              changed(before, 0x1000n, { 1: 2n, 6: 0x2001n, 7: 0x2002n }),
            );
            memory(cpu, 0x2000n, '01010304');
            const final = await cpu.run({ budget: 1n, repeatBudget: 2n });
            outcome(
              final,
              'budget',
              1n,
              1n,
              2n,
              2n,
              changed(before, 0x1002n, { 1: 0n, 6: 0x2003n, 7: 0x2004n }),
            );
            equal(final.resources.compilations, 0, 'retained repeat owner');
            memory(cpu, 0x2000n, '01010101');
          },
          { data: [{ base: 0x2000n, bytes: '01020304' }] },
        );
      },
    },
    {
      name: 'REP destination faults keep completed elements and mapping repair never replays them',
      async run() {
        await using(
          compiler,
          'f3a4',
          LONG,
          async (cpu) => {
            const before = input(0x1000n, { 1: 3n, 6: 0x4000n, 7: 0x5000n });
            cpu.setState(before);
            const failed = await cpu.run({ budget: 1n, repeatBudget: 3n });
            outcome(
              failed,
              'data-fault',
              1n,
              0n,
              3n,
              2n,
              changed(before, 0x1000n, { 1: 1n, 6: 0x4002n, 7: 0x5002n }),
            );
            fault(failed, {
              instructionPc: 0x1000n,
              address: 0x5002n,
              width: 1,
              access: 'write',
              cause: 'unmapped',
              failingAddress: 0x5002n,
              segment: 'es',
            });
            memory(cpu, 0x5000n, '0102');
            cpu.addBacking({ id: 'repair', bytes: hex('a5') });
            cpu.setMappings([
              {
                base: 0x1000n,
                backing: 'code',
                offset: 0,
                length: 2,
                permissions: { read: true, write: false, execute: true },
              },
              {
                base: 0x4000n,
                backing: 'data0',
                offset: 0,
                length: 3,
                permissions: { read: true, write: true, execute: false },
              },
              {
                base: 0x5000n,
                backing: 'data1',
                offset: 0,
                length: 2,
                permissions: { read: true, write: true, execute: false },
              },
              {
                base: 0x5002n,
                backing: 'repair',
                offset: 0,
                length: 1,
                permissions: { read: true, write: true, execute: false },
              },
            ]);
            const final = await cpu.run({ budget: 1n });
            outcome(
              final,
              'budget',
              1n,
              1n,
              1n,
              1n,
              changed(before, 0x1002n, { 1: 0n, 6: 0x4003n, 7: 0x5003n }),
            );
            memory(cpu, 0x5000n, '010203');
          },
          {
            data: [
              { base: 0x4000n, bytes: '010203' },
              { base: 0x5000n, bytes: 'a5a5' },
            ],
          },
        );
      },
    },
    {
      name: 'failed repeated dword stores preserve every byte of the incomplete element',
      async run() {
        await using(
          compiler,
          'f3a5',
          LONG,
          async (cpu) => {
            const before = input(0x1000n, { 1: 2n, 6: 0x4000n, 7: 0x5000n });
            cpu.setState(before);
            const result = await cpu.run({ budget: 1n, repeatBudget: 3n });
            outcome(
              result,
              'data-fault',
              1n,
              0n,
              3n,
              1n,
              changed(before, 0x1000n, { 1: 1n, 6: 0x4004n, 7: 0x5004n }),
            );
            fault(result, {
              instructionPc: 0x1000n,
              address: 0x5004n,
              width: 4,
              access: 'write',
              cause: 'unmapped',
              failingAddress: 0x5006n,
              segment: 'es',
            });
            memory(cpu, 0x5000n, '11223344a5a5');
          },
          {
            data: [
              { base: 0x4000n, bytes: '1122334455667788' },
              { base: 0x5000n, bytes: 'a5a5a5a5a5a5' },
            ],
          },
        );
      },
    },
    {
      name: 'repeated comparison faults and yields restore this instruction entry flags after predecessors',
      async run() {
        for (const predecessor of [false, true])
          for (const sliced of [false, true])
            await using(
              compiler,
              predecessor ? '0401f3a6' : 'f3a6',
              LONG,
              async (cpu) => {
                const before = input(
                  0x1000n,
                  { 0: 0x112233445566777fn, 1: 3n, 6: 0x4000n, 7: 0x5000n },
                  2n,
                );
                cpu.setState(before);
                const pc = predecessor ? 0x1002n : 0x1000n;
                const flags = predecessor ? 0x892n : 2n;
                if (sliced) {
                  const first = await cpu.run({ budget: predecessor ? 2n : 1n, repeatBudget: 1n });
                  outcome(
                    first,
                    'repeat-budget',
                    predecessor ? 2n : 1n,
                    predecessor ? 1n : 0n,
                    1n,
                    1n,
                    changed(
                      before,
                      pc,
                      {
                        0: predecessor ? 0x1122334455667780n : before.registers[0]!,
                        1: 2n,
                        6: 0x4001n,
                        7: 0x5001n,
                      },
                      flags,
                    ),
                  );
                }
                const budget = !sliced && predecessor ? 2n : 1n;
                const result = await cpu.run({ budget, repeatBudget: 3n });
                outcome(
                  result,
                  'data-fault',
                  budget,
                  !sliced && predecessor ? 1n : 0n,
                  3n,
                  sliced ? 1n : 2n,
                  changed(
                    before,
                    pc,
                    {
                      0: predecessor ? 0x1122334455667780n : before.registers[0]!,
                      1: 1n,
                      6: 0x4002n,
                      7: 0x5002n,
                    },
                    flags,
                  ),
                );
                fault(result, {
                  instructionPc: pc,
                  address: 0x4002n,
                  width: 1,
                  access: 'read',
                  cause: 'unmapped',
                  failingAddress: 0x4002n,
                  segment: 'ds',
                });
                memory(cpu, 0x4000n, '0506');
                memory(cpu, 0x5000n, '050607');
              },
              {
                data: [
                  { base: 0x4000n, bytes: '0506' },
                  { base: 0x5000n, bytes: '050607' },
                ],
              },
            );
      },
    },
    {
      name: 'conditional REP completion wins exact work exhaustion and ignores incoming ZF',
      async run() {
        for (const equalPair of [false, true])
          await using(
            compiler,
            'f3a6',
            LONG,
            async (cpu) => {
              const before = input(0x1000n, { 1: 3n, 6: 0x4000n, 7: 0x5000n }, 2n);
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n, repeatBudget: 2n });
              outcome(
                result,
                equalPair ? 'repeat-budget' : 'budget',
                1n,
                equalPair ? 0n : 1n,
                2n,
                2n,
                changed(
                  before,
                  equalPair ? 0x1000n : 0x1002n,
                  { 1: 1n, 6: 0x4002n, 7: 0x5002n },
                  equalPair ? 2n : 0x97n,
                ),
              );
            },
            {
              data: [
                { base: 0x4000n, bytes: '0506' },
                { base: 0x5000n, bytes: equalPair ? '0506' : '0507' },
              ],
            },
          );
        for (const flags of [2n, 0x42n])
          await using(
            compiler,
            'f2ae',
            LONG,
            async (cpu) => {
              const before = input(
                0x1000n,
                { 0: 0x1122334455667705n, 1: 3n, 6: 0x4000n, 7: 0x5000n },
                flags,
              );
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n, repeatBudget: 1n });
              outcome(
                result,
                'budget',
                1n,
                1n,
                1n,
                1n,
                changed(before, 0x1002n, { 1: 2n, 7: 0x5001n }, 0x46n),
              );
            },
            { data: [{ base: 0x5000n, bytes: '05' }] },
          );
      },
    },
    {
      name: 'zero selected count preserves raw address32 banks and skips inaccessible operands',
      async run() {
        await using(compiler, '67f3a4', LONG, async (cpu) => {
          const before = input(0x1000n, {
            1: 0x1122334400000000n,
            6: 0x800000004000n,
            7: 0x800000005000n,
          });
          cpu.setState(before);
          outcome(
            await cpu.run({ budget: 1n, repeatBudget: 0n }),
            'budget',
            1n,
            1n,
            0n,
            0n,
            changed(before, 0x1003n),
          );
        });
        await using(
          compiler,
          '67f3a4',
          LONG,
          async (cpu) => {
            const before = input(0x1000n, {
              1: 0x1122334400000001n,
              6: 0xaabbccdd00004000n,
              7: 0x9988776600005000n,
            });
            cpu.setState(before);
            outcome(
              await cpu.run({ budget: 1n }),
              'budget',
              1n,
              1n,
              1n,
              1n,
              changed(before, 0x1003n, { 1: 0n, 6: 0x4001n, 7: 0x5001n }),
            );
            memory(cpu, 0x5000n, '7b');
          },
          {
            data: [
              { base: 0x4000n, bytes: '7b' },
              { base: 0x5000n, bytes: 'a5' },
            ],
          },
        );
      },
    },
    {
      name: 'word strings span offset ffff before wrapping indices and retain nonlong raw banks',
      async run() {
        const ctx = context('protected', false, true);
        ctx.segments.ds.base = 0x10000n;
        ctx.segments.es.base = 0x30000n;
        await using(
          compiler,
          'f3a5',
          ctx,
          async (cpu) => {
            const before = input(0x1000n, {
              1: 0xaabbccdd12340001n,
              6: 0x112233445566ffffn,
              7: 0x99aabbccddee0010n,
            });
            cpu.setState(before);
            outcome(
              await cpu.run({ budget: 1n }),
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
      },
    },
    {
      name: 'FS string source does not override ES destination',
      async run() {
        await using(
          compiler,
          '64f3a4',
          { mode: 'long64', fsBase: 0x100000000n, gsBase: 0n },
          async (cpu) => {
            const before = input(0x1000n, { 1: 1n, 6: 0x4000n, 7: 0x5000n });
            cpu.setState(before);
            outcome(
              await cpu.run({ budget: 1n }),
              'budget',
              1n,
              1n,
              1n,
              1n,
              changed(before, 0x1003n, { 1: 0n, 6: 0x4001n, 7: 0x5001n }),
            );
            memory(cpu, 0x5000n, '7b');
            memory(cpu, 0x100005000n, 'a5');
          },
          {
            data: [
              { base: 0x100004000n, bytes: '7b' },
              { base: 0x5000n, bytes: 'a5' },
              { base: 0x100005000n, bytes: 'a5' },
            ],
          },
        );
      },
    },
    {
      name: 'STD survives inherited flag writers before descending REP',
      async run() {
        await using(
          compiler,
          'fd31c0f3a4',
          LONG,
          async (cpu) => {
            const before = input(0x1000n, { 1: 4n, 6: 0x4003n, 7: 0x5003n }, 2n);
            cpu.setState(before);
            outcome(
              await cpu.run({ budget: 3n, repeatBudget: 4n }),
              'budget',
              3n,
              3n,
              4n,
              4n,
              changed(before, 0x1005n, { 0: 0n, 1: 0n, 6: 0x3fffn, 7: 0x4fffn }, 0x446n),
            );
            memory(cpu, 0x5000n, '01020304');
          },
          {
            data: [
              { base: 0x4000n, bytes: '01020304' },
              { base: 0x5000n, bytes: 'a5a5a5a5' },
            ],
          },
        );
      },
    },
    {
      name: 'unfinished REP re-fetches a changed prefix and bare replacement completes before SMC dispatch',
      async run() {
        const bytes = hex('f3a4f5');
        const cpu = await createCpu({
          compiler,
          memory: {
            backings: [
              { id: 'code', bytes },
              { id: 'source', bytes: hex('a47b') },
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
          memoryLimits: { maxBackings: 2, maxBackingBytes: 5, maxMappings: 3 },
          limits: LIMITS,
        });
        try {
          const before = input(0x1000n, { 1: 2n, 6: 0x4000n, 7: 0x2000n });
          cpu.setState(before);
          const result = await cpu.run({ budget: 1n, repeatBudget: 2n });
          outcome(
            result,
            'budget',
            1n,
            1n,
            2n,
            1n,
            changed(before, 0x1001n, { 1: 1n, 6: 0x4002n, 7: 0x2002n }),
          );
          equal(result.resources.dispatches, 1, 'one partial instruction dispatch');
          equal(result.resources.compilations, 2, 'replacement code compiled');
          memory(cpu, 0x1000n, 'a47bf5');
          memory(cpu, 0x2000n, 'a47bf5');
        } finally {
          cpu.dispose();
        }
      },
    },
  ];
}
