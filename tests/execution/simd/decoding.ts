import { equal, fault, memory } from '../../support/fixture.js';
import { LONG, banks, changed, input, outcome, using, xmm, type Scenario } from './fixture.js';

export function decodingScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'SIMD known invalid classes and unsupported selectors stop before operand access or unrelated tails',
      async run() {
        for (const [code, reason] of [
          ['660fc504', 'invalid-encoding'],
          ['660fd704', 'invalid-encoding'],
          ['0f5004', 'invalid-encoding'],
          ['660f7134', 'invalid-encoding'],
          ['f0660f708424000000001b', 'invalid-encoding'],
          ['66f30ffc', 'unsupported'],
          ['f3660ffc', 'unsupported'],
          ['f20f6f', 'unsupported'],
          ['660f730c', 'unsupported'],
          ['660f38', 'unsupported'],
          ['f0f3', 'unsupported'],
          ['f0f0', 'unsupported'],
        ] as const)
          for (const budget of [1n, 2n])
            await using(compiler, code, LONG, async (cpu) => {
              const before = input(0x1000n, { 0: 0x800000000000n, 4: 0x800000000000n }, 0xcd7n);
              const raw = banks();
              cpu.setState(before);
              cpu.setXmmState(raw);
              const result = await cpu.run({ budget, repeatBudget: 0n });
              outcome(result, reason, budget, 0n, 0n, 0n, before);
              equal(result.alignmentFault, undefined, 'decode rejection precedes vector alignment');
              equal(result.resources.compilations, 0, 'rejected instruction is not compiled');
              xmm(cpu, raw);
              memory(cpu, 0x1000n, code);
            });
      },
    },
    {
      name: 'SIMD required prefix opcode SIB displacement and immediate bytes precede source access and LOCK rejection',
      async run() {
        for (const full of [
          'f30f1000',
          '660f708424000000001b',
          '660fc4842400000000ff',
          'f0660f708424000000001b',
        ])
          for (let length = 1; length < full.length / 2; length++)
            for (const budget of [1n, 2n]) {
              const code = full.slice(0, length * 2);
              await using(
                compiler,
                code,
                LONG,
                async (cpu) => {
                  const before = input(0x1000n, { 0: 0x6000n, 4: 0x6000n }, 0xcd7n);
                  const raw = banks();
                  cpu.setState(before);
                  cpu.setXmmState(raw);
                  const result = await cpu.run({ budget, repeatBudget: 0n });
                  outcome(result, 'fetch-fault', budget, 0n, 0n, 0n, before);
                  fault(result, {
                    instructionPc: 0x1000n,
                    address: 0x1000n + BigInt(length),
                    failingAddress: 0x1000n + BigInt(length),
                    width: 1,
                    access: 'execute',
                    cause: 'unmapped',
                    segment: 'cs',
                  });
                  equal(
                    result.alignmentFault,
                    undefined,
                    'incomplete instruction has no alignment outcome',
                  );
                  equal(result.resources.compilations, 0, 'incomplete instruction is not compiled');
                  xmm(cpu, raw);
                  memory(cpu, 0x1000n, code);
                  memory(cpu, 0x6000n, 'a5'.repeat(16));
                },
                { data: [{ base: 0x6000n, bytes: 'a5'.repeat(16) }] },
              );
            }
      },
    },
    {
      name: 'SIMD accepts exactly fifteen bytes and rejects an attempted sixteenth before fetching it',
      async run() {
        const exact = '66'.repeat(12) + '0fefc0';
        await using(compiler, exact, LONG, async (cpu) => {
          const before = input(0x1000n, {}, 0xcd7n);
          const raw = banks();
          const expected = raw.slice();
          expected[0] = 0n;
          cpu.setState(before);
          cpu.setXmmState(raw);
          outcome(
            await cpu.run({ budget: 1n, repeatBudget: 0n }),
            'budget',
            1n,
            1n,
            0n,
            0n,
            changed(before, 0x100fn),
          );
          xmm(cpu, expected);
        });
        for (const tail of ['', 'c0'])
          for (const budget of [1n, 2n])
            await using(compiler, '66'.repeat(13) + '0fef' + tail, LONG, async (cpu) => {
              const before = input(0x1000n, {}, 0xcd7n);
              const raw = banks();
              cpu.setState(before);
              cpu.setXmmState(raw);
              const result = await cpu.run({ budget, repeatBudget: 0n });
              outcome(result, 'invalid-encoding', budget, 0n, 0n, 0n, before);
              equal(result.alignmentFault, undefined, 'length rejection has no alignment outcome');
              equal(result.resources.compilations, 0, 'overlong instruction is not compiled');
              xmm(cpu, raw);
            });
      },
    },
    {
      name: 'SIMD mandatory selector precedence retains physical REX cancellation',
      async run() {
        for (const [code, source, narrow] of [
          ['66f30f6fc1', 1, false],
          ['f3660f6fc1', 1, false],
          ['f341660f7ec0', 0, true],
          ['f366410f7ec0', 8, true],
        ] as const)
          await using(compiler, code, LONG, async (cpu) => {
            const before = input(0x1000n, {}, 0xcd7n);
            const raw = banks();
            const expected = raw.slice();
            expected[0] = raw[source]! & (narrow ? (1n << 64n) - 1n : (1n << 128n) - 1n);
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
