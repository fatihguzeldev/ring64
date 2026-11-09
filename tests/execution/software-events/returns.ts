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
  loadedCode,
  loadedData,
  CODE16,
  CODE32,
  CODE64,
  DATA32,
  preserveNumeric,
  type Scenario,
} from './fixture.js';

export function returnScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'software IRET frame arity follows source submode and restored raw SP follows the popped width',
      async run() {
        for (const source of ['long64', 'compatibility'] as const)
          for (const width of source === 'long64' ? [16, 32, 64] : [16, 32])
            for (const target of [16, 32, 64] as const)
              for (const cpl of [0, 3]) {
                const execution = snapshot(source, 0, true, false);
                execution.segments.ss = loadedData(16);
                const extra = source === 'long64' || cpl === 3;
                const restored =
                  width === 16 ? 0xbeefn : width === 32 ? 0xabcd0010n : 0x12345678abcd0010n;
                const values = [0x3000n, 0x12340000n | BigInt(0x18 | cpl), 2n];
                if (extra) values.push(restored, 0xa5a50000n | BigInt(0x20 | cpl));
                const frame = image(values, width / 8);
                const targetCode = target === 16 ? CODE16 : target === 32 ? CODE32 : CODE64;
                const descriptor =
                  targetCode.slice(0, 10) + (cpl ? 'fb' : '9b') + targetCode.slice(12);
                const code = `${width === 64 ? '48' : width === 16 ? '66' : ''}cf`;
                await using(
                  compiler,
                  code,
                  execution,
                  async (cpu) => {
                    const numeric = preserveNumeric(cpu);
                    const oldSp = source === 'long64' ? 0x7000n : 0x11223344abcd7000n;
                    const before = initial(0x1000n, { 4: oldSp });
                    cpu.setState(before);
                    const result = await cpu.run({ budget: 1n, repeatBudget: 31n, stop: 0x3000n });
                    outcome(result, 'budget', 1n, 1n, 31n);
                    fullState(
                      result,
                      before,
                      0x3000n,
                      extra ? restored : oldSp + BigInt(frame.length),
                      2n,
                    );
                    const segments = {
                      ...execution.segments,
                      cs: loadedCode(target, 0x18 | cpl, cpl),
                      ss: extra ? loadedData(16, 0x20 | cpl, cpl) : execution.segments.ss,
                    };
                    if (cpl === 3)
                      for (const name of ['ds', 'es', 'fs', 'gs'] as const)
                        segments[name] = { ...segments[name], selector: 0, usable: false };
                    same(
                      cpu.readContext(),
                      {
                        ...execution,
                        mode: target === 64 ? 'long64' : 'compatibility',
                        cpl,
                        segments,
                      },
                      'exact source-dependent return context',
                    );
                    same(
                      cpu.readMemory(0x7000n, frame.length),
                      frame,
                      'return source bytes unchanged',
                    );
                    const failed = await cpu.run({ budget: 1n });
                    outcome(failed, 'fetch-fault', 1n, 0n);
                    same(
                      failed.state,
                      result.state,
                      'unmapped target checked after completed return',
                    );
                    numeric();
                  },
                  {
                    data: [
                      {
                        base: 0x4018n,
                        bytes: descriptor + (cpl ? 'ffff000000f30000' : 'ffff000000930000'),
                        write: false,
                      },
                      { base: 0x7000n, bytes: encoded(frame), write: false },
                    ],
                  },
                );
              }
      },
    },
    {
      name: 'software IRET literal FLAGS outcomes use old CPL and IOPL while keeping VM outside scalar state',
      async run() {
        for (const packet of [
          { width: 32, cpl: 3, input: 0x180002n, frame: 0x3f7fd7n, result: 0x3d4dd7n },
          { width: 32, cpl: 3, input: 0x183002n, frame: 0x3f7fd7n, result: 0x3d7fd7n },
          { width: 16, cpl: 3, input: 0x3d0202n, frame: 0xffffn, result: 0x3c4fd7n },
          { width: 16, cpl: 0, input: 0x3d0202n, frame: 0xffffn, result: 0x3c7fd7n },
        ]) {
          const execution = snapshot('protected', packet.cpl);
          const frame = image([0x3000n, BigInt(0x18 | packet.cpl), packet.frame], packet.width / 8);
          await using(
            compiler,
            `${packet.width === 16 ? '66' : ''}cf`,
            execution,
            async (cpu) => {
              const numeric = preserveNumeric(cpu);
              const before = initial(0x1000n, { 4: 0x1122334400007000n }, packet.input);
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              outcome(result, 'budget', 1n, 1n);
              fullState(
                result,
                before,
                0x3000n,
                before.registers[4]! + BigInt(frame.length),
                packet.result,
              );
              equal(
                cpu.readContext().mode,
                'protected',
                'VM bit in a CPL3 frame does not change family',
              );
              equal(result.state.flags & 0x20000n, 0n, 'VM excluded from projection');
              numeric();
            },
            {
              data: [
                { base: 0x4018n, bytes: packet.cpl ? 'ffff000000fbcf00' : CODE32, write: false },
                { base: 0x7000n, bytes: encoded(frame), write: false },
              ],
            },
          );
        }
      },
    },
    {
      name: 'software completed IRET single-step preserves restored RF in live and saved trap flags until the next begin',
      async run() {
        for (const mode of ['protected', 'compatibility', 'long64'] as const) {
          const execution = snapshot(mode);
          const long = mode === 'long64';
          const values = [0x3000n, 0x18n, 0x10002n];
          if (long) values.push(0x7020n, 0x20n);
          const frame = image(values, long ? 8 : 4);
          await using(
            compiler,
            long ? '48cf' : 'cf',
            execution,
            async (cpu) => {
              const numeric = preserveNumeric(cpu);
              const before = initial(0x1000n, { 4: long ? 0x7000n : 0x1122334400007000n }, 0x102n);
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n, stop: 0x3000n });
              outcome(result, 'debug-exception', 1n, 1n);
              debug(result, 0x1000n, 0x3000n, true, 0x10002n);
              const finalSp = long ? 0x7020n : 0x112233440000700cn;
              const expected = {
                ...before,
                registers: before.registers.map((value, index) => (index === 4 ? finalSp : value)),
                rip: 0x3000n,
                flags: 0x10002n,
              };
              same(
                result.state,
                expected,
                'completed trap retains restored RF despite incoming TF',
              );
              same(
                cpu.readContext(),
                {
                  ...execution,
                  segments: {
                    ...execution.segments,
                    cs: loadedCode(long ? 64 : 32, 0x18),
                    ss: long ? loadedData(32, 0x20) : execution.segments.ss,
                  },
                },
                'prepared return context precedes trap',
              );
              const gated = await cpu.run({ budget: 0n });
              outcome(gated, 'budget', 0n, 0n);
              same(gated.state, expected, 'observation gate does not clear RF');
              equal(gated.debugException, undefined, 'trap diagnostic not replayed');
              const next = await cpu.run({ budget: 1n });
              outcome(next, 'budget', 1n, 1n);
              fullState(next, { ...expected, flags: 2n }, 0x3001n, finalSp, 2n);
              same(
                cpu.readMemory(0x7000n, frame.length),
                frame,
                'return and resumed instruction do not rewrite frame',
              );
              numeric();
            },
            {
              data: [
                { base: 0x4018n, bytes: (long ? CODE64 : CODE32) + DATA32, write: false },
                { base: 0x7000n, bytes: encoded(frame), write: false },
                { base: 0x3000n, bytes: '90', execute: true },
              ],
            },
          );
        }
      },
    },
  ];
}
