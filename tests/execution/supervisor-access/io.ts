import { createCpu } from '../../../host/index.js';
import {
  AUX,
  DATA,
  PC,
  SMAP,
  families,
  fixture,
  hex,
  memory,
  preserved,
  put,
  same,
  state,
  using,
  type Scenario,
} from './fixture.js';

export function supervisorIoScenarios(compiler: WebAssembly.Module): Scenario[] {
  const side = { createCpu, compiler };
  return [
    {
      name: 'supervisor denied INS consumes fresh input before SMAP and retry never replays the lost value',
      async run() {
        for (const family of families) {
          const calls: unknown[] = [],
            values = [0x11, 0x22, 0x33];
          const f = fixture(side, family, 'f36c', {
            io: {
              read(port, width) {
                calls.push(['read', port, width]);
                return values[calls.length - 1]!;
              },
              write() {
                throw Error('INS must not produce output');
              },
            },
          });
          f.paging.cr4 |= SMAP;
          f.leaf(Number(DATA), 0xa067n);
          await using(side, f, async (cpu) => {
            const before = state();
            before.registers[1] = 2n;
            before.registers[2] = 0x80n;
            cpu.setState(before);
            cpu.setTimeState({ tsc: 100n, tscAux: AUX });
            const numeric = preserved(cpu);
            const failed = await cpu.run({ budget: 1n, repeatBudget: 2n });
            same(failed.reason, 'page-fault', 'INS late data admission');
            same(failed.retired, 0n, 'failed INS does not retire');
            same(failed.repeatIterations, 0n, 'failed INS is not a completed element');
            same(failed.state, before, 'INS late denial preserves DI CX');
            same(
              failed.pageFault,
              { vector: 14, address: DATA, access: 'write', errorCode: 3, instructionPc: PC },
              'late INS PF',
            );
            same(calls, [['read', 0x80, 8]], 'input consumed before data PF');
            memory(cpu, f.bytes, 'failed INS no payload');
            same(cpu.readTimeState(), { tsc: 100n, tscAux: AUX }, 'failed element has no time');
            cpu.setPagingState({ ...cpu.readPagingState(), cr4: f.paging.cr4 & ~SMAP });
            const result = await cpu.run({ budget: 1n, repeatBudget: 2n });
            const expected = structuredClone(before);
            expected.rip = PC + 2n;
            expected.registers[1] = 0n;
            expected.registers[7] = DATA + 2n;
            same(result.reason, 'budget', 'fresh retry completes');
            same(result.retired, 1n, 'one REP retirement');
            same(result.repeatIterations, 2n, 'two fresh elements');
            same(result.state, expected, 'retry full scalar');
            same(
              calls,
              [
                ['read', 0x80, 8],
                ['read', 0x80, 8],
                ['read', 0x80, 8],
              ],
              'fresh retry provider inputs',
            );
            const expectedRam = f.bytes.slice();
            expectedRam.set([0x22, 0x33], 0xa000);
            memory(cpu, expectedRam, 'retry writes22 and33');
            same(cpu.readTimeState(), { tsc: 101n, tscAux: AUX }, 'REP counts once');
            numeric();
          });
        }
      },
    },
    {
      name: 'supervisor zero REP and repeat-budget gates skip operands and providers while denied OUTS emits nothing',
      async run() {
        for (const family of families)
          for (const code of ['f3a4', 'f36c', 'f36e'])
            for (const [count, allowance, reason, retired] of [
              [0n, 0n, 'budget', 1n],
              [2n, 0n, 'repeat-budget', 0n],
              [2n, 2n, 'page-fault', 0n],
            ] as const) {
              if (code === 'f36c' && count !== 0n && allowance !== 0n) continue;
              const calls: unknown[] = [],
                f = fixture(side, family, code, {
                  io: {
                    read(port, width) {
                      calls.push(['read', port, width]);
                      return 0x11;
                    },
                    write(port, width, value) {
                      calls.push(['write', port, width, value]);
                    },
                  },
                });
              f.paging.cr4 |= SMAP;
              f.leaf(Number(DATA), 0xa067n);
              await using(side, f, async (cpu) => {
                const before = state();
                before.registers[1] = count;
                before.registers[2] = 0x80n;
                cpu.setState(before);
                const numeric = preserved(cpu),
                  result = await cpu.run({ budget: 1n, repeatBudget: allowance });
                same(result.reason, reason, 'zero REP versus reached operand');
                same(result.retired, retired, 'zero REP retirement');
                same(result.repeatIterations, 0n, 'no completed element');
                same(
                  result.state,
                  { ...before, rip: count === 0n ? PC + 2n : PC },
                  'REP gate scalar',
                );
                same(calls, [], 'no provider effects');
                memory(cpu, f.bytes, 'REP no payload');
                numeric();
              });
            }
      },
    },
    {
      name: 'supervisor real PF handler clears SMAP and IRETD retries INS with fresh input and one completed REP',
      async run() {
        const calls: unknown[] = [],
          values = [0x11, 0x22, 0x33];
        const f = fixture(side, 'non-pae', 'f36c', {
          io: {
            read(port, width) {
              calls.push(['read', port, width]);
              return values[calls.length - 1]!;
            },
            write() {
              throw Error('INS must not produce output');
            },
          },
        });
        f.paging.cr4 |= SMAP;
        f.leaf(Number(DATA), 0xa067n);
        f.bytes.set(hex('500f20e025ffffdfff0f22e05883c404cf'), 0x9000);
        f.bytes.set(hex('00400800008e0000'), 0xc000 + 14 * 8);
        await using(side, f, async (cpu) => {
          const before = state();
          before.registers[1] = 2n;
          before.registers[2] = 0x80n;
          cpu.setState(before);
          cpu.setTimeState({ tsc: 100n, tscAux: AUX });
          const numeric = preserved(cpu);
          const result = await cpu.run({
            budget: 20n,
            repeatBudget: 2n,
            stop: PC + 2n,
            eventDelivery: { budget: 1n },
          });
          const expected = structuredClone(before);
          expected.rip = PC + 2n;
          expected.registers[1] = 0n;
          expected.registers[7] = DATA + 2n;
          same(result.reason, 'stop', 'repaired guest reaches source successor');
          same(result.retired, 8n, 'seven handler instructions plus REP');
          same(result.repeatIterations, 2n, 'only retried elements complete');
          same(result.state, expected, 'guest repair final scalar');
          same(result.deliveryAttempts, 1n, 'exactly one PF entry');
          same(
            calls,
            [
              ['read', 0x80, 8],
              ['read', 0x80, 8],
              ['read', 0x80, 8],
            ],
            'handler does not replay lost input',
          );
          same(
            cpu.readPagingState(),
            { ...f.paging, cr2: DATA, cr4: f.paging.cr4 & ~SMAP },
            'guest-published CR4 repair',
          );
          const expectedRam = f.bytes.slice();
          expectedRam.set([0x22, 0x33], 0xa000);
          put(expectedRam, 0xdfe0, 3n, 4);
          put(expectedRam, 0xdfe4, PC, 4);
          put(expectedRam, 0xdfe8, 8n, 4);
          put(expectedRam, 0xdfec, 0x10002n, 4);
          put(expectedRam, 0xdfdc, before.registers[0]!, 4);
          memory(cpu, expectedRam, 'guest repair frame and fresh payload');
          same(
            cpu.readTimeState(),
            { tsc: 108n, tscAux: AUX },
            'only successful guest instructions tick',
          );
          numeric();
        });
      },
    },
  ];
}
