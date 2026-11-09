import {
  using,
  profiles,
  snapshot,
  initial,
  bytes,
  hex,
  flagPrefix,
  equal,
  same,
  outcome,
  debug,
  preserveNumeric,
  type Scenario,
} from './fixture.js';

export function transferScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'system PUSHF exact images and POPF source widths across all fourteen profiles',
      async run() {
        for (const execution of profiles()) {
          for (const width of execution.mode === 'long64' ? [2, 8] : [2, 4]) {
            for (const pop of [false, true]) {
              const code = flagPrefix(execution, width) + (pop ? '9d' : '9c');
              await using(
                compiler,
                code,
                execution,
                async (cpu) => {
                  const numeric = preserveNumeric(cpu);
                  const inputFlags = pop ? 0x193002n : 0x3d7ed7n;
                  const sp = execution.mode === 'long64' ? 0x6010n : 0x1122334400006010n;
                  const before = initial(0x1000n, { 4: sp }, inputFlags);
                  cpu.setState(before);
                  const result = await cpu.run({ budget: 1n, repeatBudget: 11n });
                  outcome(result, 'budget', 1n, 1n, 11n);
                  let flags = pop ? (width === 2 ? 0x1842d7n : 0x3c42d7n) : 0x3c7ed7n;
                  if (pop && execution.mode === 'virtual8086') flags |= 0x3000n;
                  equal(result.state.flags, flags, 'selected writable and preserved flags');
                  same(
                    result.state.registers,
                    before.registers.map((v, i) =>
                      i === 4 ? sp + BigInt(pop ? width : -width) : v,
                    ),
                    'whole scalar banks',
                  );
                  equal(result.state.rip, 0x1000n + BigInt(code.length / 2), 'encoding next-PC');
                  same(cpu.readContext(), execution, 'flags do not load context');
                  const expected = hex('a5'.repeat(64));
                  expected.set(hex(bytes(pop ? 0x2442d7n : flags, width)), pop ? 32 : 32 - width);
                  same(cpu.readMemory(0x5ff0n, 64), expected, 'exact slot and guards');
                  numeric();
                },
                {
                  data: [
                    {
                      base: 0x5ff0n,
                      bytes:
                        'a5'.repeat(32) +
                        (pop ? bytes(0x2442d7n, width) : 'a5'.repeat(width)) +
                        'a5'.repeat(32 - width),
                    },
                  ],
                },
              );
            }
          }
        }
      },
    },
    {
      name: 'system FLAGS effective REX width REP prefixes and all-bits PUSHF trap literals',
      async run() {
        for (const [prefix, width] of [
          ['', 8],
          ['66', 2],
          ['48', 8],
          ['6648', 8],
          ['4866', 2],
          ['f2', 8],
          ['f3', 8],
          ['67', 8],
        ] as const) {
          await using(
            compiler,
            prefix + '9c',
            snapshot(),
            async (cpu) => {
              const numeric = preserveNumeric(cpu);
              cpu.setState(initial(0x1000n, { 4: 0x4010n }, 0x3d7fd7n));
              const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
              outcome(result, 'debug-exception', 1n, 1n, 0n);
              debug(result, 0x1000n, 0x1001n + BigInt(prefix.length / 2), true, 0x3c7fd7n);
              equal(result.state.flags, 0x3c7fd7n, 'RF clears and other bits survive');
              equal(result.state.registers[4], 0x4010n - BigInt(width), 'literal frame width');
              same(
                cpu.readMemory(0x4010n - BigInt(width), width),
                hex(width === 2 ? 'd77f' : 'd77f3c0000000000'),
                'independent image literal',
              );
              numeric();
            },
            { data: [{ base: 0x4000n, bytes: 'a5'.repeat(32) }] },
          );
        }
      },
    },
  ];
}
