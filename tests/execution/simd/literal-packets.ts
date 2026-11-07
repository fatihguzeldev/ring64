import {
  LONG,
  MASK128,
  banks,
  changed,
  input,
  outcome,
  using,
  vector,
  xmm,
  type Scenario,
} from './fixture.js';
export function literalScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'SIMD literal packets distinguish signed narrowing rounded averages products and raw source order',
      async run() {
        const rows: [string, bigint, bigint, bigint][] = [
          ['660ff1c1', vector([1n, 2n, 4n, 8n, 16n, 32n, 64n, 128n], 16), 0x100000000n, 0n],
          ['660ff1c1', 0x123456789abcdefn, 0xffffffffffffffff0000000000000000n, 0x123456789abcdefn],
          [
            '660fe1c1',
            vector([0x8000n, 0x7fffn, 0xffffn, 1n, 0n, 0xc000n, 0x4000n, 0x8001n], 16),
            16n,
            vector([0xffffn, 0n, 0xffffn, 0n, 0n, 0xffffn, 0n, 0xffffn], 16),
          ],
          [
            '660ff5c1',
            vector(Array(8).fill(0x8000n), 16),
            vector(Array(8).fill(0x8000n), 16),
            vector(Array(4).fill(0x80000000n), 32),
          ],
          [
            '660ff4c1',
            vector([0xffffffffn, 0xaaaaaaaan, 0x80000000n, 0xbbbbbbbbn], 32),
            vector([0xffffffffn, 0xccccccccn, 2n, 0xddddddddn], 32),
            vector([0xfffffffe00000001n, 0x100000000n], 64),
          ],
          [
            '660ff6c1',
            0xffffffffffffffff0000000000000000n,
            0xffffffffffffffffn,
            vector([0x7f8n, 0x7f8n], 64),
          ],
          [
            '660f67c1',
            vector([-1n, 0n, 0x7fn, 0x80n, 0xffn, 0x100n, 0x7fffn, -0x8000n], 16),
            vector([1n, -2n, 0xfen, 0x12cn, 0x7ffen, -0x7fffn, 0x2an, 0x3e8n], 16),
            vector(
              [
                0n,
                0n,
                0x7fn,
                0x80n,
                0xffn,
                0xffn,
                0xffn,
                0n,
                1n,
                0n,
                0xfen,
                0xffn,
                0xffn,
                0n,
                0x2an,
                0xffn,
              ],
              8,
            ),
          ],
          [
            '660fdfc1',
            0x0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0fn,
            0x33333333333333333333333333333333n,
            0x30303030303030303030303030303030n,
          ],
          ['660fe3c1', MASK128, 0n, vector(Array(8).fill(0x8000n), 16)],
          ['660fe3c1', MASK128, MASK128, MASK128],
          [
            '660f70c11b',
            MASK128,
            vector([0x11n, 0x22n, 0x33n, 0x44n], 32),
            vector([0x44n, 0x33n, 0x22n, 0x11n], 32),
          ],
          [
            'f30f70c11b',
            MASK128,
            vector([0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n], 16),
            vector([0n, 1n, 2n, 3n, 7n, 6n, 5n, 4n], 16),
          ],
          [
            'f20f70c11b',
            MASK128,
            vector([0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n], 16),
            vector([3n, 2n, 1n, 0n, 4n, 5n, 6n, 7n], 16),
          ],
        ];
        for (const [code, a, b, want] of rows)
          await using(compiler, code, LONG, async (cpu) => {
            const raw = banks(),
              before = input(0x1000n, {}, 0xcd7n);
            raw[0] = a;
            raw[1] = b;
            const expected = raw.slice();
            expected[0] = want;
            cpu.setState(before);
            cpu.setXmmState(raw);
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
      },
    },
  ];
}
