import { equal, fault, memory } from '../../support/fixture.js';
import {
  LONG,
  banks,
  changed,
  input,
  mxcsr,
  noFault,
  outcome,
  using,
  xmm,
  type Scenario,
} from './fixture.js';

const controls = 0x2000;
function rawBanks() {
  const raw = banks();
  raw[0] = (raw[0]! & ~0xffffffffn) | 0x7f800011n;
  raw[1] = (raw[1]! & ~0xffffffffn) | 0x7f800022n;
  return raw;
}

export function decodeScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'floating known illegal classes and unsupported selectors reject before source or numeric effects',
      async run() {
        for (const [code, reason] of [
          ['0faed0', 'invalid-encoding'],
          ['0faed8', 'invalid-encoding'],
          ['660f12c1', 'invalid-encoding'],
          ['660f16c1', 'invalid-encoding'],
          ['0f13c4', 'invalid-encoding'],
          ['0f17c4', 'invalid-encoding'],
          ['660f13c4', 'invalid-encoding'],
          ['660f17c4', 'invalid-encoding'],
          ['f00f5800', 'invalid-encoding'],
          ['f0660f5800', 'invalid-encoding'],
          ['f00fc2842400000000ff', 'invalid-encoding'],
          ['0fae24', 'unsupported'],
          ['0faef0', 'unsupported'],
          ['660fae', 'unsupported'],
          ['f20fae', 'unsupported'],
          ['f30fae', 'unsupported'],
          ['660f53', 'unsupported'],
          ['f20f52', 'unsupported'],
          ['f30f2e', 'unsupported'],
          ['f20f2f', 'unsupported'],
          ['f20f2e', 'unsupported'],
          ['f20f53', 'unsupported'],
          ['f20f5b', 'unsupported'],
          ['f2660f5b', 'unsupported'],
          ['f0f30f58', 'unsupported'],
          ['f0f20f58', 'unsupported'],
        ] as const)
          for (const budget of [1n, 2n])
            await using(compiler, code, LONG, async (cpu) => {
              const raw = rawBanks(),
                before = input(0x1000n, { 0: 0x800000000000n, 4: 0x800000000000n }, 0xcd7n);
              cpu.setState(before);
              cpu.setXmmState(raw);
              cpu.setMxcsr(controls);
              const result = await cpu.run({ budget, repeatBudget: 7n });
              outcome(result, reason, budget, 0n, 7n, 0n, before);
              noFault(result);
              xmm(cpu, raw);
              mxcsr(cpu, controls);
              memory(cpu, 0x1000n, code);
              equal(result.resources.compilations, 0, 'rejected entry owns no generated artifact');
            });
      },
    },
    {
      name: 'floating required encoding bytes precede inaccessible operands LOCK rejection and MXCSR updates',
      async run() {
        for (const full of [
          '0fc2842400000000ff',
          'f3480f2a842400000000',
          'f2480f2c842400000000',
          'f00fc2842400000000ff',
          '660f16842400000000',
          '0fae942400000000',
        ])
          for (let length = 1; length < full.length / 2; length++)
            for (const budget of [1n, 2n]) {
              const code = full.slice(0, length * 2);
              await using(
                compiler,
                code,
                LONG,
                async (cpu) => {
                  const raw = rawBanks(),
                    before = input(0x1000n, { 0: 0x7000n, 4: 0x7000n }, 0xcd7n);
                  cpu.setState(before);
                  cpu.setXmmState(raw);
                  cpu.setMxcsr(controls);
                  const result = await cpu.run({ budget, repeatBudget: 7n });
                  outcome(result, 'fetch-fault', budget, 0n, 7n, 0n, before);
                  fault(result, {
                    instructionPc: 0x1000n,
                    address: 0x1000n + BigInt(length),
                    failingAddress: 0x1000n + BigInt(length),
                    width: 1,
                    access: 'execute',
                    cause: 'unmapped',
                    segment: 'cs',
                  });
                  for (const key of [
                    'segmentFault',
                    'alignmentFault',
                    'simdException',
                    'generalProtectionFault',
                  ] as const)
                    equal(result[key], undefined, `incomplete encoding has no ${key}`);
                  xmm(cpu, raw);
                  mxcsr(cpu, controls);
                  memory(cpu, 0x1000n, code);
                  memory(cpu, 0x6000n, 'a5'.repeat(16));
                  equal(result.resources.compilations, 0, 'missing required tail is not compiled');
                },
                { data: [{ base: 0x6000n, bytes: 'a5'.repeat(16) }] },
              );
            }
      },
    },
    {
      name: 'floating accepts fifteen bytes and rejects a sixteenth ModRM or immediate before fetching it',
      async run() {
        const exact = '66'.repeat(12) + '0f58c1';
        await using(compiler, exact, LONG, async (cpu) => {
          const raw = banks(),
            before = input(0x1000n, {}, 0xcd7n);
          raw[0] = 0x40000000000000003ff0000000000000n;
          raw[1] = 0x40080000000000004000000000000000n;
          const expected = raw.slice();
          expected[0] = 0x40140000000000004008000000000000n;
          cpu.setState(before);
          cpu.setXmmState(raw);
          cpu.setMxcsr(0x1f80);
          const result = await cpu.run({ budget: 1n, repeatBudget: 7n });
          outcome(result, 'budget', 1n, 1n, 7n, 0n, changed(before, 0x100fn));
          noFault(result);
          xmm(cpu, expected);
          mxcsr(cpu, 0x1f80);
        });
        for (const code of [
          '66'.repeat(13) + '0f58',
          '66'.repeat(13) + '0f58c1',
          '66'.repeat(12) + '0fc2c1',
          '66'.repeat(12) + '0fc2c100',
        ])
          for (const budget of [1n, 2n])
            await using(compiler, code, LONG, async (cpu) => {
              const raw = rawBanks(),
                before = input(0x1000n, {}, 0xcd7n);
              cpu.setState(before);
              cpu.setXmmState(raw);
              cpu.setMxcsr(controls);
              const result = await cpu.run({ budget, repeatBudget: 7n });
              outcome(result, 'invalid-encoding', budget, 0n, 7n, 0n, before);
              noFault(result);
              xmm(cpu, raw);
              mxcsr(cpu, controls);
              equal(
                result.resources.compilations,
                0,
                'instruction length rejects before compilation',
              );
            });
      },
    },
    {
      name: 'floating mandatory selectors choose packed scalar and integer widths independently of REX cancellation',
      async run() {
        for (const [code, left, right, expected] of [
          [
            '0f58c1',
            0x3f8000003f8000003f8000003f800000n,
            0x40000000400000004000000040000000n,
            0x40400000404000004040000040400000n,
          ],
          [
            '660f58c1',
            0x40000000000000003ff0000000000000n,
            0x40080000000000004000000000000000n,
            0x40140000000000004008000000000000n,
          ],
          [
            'f30f58c1',
            0x112233445566778899aabbcc3f800000n,
            0xffffffffffffffffffffffff40000000n,
            0x112233445566778899aabbcc40400000n,
          ],
          [
            'f20f58c1',
            0x11223344556677883ff0000000000000n,
            0xffffffffffffffff4000000000000000n,
            0x11223344556677884008000000000000n,
          ],
          [
            'f3660f58c1',
            0x112233445566778899aabbcc3f800000n,
            0xffffffffffffffffffffffff40000000n,
            0x112233445566778899aabbcc40400000n,
          ],
          [
            '66f30f58c1',
            0x112233445566778899aabbcc3f800000n,
            0xffffffffffffffffffffffff40000000n,
            0x112233445566778899aabbcc40400000n,
          ],
          [
            'f2660f58c1',
            0x11223344556677883ff0000000000000n,
            0xffffffffffffffff4000000000000000n,
            0x11223344556677884008000000000000n,
          ],
        ] as const)
          await using(compiler, code, LONG, async (cpu) => {
            const raw = banks(),
              before = input(0x1000n, {}, 0xcd7n);
            raw[0] = left;
            raw[1] = right;
            const want = raw.slice();
            want[0] = expected;
            cpu.setState(before);
            cpu.setXmmState(raw);
            cpu.setMxcsr(0x1f80);
            const result = await cpu.run({ budget: 1n, repeatBudget: 7n });
            outcome(
              result,
              'budget',
              1n,
              1n,
              7n,
              0n,
              changed(before, 0x1000n + BigInt(code.length / 2)),
            );
            noFault(result);
            xmm(cpu, want);
            mxcsr(cpu, 0x1f80);
          });
        for (const [code, wide] of [
          ['f3480f2ac0', true],
          ['48f30f2ac0', false],
          ['f348660f2ac0', false],
          ['66f3480f2ac0', true],
        ] as const)
          await using(compiler, code, LONG, async (cpu) => {
            const raw = banks(),
              before = input(0x1000n, { 0: 0x100000001n }, 0xcd7n),
              want = raw.slice();
            want[0] = (raw[0]! & ~0xffffffffn) | (wide ? 0x4f800000n : 0x3f800000n);
            cpu.setState(before);
            cpu.setXmmState(raw);
            cpu.setMxcsr(0x1f80);
            const result = await cpu.run({ budget: 1n, repeatBudget: 7n });
            outcome(
              result,
              'budget',
              1n,
              1n,
              7n,
              0n,
              changed(before, 0x1000n + BigInt(code.length / 2)),
            );
            noFault(result);
            xmm(cpu, want);
            mxcsr(cpu, wide ? 0x1fa0 : 0x1f80);
          });
        for (const [code, dst] of [
          ['f3440f58c1', 8],
          ['f344660f58c1', 0],
          ['66f3440f58c1', 8],
        ] as const)
          await using(compiler, code, LONG, async (cpu) => {
            const raw = banks(),
              before = input(0x1000n, {}, 0xcd7n);
            raw[0] = (raw[0]! & ~0xffffffffn) | 0x3f800000n;
            raw[8] = (raw[8]! & ~0xffffffffn) | 0x3f800000n;
            raw[1] = (raw[1]! & ~0xffffffffn) | 0x40000000n;
            const want = raw.slice();
            want[dst] = (raw[dst]! & ~0xffffffffn) | 0x40400000n;
            cpu.setState(before);
            cpu.setXmmState(raw);
            cpu.setMxcsr(0x1f80);
            const result = await cpu.run({ budget: 1n, repeatBudget: 7n });
            outcome(
              result,
              'budget',
              1n,
              1n,
              7n,
              0n,
              changed(before, 0x1000n + BigInt(code.length / 2)),
            );
            noFault(result);
            xmm(cpu, want);
            mxcsr(cpu, 0x1f80);
          });
      },
    },
  ];
}
