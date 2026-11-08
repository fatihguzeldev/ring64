import {
  ONE,
  NUMERIC_STATUS,
  LONG,
  profiles,
  context,
  input,
  changed,
  outcome,
  stack,
  slot,
  clone,
  environment,
  seed,
  other,
  x87,
  noFault,
  using,
  type Scenario,
} from './fixture.js';

export function modeScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'x87 raw80 loads use all fourteen mode profiles address overrides and distinct logical or linear metadata',
      async run() {
        for (const [index, profile] of profiles.entries())
          for (const override of [false, true]) {
            const execution =
              profile.mode === 'long64'
                ? { ...LONG, fsBase: 0x10000n }
                : context(profile.mode, profile.code32, profile.stack32);
            if (execution.mode !== 'long64') {
              execution.segments.cs.base = 0x20000n;
              execution.segments.ds.base = 0x10000n;
            }
            const width16 = profile.mode !== 'long64' && profile.code32 === override;
            const code = `${profile.mode === 'long64' ? '64' : ''}f366${override ? '67' : ''}db${width16 ? '2f' : '2b'}`;
            const pc =
              profile.mode === 'protected' || profile.mode === 'compatibility' ? 0x10003n : 0x1000n;
            const codeBase = execution.mode === 'long64' ? pc : execution.segments.cs.base + pc;
            await using(
              compiler,
              code,
              execution,
              async (cpu) => {
                const before = input(pc, { 3: 0x6000n }, 0xcd7n),
                  state = stack({}, index & 7, 0x37f, 0x200),
                  expected = clone(state);
                const top = ((index & 7) + 7) & 7;
                slot(expected, top, ONE);
                expected.statusWord = top << 11;
                const real = execution.mode === 'real' || execution.mode === 'virtual8086';
                cpu.setState(before);
                seed(cpu, state);
                const result = await cpu.run({ budget: 1n, repeatBudget: 3n });
                outcome(
                  result,
                  'budget',
                  1n,
                  1n,
                  3n,
                  0n,
                  changed(before, pc + BigInt(code.length / 2)),
                );
                x87(
                  cpu,
                  environment(expected, real ? codeBase : pc, real ? 0x16000n : 0x6000n),
                  NUMERIC_STATUS,
                );
                other(cpu);
                noFault(result);
              },
              { codeBase, entry: pc, data: [{ base: 0x16000n, bytes: '0000000000000080ff3f' }] },
            );
          }
      },
    },
    {
      name: 'x87 legacy metadata preserves full EIP and uses wrapping linear real addresses without A20 truncation',
      async run() {
        const execution = context('real', false, false);
        execution.segments.cs.base = 0xffff0000n;
        execution.segments.ds.base = 0xffff0n;
        await using(
          compiler,
          'db2f',
          execution,
          async (cpu) => {
            const before = input(0xfff0n, { 3: 0xfff0n }, 0xcd7n),
              state = stack(),
              expected = clone(state);
            slot(expected, 7, ONE);
            expected.statusWord = 0x3800;
            cpu.setState(before);
            seed(cpu, state);
            const result = await cpu.run({ budget: 1n });
            outcome(result, 'budget', 1n, 1n, 1n, 0n, changed(before, 0xfff2n));
            x87(cpu, environment(expected, 0xfffffff0n, 0x10ffe0n), NUMERIC_STATUS);
            other(cpu);
            noFault(result);
          },
          {
            entry: 0xfff0n,
            codeBase: 0xfffffff0n,
            data: [{ base: 0x10ffe0n, bytes: '0000000000000080ff3f' }],
          },
        );
      },
    },
  ];
}
