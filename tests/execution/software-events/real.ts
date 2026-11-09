import {
  using,
  snapshot,
  initial,
  outcome,
  debug,
  fullState,
  same,
  equal,
  image,
  encoded,
  guarded,
  FILL,
  STACK,
  preserveNumeric,
  type Scenario,
} from './fixture.js';

export function realScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'software real INT always saves three words and IRET resumes through retained hidden caches',
      async run() {
        for (const code32 of [false, true])
          for (const stack32 of [false, true]) {
            const execution = snapshot('real', 0, code32, stack32);
            execution.segments.cs.selector = 0x1000;
            execution.segments.cs.base = 0x10000n;
            execution.segments.ss.base = 0x10000n;
            execution.idtr = { base: 0x30000n, limit: 0x3ff };
            await using(
              compiler,
              '66cd4090',
              execution,
              async (cpu) => {
                const numeric = preserveNumeric(cpu);
                const sp = 0x1122334400007020n;
                const before = initial(0x1000n, { 4: sp }, 0x50703n);
                cpu.setState(before);
                const entered = await cpu.run({ budget: 1n, repeatBudget: 11n, stop: 0x20n });
                outcome(entered, 'budget', 1n, 1n, 11n);
                fullState(entered, before, 0x20n, sp - 6n, 0x403n);
                same(
                  cpu.readContext(),
                  {
                    ...execution,
                    segments: {
                      ...execution.segments,
                      cs: { ...execution.segments.cs, selector: 0x200, base: 0x2000n },
                    },
                  },
                  'real CS reload retains hidden facts',
                );
                const writes: [bigint, Uint8Array][] = [
                  [0x1701an, image([0x1003n, 0x1000n, 0x703n], 2)],
                ];
                guarded(cpu, 0x10000n + STACK, FILL, writes);
                const returned = await cpu.run({ budget: 1n, repeatBudget: 11n, stop: 0x1003n });
                outcome(returned, 'budget', 1n, 1n, 11n);
                fullState(returned, before, 0x1003n, sp, 0x703n);
                same(cpu.readContext(), execution, 'whole real context restored');
                guarded(cpu, 0x10000n + STACK, FILL, writes);
                const stepped = await cpu.run({ budget: 1n });
                outcome(stepped, 'debug-exception', 1n, 1n);
                debug(stepped, 0x1003n, 0x1004n, true, 0x703n);
                numeric();
              },
              {
                codeBase: 0x11000n,
                data: [
                  { base: 0x30100n, bytes: encoded(image([0x20n, 0x200n], 2)), write: false },
                  { base: 0x2020n, bytes: code32 ? '66cf' : 'cf', execute: true },
                  { base: 0x10000n + STACK, bytes: FILL },
                ],
              },
            );
          }
      },
    },
    {
      name: 'software real IRETD uses its own flag mask and restores RF without accessing its target',
      async run() {
        for (const code32 of [false, true])
          for (const stack32 of [false, true]) {
            const execution = snapshot('real', 0, code32, stack32);
            const frame = encoded(image([0x1234n, 0xa5a50200n, 0xffffffffn], 4));
            await using(
              compiler,
              `${code32 ? '' : '66'}cf`,
              execution,
              async (cpu) => {
                const numeric = preserveNumeric(cpu);
                const before = initial(0x1000n, { 4: 0x1122334400007000n }, 0x180002n);
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n, repeatBudget: 13n, stop: 0x1234n });
                outcome(result, 'budget', 1n, 1n, 13n);
                fullState(result, before, 0x1234n, 0x112233440000700cn, 0x3d7fd7n);
                same(
                  cpu.readContext(),
                  {
                    ...execution,
                    segments: {
                      ...execution.segments,
                      cs: { ...execution.segments.cs, selector: 0x200, base: 0x2000n },
                    },
                  },
                  'real32 selector low half and retained cache',
                );
                same(
                  cpu.readMemory(0x7000n, 12),
                  image([0x1234n, 0xa5a50200n, 0xffffffffn], 4),
                  'return never rewrites frame',
                );
                equal(result.debugException, undefined, 'new TF does not step IRETD');
                numeric();
              },
              { data: [{ base: 0x7000n, bytes: frame, write: false }] },
            );
          }
      },
    },
  ];
}
