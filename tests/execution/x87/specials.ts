import {
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
  pop,
  environment,
  seed,
  other,
  x87,
  noFault,
  using,
  integer,
  memory,
  equal,
  pending,
  type Scenario,
} from './fixture.js';

export function specialScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'x87 remainder exponent and BCD forms execute through every loaded mode and stack profile',
      async run() {
        for (const [index, profile] of profiles.entries()) {
          const execution =
            profile.mode === 'long64'
              ? LONG
              : context(profile.mode, profile.code32, profile.stack32);
          const top = index & 7;
          for (const kind of [
            'remainder',
            'nearest',
            'scale',
            'extract',
            'load',
            'store',
          ] as const) {
            const values =
              kind === 'load'
                ? {}
                : kind === 'extract'
                  ? { 0: integer(12n) }
                  : kind === 'store'
                    ? { 0: 0x4000a000000000000000n }
                    : kind === 'scale'
                      ? { 0: 0x3fffc000000000000000n, 1: 0xbfffe000000000000000n }
                      : { 0: integer(7n), 1: integer(2n) };
            const state = stack(values, top),
              expected = clone(state);
            const address16 = profile.mode !== 'long64' && !profile.code32;
            const code =
              kind === 'remainder'
                ? 'd9f8'
                : kind === 'nearest'
                  ? 'd9f5'
                  : kind === 'scale'
                    ? 'd9fd'
                    : kind === 'extract'
                      ? 'd9f4'
                      : kind === 'load'
                        ? `df${address16 ? '27' : '23'}`
                        : `df${address16 ? '37' : '33'}`;
            if (kind === 'remainder' || kind === 'nearest') {
              slot(expected, top, integer(kind === 'remainder' ? 1n : -1n));
              expected.statusWord |= kind === 'remainder' ? 0x4200 : 0x100;
            } else if (kind === 'scale') slot(expected, top, 0x3ffec000000000000000n);
            else if (kind === 'extract') {
              slot(expected, top, integer(3n));
              slot(expected, (top + 7) & 7, 0x3fffc000000000000000n);
              expected.statusWord = ((top + 7) & 7) << 11;
            } else if (kind === 'load') {
              slot(expected, (top + 7) & 7, integer(-42n));
              expected.statusWord = ((top + 7) & 7) << 11;
            } else {
              pop(expected);
              expected.statusWord |= 0x20;
            }
            const data = kind === 'load' ? '42000000000000000080' : 'a5'.repeat(10);
            await using(
              compiler,
              code,
              execution,
              async (cpu) => {
                const before = input(0x1000n, { 3: 0x6000n });
                cpu.setState(before);
                seed(cpu, state);
                const result = await cpu.run({ budget: 1n });
                outcome(result, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1002n));
                x87(
                  cpu,
                  environment(
                    expected,
                    0x1000n,
                    kind === 'load' || kind === 'store' ? 0x6000n : undefined,
                  ),
                  NUMERIC_STATUS,
                );
                other(cpu);
                noFault(result);
                if (kind === 'store') memory(cpu, 0x6000n, '02000000000000000000');
              },
              { data: [{ base: 0x6000n, bytes: data }] },
            );
          }
        }
      },
    },
    {
      name: 'x87 remainder partial instructions checkpoint exact raw80 state and complete without hidden iterations',
      async run() {
        for (const code of ['d9f8d9f8', 'd9f5d9f5']) {
          await using(compiler, code, LONG, async (cpu) => {
            const before = input(),
              state = stack({ 0: 0x403f8000000000000002n, 1: 0x3fffc000000000000000n });
            cpu.setState(before);
            seed(cpu, state);
            let expected = clone(state);
            slot(expected, 0, 0x401f8000000200000000n);
            expected.statusWord = 0x400;
            const first = await cpu.run({ budget: 1n });
            outcome(first, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1002n));
            x87(cpu, environment(expected));
            const checkpoint = cpu.readX87State();
            cpu.setX87State(checkpoint);
            slot(expected, 0, 0x3ffe8000000000000000n);
            expected.statusWord = 0x300;
            const second = await cpu.run({ budget: 1n });
            outcome(second, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1004n));
            x87(cpu, environment(expected, 0x1002n));
            other(cpu);
          });
        }
      },
    },
    {
      name: 'x87 BCD unmasked precision commits bytes and pop before a later waited exception',
      async run() {
        await using(
          compiler,
          'df33909b',
          LONG,
          async (cpu) => {
            const before = input(0x1000n, { 3: 0x6000n }),
              state = stack({ 0: 0x3fffc000000000000000n }, 0, 0x35f),
              expected = clone(state);
            pop(expected);
            expected.statusWord = 0x8aa0;
            cpu.setState(before);
            seed(cpu, state);
            const first = await cpu.run({ budget: 1n });
            outcome(first, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1002n));
            const produced = environment(expected, 0x1000n, 0x6000n, 0x733);
            x87(cpu, produced);
            cpu.setMappings([
              {
                base: 0x1000n,
                backing: 'code',
                offset: 0,
                length: 4,
                permissions: { read: true, write: false, execute: true },
              },
              {
                base: 0x6000n,
                backing: 'data0',
                offset: 0,
                length: 10,
                permissions: { read: true, write: true, execute: false },
              },
            ]);
            memory(cpu, 0x6000n, '02000000000000000000');
            const fault = await cpu.run({ budget: 2n });
            equal(fault.reason, 'x87-exception', 'deferred precision reason');
            equal(fault.retired, 1n, 'NOP retires before WAIT');
            equal(fault.state.rip, 0x1003n, 'WAIT is its own boundary');
            pending(fault, produced, 0x1003n);
            x87(cpu, produced);
            other(cpu);
          },
          { data: [{ base: 0x6000n, bytes: 'a5'.repeat(10), read: false }] },
        );
      },
    },
  ];
}
