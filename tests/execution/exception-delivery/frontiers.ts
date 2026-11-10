import {
  using,
  snapshot,
  initial,
  same,
  equal,
  ready,
  delivery,
  type Scenario,
} from './fixture.js';

export function frontierScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'selected UD2 and sole LOCK stage #UD while report mode retains its inherited coverage exit',
      async run() {
        for (const code of ['0f0b', 'f00f0b']) {
          await using(compiler, code, snapshot('protected'), async (cpu) => {
            cpu.setState(initial(0x1000n, {}, 0x202n));
            const reported = await cpu.run({ budget: 1n });
            equal(reported.reason, 'unsupported', 'inherited UD2 report frontier');
            ready(reported);
            const staged = await cpu.run({ budget: 1n, exceptionDelivery: { budget: 0n } });
            delivery(staged, 'event-budget', 0n, 0n, 0n);
            same(
              staged.state.event,
              {
                kind: 'pending',
                exception: {
                  vector: 6,
                  instructionPc: 0x1000n,
                  returnPc: 0x1000n,
                  savedFlags: 0x10202n,
                },
              },
              'selected explicit #UD source',
            );
          });
        }
      },
    },
    {
      name: 'generic invalid unsupported fetch data segment and mandatory alignment frontiers never fabricate automatic exceptions',
      async run() {
        for (const [code, reason, segmentLimit] of [
          ['0f', 'fetch-fault', false],
          ['66'.repeat(15) + '90', 'invalid-encoding', false],
          ['0f05', 'unsupported', false],
          ['a100600000', 'data-fault', false],
          ['a100600000', 'segment-fault', true],
          ['0f280501600000', 'alignment-fault', false],
        ] as const) {
          const execution = snapshot('protected');
          if (segmentLimit) execution.segments.ds.limit = 0x5fff;
          await using(
            compiler,
            code,
            execution,
            async (cpu) => {
              cpu.setState(initial(0x1000n, {}, 0x202n));
              const result = await cpu.run({ budget: 1n, exceptionDelivery: { budget: 2n } });
              delivery(result, reason, 0n, 0n, 2n);
              ready(result);
              equal(result.state.rip, 0x1000n, 'private frontier retains source');
            },
            { data: code.startsWith('0f28') ? [{ base: 0x6001n, bytes: 'a5'.repeat(16) }] : [] },
          );
        }
      },
    },
  ];
}
