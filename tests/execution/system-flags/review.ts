import {
  using,
  snapshot,
  initial,
  outcome,
  debug,
  same,
  equal,
  check,
  hex,
  DATA32,
  preserveNumeric,
  type Scenario,
} from './fixture.js';

export function reviewScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'system SS history survives observed-owner eviction and a private fault before the successor',
      async run() {
        await using(
          compiler,
          '8ed090c3',
          snapshot('protected'),
          async (cpu) => {
            const numeric = preserveNumeric(cpu);
            const context = cpu.readContext();
            cpu.setState(initial(0x1000n, { 0: 16n }, 0x102n));
            const loaded = await cpu.run({ budget: 1n, repeatBudget: 11n });
            outcome(loaded, 'budget', 1n, 1n, 11n);
            same(loaded.state.interruptibility, { sti: false, ss: true }, 'SS interval created');
            equal(loaded.debugException, undefined, 'own step suppressed');
            const oldOwner = cpu.inspectTranslations()[0]!.owner;

            const failedInput = {
              ...loaded.state,
              registers: loaded.state.registers.map((value, index) =>
                index === 3 ? 0x6000n : value,
              ),
              flags: 0x10102n,
              rip: 0x2000n,
            };
            cpu.setState(failedInput);
            const failed = await cpu.run({ budget: 1n, repeatBudget: 11n });
            outcome(failed, 'data-fault', 1n, 0n, 11n);
            same(
              failed.state,
              { ...failedInput, flags: 0x102n },
              'only RF begins on failed island',
            );
            equal(failed.fault?.address, 0x6000n, 'missing data byte');
            equal(failed.fault?.segment, 'ds', 'explicit data owner');
            equal(failed.debugException, undefined, 'no step for failed load');
            const island = cpu.inspectTranslations();
            equal(island.length, 1, 'one-artifact cache limit');
            check(island[0]!.owner !== oldOwner, 'old SS producer owner evicted');
            check(island[0]!.entries.includes(0x2000n), 'fault island owns cache');

            const continuation = { ...failed.state, rip: 0x1002n };
            cpu.setState(continuation);
            const resumed = await cpu.run({ budget: 1n, repeatBudget: 11n, stop: 0x1003n });
            outcome(resumed, 'debug-exception', 1n, 1n, 11n);
            debug(resumed, 0x1002n, 0x1003n, true, 0x102n);
            equal(resumed.resources.compilations, 1, 'evicted continuation recompiled');
            same(
              resumed.state,
              { ...continuation, rip: 0x1003n, interruptibility: { sti: false, ss: false } },
              'complete successor state',
            );
            same(cpu.readContext(), context, 'context-equal SS load does not alter caches');
            same(
              Array.from(cpu.readMemory(0x1000n, 4)),
              Array.from(hex('8ed090c3')),
              'producer code unchanged',
            );
            same(
              Array.from(cpu.readMemory(0x2000n, 2)),
              Array.from(hex('8b03')),
              'fault code unchanged',
            );
            same(
              Array.from(cpu.readMemory(0x4010n, 8)),
              Array.from(hex(DATA32)),
              'descriptor unchanged',
            );
            numeric();
          },
          {
            limits: { maxCachedArtifacts: 1 },
            data: [
              { base: 0x4010n, bytes: DATA32, write: false },
              { base: 0x2000n, bytes: '8b03', write: false, execute: true },
            ],
          },
        );
      },
    },
    {
      name: 'system retained observed entries read fresh TF RF and SS inputs within the same profile',
      async run() {
        await using(compiler, '040190', snapshot(), async (cpu) => {
          const numeric = preserveNumeric(cpu);
          const context = cpu.readContext();
          const before = initial(0x1000n, { 0: 0x112233445566777fn }, 0x102n);
          cpu.setState(before);
          const first = await cpu.run({ budget: 1n, repeatBudget: 11n });
          outcome(first, 'debug-exception', 1n, 1n, 11n);
          debug(first, 0x1000n, 0x1002n, true, 0x992n);
          const owner = cpu.inspectTranslations()[0]!.owner;
          check(cpu.inspectTranslations()[0]!.entries.includes(0x1002n), 'middle NOP retained');
          for (const [flags, history, trap, resultFlags] of [
            [0x10002n, { sti: false, ss: false }, false, 2n],
            [2n, { sti: false, ss: true }, false, 2n],
            [0x3c7302n, { sti: false, ss: false }, true, 0x3c7302n],
          ] as const) {
            const input = initial(0x1002n, { 0: 0xfedcba9876543210n }, flags, history);
            cpu.setState(input);
            const result = await cpu.run({ budget: 1n, repeatBudget: 11n, stop: 0x1003n });
            outcome(result, trap ? 'debug-exception' : 'budget', 1n, 1n, 11n);
            if (trap) debug(result, 0x1002n, 0x1003n, true, resultFlags);
            else
              equal(
                result.debugException,
                undefined,
                'fresh non-TF input does not reuse old sampled TF',
              );
            same(
              result.state,
              {
                ...input,
                flags: resultFlags,
                rip: 0x1003n,
                interruptibility: { sti: false, ss: false },
              },
              'fresh full scalar state',
            );
            equal(result.resources.compilations, 0, 'same active profile uses retained body');
            equal(
              cpu.inspectTranslations()[0]!.owner,
              owner,
              'observed owner survives inactive completion',
            );
            same(cpu.readContext(), context, 'same code context');
            numeric();
          }
          same(
            Array.from(cpu.readMemory(0x1000n, 3)),
            Array.from(hex('040190')),
            'retained code unchanged',
          );
        });
      },
    },
  ];
}
