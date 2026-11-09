import {
  using,
  snapshot,
  initial,
  outcome,
  fullState,
  same,
  image,
  gate,
  withGate,
  loadedCode,
  loadedData,
  CODE64,
  FILL,
  STACK,
  TSS,
  guarded,
  preserveNumeric,
  type Scenario,
} from './fixture.js';

export function ia32eScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'software IA32e same inner and IST entries save five qwords and IRETQ reloads the complete returned context',
      async run() {
        for (const source of ['long64', 'compat16', 'compat32'] as const)
          for (const code32 of source === 'long64' ? [true] : [false, true])
            for (const cpl of [0, 3])
              for (const ist of [0, 1, 7]) {
                const execution = snapshot(
                  source === 'long64' ? 'long64' : 'compatibility',
                  cpl,
                  code32,
                  source !== 'compat16',
                );
                execution.segments.cs = loadedCode(
                  source === 'long64' ? 64 : code32 ? 32 : 16,
                  0x18 | cpl,
                  cpl,
                );
                execution.segments.ss = {
                  ...loadedData(source === 'compat16' ? 16 : 32, 0x20 | cpl, cpl, 0x30000n),
                  available: true,
                  limit: 0x12345,
                };
                execution.segments.fs.base = 0xffff800000001000n;
                const address = withGate(execution);
                const switching = cpl === 3 || ist !== 0;
                execution.tr = switching
                  ? { ...TSS }
                  : {
                      selector: 0xffff,
                      valid: false,
                      base: 0xffffffffffffffffn,
                      limit: 0xffffffff,
                      attributes: 0xfff,
                    };
                const field = 0x5000n + BigInt(ist ? 36 + 8 * (ist - 1) : 4);
                const selected = switching ? (ist === 7 ? 0x708bn : 0x706bn) : 0x702bn;
                const final = (selected & ~15n) - 40n;
                const oldSp = switching ? 0x123456780000702bn : 0x702bn;
                const callerCode =
                  source === 'long64'
                    ? cpl
                      ? 'ffff000000fbaf00'
                      : CODE64
                    : code32
                      ? cpl
                        ? 'ffff000000fbcf00'
                        : 'ffff0000009bcf00'
                      : cpl
                        ? 'ffff000000fb0000'
                        : 'ffff0000009b0000';
                const callerData =
                  source === 'compat16'
                    ? cpl
                      ? 'ffff000000f30000'
                      : 'ffff000000930000'
                    : cpl
                      ? 'ffff000000f3cf00'
                      : 'ffff00000093cf00';
                await using(
                  compiler,
                  'cd4090',
                  execution,
                  async (cpu) => {
                    const numeric = preserveNumeric(cpu);
                    const before = initial(0x1000n, { 4: oldSp }, 0x603n);
                    cpu.setState(before);
                    const entered = await cpu.run({ budget: 1n, repeatBudget: 19n, stop: 0x2000n });
                    outcome(entered, 'budget', 1n, 1n, 19n);
                    fullState(entered, before, 0x2000n, final, 0x403n);
                    same(
                      cpu.readContext(),
                      {
                        ...execution,
                        mode: 'long64',
                        cpl: 0,
                        segments: {
                          ...execution.segments,
                          cs: loadedCode(64),
                          ss: switching
                            ? { ...execution.segments.ss, selector: 0, usable: false, dpl: 0 }
                            : execution.segments.ss,
                        },
                      },
                      'entry stack-switch profile and complete raw context',
                    );
                    const writes: [bigint, Uint8Array][] = [
                      [
                        final,
                        image([0x1002n, BigInt(0x18 | cpl), 0x603n, oldSp, BigInt(0x20 | cpl)], 8),
                      ],
                    ];
                    guarded(cpu, STACK, FILL, writes);
                    const returned = await cpu.run({
                      budget: 1n,
                      repeatBudget: 19n,
                      stop: 0x1002n,
                    });
                    outcome(returned, 'budget', 1n, 1n, 19n);
                    fullState(returned, before, 0x1002n, oldSp, 0x603n);
                    same(
                      cpu.readContext(),
                      {
                        ...execution,
                        segments: {
                          ...execution.segments,
                          ss: loadedData(source === 'compat16' ? 16 : 32, 0x20 | cpl, cpl),
                        },
                      },
                      'IRETQ restores raw RSP before later use and reloads nonnull SS',
                    );
                    guarded(cpu, STACK, FILL, writes);
                    numeric();
                  },
                  {
                    data: [
                      { base: 0x4008n, bytes: CODE64 },
                      { base: 0x4018n, bytes: callerCode + callerData },
                      { base: address, bytes: gate(64, 8, 0x2000n, 3, false, ist), write: false },
                      ...(switching
                        ? [
                            {
                              base: field,
                              bytes: Array.from(image([selected], 8), (v) =>
                                v.toString(16).padStart(2, '0'),
                              ).join(''),
                              write: false,
                            },
                          ]
                        : []),
                      { base: 0x2000n, bytes: '48cf', execute: true },
                      { base: STACK, bytes: FILL },
                    ],
                  },
                );
              }
      },
    },
  ];
}
