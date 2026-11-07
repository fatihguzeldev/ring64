import { equal } from '../../support/fixture.js';
import {
  MASK128,
  LONG,
  banks,
  changed,
  context,
  input,
  outcome,
  profiles,
  using,
  xmm,
  type Scenario,
} from './fixture.js';
import { encoding, packedCases } from './catalog.js';

const values = [
  0n,
  MASK128,
  0x80007fff80007fff80007fff80007fffn,
  0x0123456789abcdeffedcba9876543210n,
];
export function registerScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'SIMD integer families match independent lane models in every imported context',
      async run() {
        for (const profile of profiles)
          for (const row of packedCases()) {
            const code = encoding(row);
            const execution =
              profile.mode === 'long64'
                ? LONG
                : context(profile.mode, profile.code32, profile.stack32);
            await using(compiler, code, execution, async (cpu) => {
              for (
                let sample = 0;
                sample < (row.countWidth === undefined ? values.length : 8);
                sample++
              ) {
                const before = input(0x1000n, {}, sample % 2 ? 0x8d7n : 0xcd7n),
                  raw = banks();
                raw[0] = values[sample % values.length]!;
                raw[1] = values[(sample + 1) % values.length]!;
                if (row.countWidth !== undefined) {
                  const width = BigInt(row.countWidth);
                  const counts = [
                    0n,
                    1n,
                    width - 1n,
                    width,
                    width + 1n,
                    255n,
                    0x100000000n,
                    (1n << 64n) - 1n,
                  ];
                  raw[1] = (0xdeadbeef01234567n << 64n) | counts[sample]!;
                }
                const expected = raw.slice();
                expected[0] = row.model(raw[0]!, raw[1]!);
                cpu.setState(before);
                cpu.setXmmState(raw);
                const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
                outcome(
                  result,
                  'budget',
                  1n,
                  1n,
                  0n,
                  0n,
                  changed(before, 0x1000n + BigInt(code.length / 2)),
                );
                xmm(cpu, expected);
                if (sample > 0)
                  equal(
                    result.resources.compilations,
                    0,
                    `${profile.name}/${row.name} values are not code dependencies`,
                  );
              }
            });
          }
      },
    },
    {
      name: 'SIMD extended register and same-bank aliases use incoming operands at retained entries',
      async run() {
        for (const row of packedCases())
          for (const [dst, src, rex] of row.group === undefined
            ? ([
                [0, 0, ''],
                [8, 9, '45'],
                [15, 15, '45'],
              ] as const)
            : ([
                [0, 0, '44'],
                [8, 8, '41'],
                [15, 15, '4d'],
              ] as const)) {
            const code = encoding(row, dst, src, rex);
            await using(compiler, code, LONG, async (cpu) => {
              const raw = banks(),
                before = input(0x1000n, {}, 0xcd7n);
              raw[dst] = 0x800080007fff7fff0001ffff1234abcdff00a5a5n & MASK128;
              const expected = raw.slice();
              expected[dst] = row.model(raw[dst]!, raw[src]!);
              cpu.setXmmState(raw);
              cpu.setState(before);
              outcome(
                await cpu.run({ budget: 1n, repeatBudget: 0n }),
                'budget',
                1n,
                1n,
                0n,
                0n,
                changed(before, 0x1000n + BigInt(code.length / 2)),
              );
              xmm(cpu, expected);
            });
          }
      },
    },
  ];
}
