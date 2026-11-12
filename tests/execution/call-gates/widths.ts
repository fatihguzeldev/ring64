import {
  usingGate,
  initial,
  complete,
  equal,
  scalar,
  preserveNumeric,
  bytes,
  put,
  OLD_SP,
  NEW_SP,
  SOURCE,
  TARGET,
  type Family,
  type Scenario,
} from './fixture.js';

export function widthScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'call gate legacy source target stack and TSS widths independently preserve literal maximum frames and matched returns',
      async run() {
        let profile = 0;
        for (const width of [16, 32] as const)
          for (const source32 of [false, true])
            for (const target32 of [false, true])
              for (const oldStack32 of [false, true])
                for (const newStack32 of [false, true])
                  for (const tss32 of [false, true]) {
                    const family = (['linear', 'pg0', 'legacy32', 'pae'] as const)[profile++ % 4]!;
                    for (const count of [0, 1, 31]) {
                      const w = width / 8;
                      const cleanup = count * w;
                      const targetCode =
                        (width === (target32 ? 32 : 16) ? '' : '66') +
                        'ca' +
                        bytes(BigInt(cleanup), 2);
                      await usingGate(
                        compiler,
                        {
                          family,
                          gateWidth: width,
                          source32,
                          targetWidth: target32 ? 32 : 16,
                          oldStack32,
                          newStack32,
                          tss32,
                          count,
                          targetCode,
                        },
                        async (cpu) => {
                          const numeric = preserveNumeric(cpu);
                          const before = initial(SOURCE, { 4: OLD_SP }, 0x402n);
                          cpu.setState(before);
                          const enter = await cpu.run({ budget: 1n, repeatBudget: 0n });
                          complete(enter);
                          equal(enter.state.rip, TARGET, 'gate offset overrides immediate zero');
                          const final = NEW_SP - BigInt((count + 4) * w);
                          equal(enter.state.registers[4], final, 'complete n+4-slot frame');
                          const expected = [
                            source32 ? 0x1007n : 0x1005n,
                            0x1bn,
                            ...Array.from({ length: count }, (_, i) => BigInt(0xa100 + i)),
                            OLD_SP,
                            0x23n,
                          ];
                          for (let i = 0; i < expected.length; i++)
                            equal(
                              scalar(cpu, final + BigInt(i * w), w, family),
                              expected[i],
                              `literal frame slot ${i}`,
                            );
                          equal(
                            cpu.readContext().segments.cs.default32,
                            target32,
                            'destination D independent of W',
                          );
                          equal(
                            cpu.readContext().segments.ss.default32,
                            newStack32,
                            'destination B independent of W',
                          );
                          const leave = await cpu.run({ budget: 1n, repeatBudget: 0n });
                          complete(leave);
                          equal(leave.state.rip, expected[0], 'source next PC');
                          equal(
                            leave.state.registers[4],
                            OLD_SP + BigInt(cleanup),
                            'same unsigned cleanup on restored outer stack',
                          );
                          equal(cpu.readContext().cpl, 3, 'outer CPL restored');
                          for (let i = 0; i < 16; i++)
                            if (i !== 4)
                              equal(
                                leave.state.registers[i],
                                before.registers[i],
                                `unmodified bank ${i}`,
                              );
                          equal(leave.state.flags, 0x402n, 'DF and flags remain unchanged');
                          numeric();
                        },
                      );
                    }
                  }
      },
    },
    {
      name: 'call gate old B16 captures complete unwrapped dwords and new B16 wraps individual slots while retaining raw high16',
      async run() {
        await usingGate(
          compiler,
          {
            gateWidth: 32,
            oldStack32: false,
            newStack32: false,
            count: 2,
            newSp: 0x12340008n,
            prepare(memory, context) {
              context.segments.ss.limit = 0x1ffff;
              put(memory, 0xfffe, 0x11223344n, 4);
              put(memory, 2, 0x55667788n, 4);
            },
          },
          async (cpu) => {
            cpu.setState(initial(SOURCE, { 4: 0x12345678abcdfffen }));
            const result = await cpu.run({ budget: 1n });
            complete(result);
            equal(
              result.state.registers[4],
              0x1234fff0n,
              'TSS raw bank is zero extended then low16 steps wrap',
            );
            for (const [at, expected] of [
              [0xfff0n, 0x1007n],
              [0xfff4n, 0x1bn],
              [0xfff8n, 0x11223344n],
              [0xfffcn, 0x55667788n],
              [0n, 0xabcdfffen],
              [4n, 0x23n],
            ] as const)
              equal(scalar(cpu, at, 4), expected, 'independently wrapped complete slot');
          },
        );
      },
    },
    {
      name: 'call gate every legacy parameter count retires atomically with no REP allowance',
      async run() {
        for (const width of [16, 32] as const)
          for (let count = 0; count < 32; count++) {
            const family: Family = count & 1 ? 'legacy32' : 'linear';
            const w = width / 8;
            await usingGate(compiler, { family, gateWidth: width, count }, async (cpu) => {
              cpu.setState(initial(SOURCE, { 4: OLD_SP }));
              const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
              complete(result);
              const final = NEW_SP - BigInt((count + 4) * w);
              equal(result.state.registers[4], final, 'exact count controls frame');
              for (let i = 0; i < count; i++)
                equal(
                  scalar(cpu, final + BigInt((i + 2) * w), w, family),
                  BigInt(0xa100 + i),
                  `parameter ${i} of ${count}`,
                );
              equal(
                scalar(cpu, final + BigInt((count + 2) * w), w, family),
                OLD_SP,
                'old pointer follows every copied argument',
              );
              equal(
                scalar(cpu, final + BigInt((count + 3) * w), w, family),
                0x23n,
                'last selector slot remains present',
              );
            });
          }
      },
    },
  ];
}
