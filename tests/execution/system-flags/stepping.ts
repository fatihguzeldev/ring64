import {
  using,
  snapshot,
  initial,
  outcome,
  debug,
  same,
  equal,
  bytes,
  hex,
  CODE32,
  CODE64,
  preserveNumeric,
  type Scenario,
} from './fixture.js';
import { loadedCode } from '../far-control/fixture.js';

export function steppingScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'system POPF samples incoming TF and traps before exhausted budget or stop',
      async run() {
        for (const incoming of [false, true])
          for (const budget of [1n, 2n])
            for (const stop of [false, true]) {
              await using(
                compiler,
                '9d90',
                snapshot(),
                async (cpu) => {
                  const numeric = preserveNumeric(cpu);
                  cpu.setState(initial(0x1000n, { 4: 0x6000n }, incoming ? 0x102n : 2n));
                  const pop = await cpu.run({
                    budget,
                    repeatBudget: 7n,
                    ...(stop ? { stop: incoming || budget === 1n ? 0x1001n : 0x1002n } : {}),
                  });
                  outcome(
                    pop,
                    incoming || budget === 2n ? 'debug-exception' : 'budget',
                    budget,
                    incoming || budget === 1n ? 1n : 2n,
                    7n,
                  );
                  equal(pop.state.flags, incoming ? 2n : 0x302n, 'popped flags');
                  equal(pop.state.registers[4], 0x6008n, 'one flags pop');
                  if (incoming) debug(pop, 0x1000n, 0x1001n, true, 2n);
                  else if (budget === 2n) debug(pop, 0x1001n, 0x1002n, true, 0x302n);
                  else {
                    equal(pop.debugException, undefined, 'POPF does not step newly set TF');
                    const nop = await cpu.run({ budget: 1n, repeatBudget: 7n, stop: 0x1002n });
                    outcome(nop, 'debug-exception', 1n, 1n, 7n);
                    debug(nop, 0x1001n, 0x1002n, true, 0x302n);
                  }
                  const gated = await cpu.run({ budget: 0n });
                  equal(gated.debugException, undefined, 'trap not redelivered at gate');
                  numeric();
                },
                {
                  data: [{ base: 0x6000n, bytes: bytes(incoming ? 2n : 0x302n, 8), write: false }],
                },
              );
            }
      },
    },
    {
      name: 'system single-step branches near frames and far handoff expose prepared continuations',
      async run() {
        for (const kind of [
          'direct',
          'indirect',
          'call',
          'return',
          'far-jump',
          'far-call',
          'far-compat',
          'far-long',
          'outer',
        ] as const) {
          const execution = snapshot(kind === 'far-long' ? 'compatibility' : 'long64');
          if (kind.startsWith('far')) execution.segments.cs.selector = 0x18;
          const code = {
            direct: 'e9fb1f0000',
            indirect: 'ffe0',
            call: 'e8fb1f0000',
            return: 'c3',
            'far-jump': '48ff2b',
            'far-call': '48ff1b',
            'far-compat': '48ff2b',
            'far-long': 'ff2b',
            outer: '48cb',
          }[kind];
          const descriptor = kind === 'far-compat' ? CODE32 : CODE64;
          const data = [
            {
              base: 0x4008n,
              bytes: kind === 'outer' ? 'ffff000000fbaf00ffff000000f3cf00' : descriptor,
            },
            {
              base: 0x6000n,
              bytes:
                bytes(0x3000n, kind === 'far-long' ? 4 : 8) +
                (kind === 'outer'
                  ? bytes(0x0bn, 8) + bytes(0x7000n, 8) + bytes(0x13n, 8)
                  : '0800' + 'a5'.repeat(22)),
            },
            { base: 0x7000n, bytes: 'a5'.repeat(32) },
          ];
          await using(
            compiler,
            code,
            execution,
            async (cpu) => {
              const numeric = preserveNumeric(cpu);
              const sp = kind === 'return' || kind === 'outer' ? 0x6000n : 0x7020n;
              const before = initial(0x1000n, { 0: 0x3000n, 3: 0x6000n, 4: sp }, 0x302n);
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n, repeatBudget: 13n, stop: 0x3000n });
              outcome(result, 'debug-exception', 1n, 1n, 13n);
              debug(result, 0x1000n, 0x3000n, true, 0x302n);
              const finalSp =
                kind === 'call'
                  ? 0x7018n
                  : kind === 'far-call'
                    ? 0x7010n
                    : kind === 'return'
                      ? 0x6008n
                      : kind === 'outer'
                        ? 0x7000n
                        : sp;
              same(
                result.state.registers,
                before.registers.map((v, i) => (i === 4 ? finalSp : v)),
                'full prepared raw pointer',
              );
              if (kind === 'call')
                same(
                  cpu.readMemory(0x7018n, 8),
                  new Uint8Array([5, 16, 0, 0, 0, 0, 0, 0]),
                  'near frame',
                );
              if (kind === 'far-call')
                same(
                  cpu.readMemory(0x7010n, 16),
                  new Uint8Array([3, 16, 0, 0, 0, 0, 0, 0, 24, 0, 0, 0, 0, 0, 0, 0]),
                  'far captured source frame',
                );
              if (kind.startsWith('far'))
                equal(cpu.readContext().segments.cs.selector, 8, 'new code descriptor');
              if (kind === 'far-compat' || kind === 'far-long') {
                same(
                  cpu.readContext(),
                  {
                    ...execution,
                    mode: kind === 'far-long' ? 'long64' : 'compatibility',
                    segments: {
                      ...execution.segments,
                      cs: loadedCode(kind === 'far-long' ? 64 : 32),
                    },
                  },
                  'complete submode context precedes trap',
                );
                same(cpu.readMemory(0x4008n, 8), hex(descriptor), 'descriptor unchanged');
                same(
                  cpu.readMemory(0x6000n, data[1]!.bytes.length / 2),
                  hex(data[1]!.bytes),
                  'captured source and guards unchanged',
                );
              }
              if (kind === 'outer') {
                equal(cpu.readContext().cpl, 3, 'outer CPL published');
                equal(cpu.readContext().segments.ss.selector, 0x13, 'outer SS published');
              }
              const faulted = await cpu.run({ budget: 1n });
              outcome(faulted, 'fetch-fault', 1n, 0n);
              equal(faulted.fault?.instructionPc, 0x3000n, 'later target fetch');
              equal(faulted.debugException, undefined, 'no trap for failed fetch');
              if (kind === 'far-compat' || kind === 'far-long')
                same(
                  faulted.state,
                  result.state,
                  'new submode fetch failure preserves trap continuation',
                );
              numeric();
            },
            { data },
          );
        }
      },
    },
    {
      name: 'system cached middle entries use fresh TF without replaying predecessor flags or stack',
      async run() {
        await using(
          compiler,
          '31c09d90',
          snapshot(),
          async (cpu) => {
            const numeric = preserveNumeric(cpu);
            cpu.setState(initial(0x1000n, { 4: 0x6000n }));
            outcome(await cpu.run({ budget: 3n }), 'budget', 3n, 3n);
            const before = initial(0x1003n, { 0: 0x123456789abcdef0n, 4: 0x6000n }, 0x102n);
            cpu.setState(before);
            const result = await cpu.run({ budget: 2n, repeatBudget: 0n });
            outcome(result, 'debug-exception', 2n, 1n, 0n);
            debug(result, 0x1003n, 0x1004n, true, 0x102n);
            same(result.state.registers, before.registers, 'skipped XOR and POPF not replayed');
            numeric();
          },
          { data: [{ base: 0x6000n, bytes: bytes(2n, 8) }] },
        );
      },
    },
  ];
}
