import {
  using,
  snapshot,
  initial,
  outcome,
  debug,
  equal,
  same,
  preserveNumeric,
  type Scenario,
} from './fixture.js';

export function repeatedScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'system TF repeated MOVS exposes one completed element and a restartable saved RF image',
      async run() {
        for (const backward of [false, true]) {
          await using(
            compiler,
            'f3a4',
            snapshot(),
            async (cpu) => {
              const numeric = preserveNumeric(cpu);
              const flags = backward ? 0x502n : 0x102n;
              cpu.setState(
                initial(
                  0x1000n,
                  { 1: 3n, 6: backward ? 0x6002n : 0x6000n, 7: backward ? 0x7002n : 0x7000n },
                  flags,
                ),
              );
              for (let element = 1; element <= 3; element++) {
                const result = await cpu.run({ budget: 1n, repeatBudget: 3n, stop: 0x1002n });
                outcome(result, 'debug-exception', 1n, element === 3 ? 1n : 0n, 3n, 1n);
                debug(
                  result,
                  0x1000n,
                  element === 3 ? 0x1002n : 0x1000n,
                  element === 3,
                  flags | (element === 3 ? 0n : 0x10000n),
                );
                equal(result.state.flags, flags, 'saved RF does not alter live RF');
                equal(result.state.registers[1], BigInt(3 - element), 'completed count');
                equal(
                  result.state.registers[6],
                  backward ? 0x6002n - BigInt(element) : 0x6000n + BigInt(element),
                  'completed source index',
                );
                equal(
                  result.state.registers[7],
                  backward ? 0x7002n - BigInt(element) : 0x7000n + BigInt(element),
                  'completed destination index',
                );
                const expected = backward ? [0xa5, 0xa5, 0x33] : [0x11, 0xa5, 0xa5];
                if (element >= 2) expected[1] = 0x22;
                if (element === 3) {
                  expected[0] = 0x11;
                  expected[2] = 0x33;
                }
                same(
                  cpu.readMemory(0x7000n, 3),
                  Uint8Array.from(expected),
                  'each write happens once',
                );
                numeric();
              }
            },
            {
              data: [
                { base: 0x6000n, bytes: '112233' },
                { base: 0x7000n, bytes: 'a5a5a5' },
              ],
            },
          );
        }
      },
    },
    {
      name: 'system TF CMPS trap publishes comparison flags while private suspensions restore entry flags',
      async run() {
        await using(
          compiler,
          'f3a6',
          snapshot(),
          async (cpu) => {
            const numeric = preserveNumeric(cpu);
            cpu.setState(initial(0x1000n, { 1: 3n, 6: 0x6000n, 7: 0x7000n }, 0x102n));
            const first = await cpu.run({ budget: 1n, repeatBudget: 3n });
            outcome(first, 'debug-exception', 1n, 0n, 3n, 1n);
            debug(first, 0x1000n, 0x1000n, false, 0x10146n);
            equal(first.state.flags, 0x146n, 'equal comparison visible');
            const second = await cpu.run({ budget: 1n, repeatBudget: 3n });
            outcome(second, 'debug-exception', 1n, 1n, 3n, 1n);
            debug(second, 0x1000n, 0x1002n, true, 0x197n);
            equal(second.state.flags, 0x197n, 'unequal comparison visible');
            equal(second.state.registers[1], 1n, 'conditional termination');
            cpu.setState(
              initial(0x1000n, { 1: 3n, 6: 0x6000n, 7: 0x7000n }, 0x1108d7n, {
                sti: false,
                ss: true,
              }),
            );
            const suspended = await cpu.run({ budget: 1n, repeatBudget: 1n });
            outcome(suspended, 'repeat-budget', 1n, 0n, 1n, 1n);
            equal(
              suspended.state.flags,
              0x1008d7n,
              'entry status restored without RF resurrection',
            );
            same(
              suspended.state.interruptibility,
              { sti: false, ss: true },
              'private partial suspension keeps shadow',
            );
            cpu.setState(initial(0x1000n, { 1: 1n, 6: 0x8000n, 7: 0x7000n }, 0x11102n));
            const faulted = await cpu.run({ budget: 1n, repeatBudget: 1n });
            outcome(faulted, 'data-fault', 1n, 0n, 1n);
            equal(faulted.state.flags, 0x1102n, 'first attempted element clears RF');
            equal(faulted.debugException, undefined, 'no completed element trap');
            numeric();
          },
          {
            data: [
              { base: 0x6000n, bytes: '112233' },
              { base: 0x7000n, bytes: '112344' },
            ],
          },
        );
      },
    },
    {
      name: 'system zero-count REP traps but repeat refusal before first work preserves RF and shadows',
      async run() {
        await using(compiler, 'f3a4', snapshot(), async (cpu) => {
          const numeric = preserveNumeric(cpu);
          for (const count of [0n, 1n]) {
            cpu.setState(
              initial(0x1000n, { 1: count, 6: 0x800000000000n, 7: 0x800000000000n }, 0x10102n, {
                sti: false,
                ss: true,
              }),
            );
            const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
            outcome(
              result,
              count === 0n ? 'debug-exception' : 'repeat-budget',
              1n,
              count === 0n ? 1n : 0n,
              0n,
            );
            if (count === 0n) debug(result, 0x1000n, 0x1002n, true, 0x102n);
            else {
              equal(result.state.flags, 0x10102n, 'no RF begin before available work');
              same(
                result.state.interruptibility,
                { sti: false, ss: true },
                'no shadow consumption',
              );
            }
            numeric();
          }
        });
      },
    },
  ];
}
