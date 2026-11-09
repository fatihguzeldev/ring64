import {
  using,
  snapshot,
  initial,
  bytes,
  flagPrefix,
  equal,
  same,
  outcome,
  preserveNumeric,
  type Scenario,
} from './fixture.js';

export function privilegeScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'system CLI STI old-CPL IOPL truth table and virtual8086 admission',
      async run() {
        for (const mode of ['real', 'virtual8086', 'protected', 'compatibility', 'long64'] as const)
          for (const cpl of mode === 'real' ? [0] : mode === 'virtual8086' ? [3] : [0, 1, 2, 3])
            for (const iopl of [0, 1, 2, 3])
              for (const enabled of [false, true])
                for (const set of [false, true]) {
                  const execution = snapshot(mode, cpl);
                  const flags = 0x394002n | BigInt(iopl << 12) | (enabled ? 0x200n : 0n);
                  await using(compiler, set ? 'fb' : 'fa', execution, async (cpu) => {
                    const numeric = preserveNumeric(cpu);
                    cpu.setState(initial(0x1000n, {}, flags));
                    const admitted =
                      mode === 'real' || (mode === 'virtual8086' ? iopl === 3 : cpl <= iopl);
                    const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
                    outcome(
                      result,
                      admitted ? 'budget' : 'protection-fault',
                      1n,
                      admitted ? 1n : 0n,
                      0n,
                    );
                    const expected =
                      (flags & ~0x10000n & ~0x200n) |
                      (admitted ? (set ? 0x200n : 0n) : enabled ? 0x200n : 0n);
                    equal(result.state.flags, expected, 'IF decision preserves other flags');
                    same(
                      result.state.interruptibility,
                      { sti: admitted && set && !enabled, ss: false },
                      'STI only creates on IF0',
                    );
                    if (!admitted) {
                      equal(result.protectionFault?.vector, 13, 'privilege vector');
                      equal(result.protectionFault?.errorCode, 0, 'privilege code');
                      equal(result.protectionFault?.phase, 'privilege', 'privilege phase');
                      equal(result.protectionFault?.instructionPc, 0x1000n, 'fault source');
                    }
                    same(cpu.readContext(), execution, 'no mode or CPL writer');
                    numeric();
                  });
                }
      },
    },
    {
      name: 'system POPF privilege masks use old IOPL and never change VM VIF VIP',
      async run() {
        for (const mode of ['real', 'virtual8086', 'protected', 'compatibility', 'long64'] as const)
          for (const cpl of mode === 'real' ? [0] : mode === 'virtual8086' ? [3] : [0, 1, 2, 3])
            for (const iopl of [0, 1, 2, 3])
              for (const width of mode === 'long64' ? [2, 8] : [2, 4]) {
                const execution = snapshot(mode, cpl);
                const flags = 0x190002n | BigInt(iopl << 12);
                const admitted = mode !== 'virtual8086' || iopl === 3;
                const image = 0xfffffffffffc4ed7n;
                await using(
                  compiler,
                  flagPrefix(execution, width) + '9d',
                  execution,
                  async (cpu) => {
                    const numeric = preserveNumeric(cpu);
                    const before = initial(0x1000n, { 4: 0x6000n }, flags);
                    cpu.setState(before);
                    const result = await cpu.run({ budget: 1n, repeatBudget: 9n });
                    outcome(
                      result,
                      admitted ? 'budget' : 'protection-fault',
                      1n,
                      admitted ? 1n : 0n,
                      9n,
                    );
                    const selected = mode === 'real' || cpl === 0 ? 0n : BigInt(iopl << 12);
                    let expected = flags & ~0x10000n;
                    if (admitted) {
                      expected = 0x184cd7n | selected;
                      if (width !== 2) expected |= 0x240000n;
                      if (mode === 'real' || cpl <= iopl) expected |= 0x200n;
                    }
                    equal(result.state.flags, expected, 'literal POPF writable fields');
                    equal(
                      result.state.registers[4],
                      admitted ? 0x6000n + BigInt(width) : 0x6000n,
                      'pop publication',
                    );
                    same(cpu.readContext(), execution, 'VM derives only from context');
                    numeric();
                  },
                  {
                    data: admitted
                      ? [{ base: 0x6000n, bytes: bytes(image, width), write: false }]
                      : [],
                  },
                );
              }
      },
    },
  ];
}
