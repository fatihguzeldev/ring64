import {
  using,
  createCpu,
  snapshot,
  initial,
  outcome,
  debug,
  equal,
  same,
  hex,
  LIMITS,
  DATA32,
  profiles,
  loadedData,
  flagPrefix,
  preserveNumeric,
  type Scenario,
} from './fixture.js';

export function shadowScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'system SS loads preserve or replace complete caches across all fourteen imported profiles',
      async run() {
        for (const execution of profiles()) {
          const legacy = execution.mode === 'real' || execution.mode === 'virtual8086';
          for (const form of execution.mode === 'long64'
            ? ['register', 'memory']
            : ['register', 'memory', 'pop16', 'pop32']) {
            const width = form === 'pop32' ? 4 : 2;
            const address =
              execution.mode === 'long64' || execution.segments.cs.default32 ? '' : '67';
            const code = form.startsWith('pop')
              ? flagPrefix(execution, width) + '17'
              : form === 'memory'
                ? '36' + address + '8e13'
                : '8ed0';
            await using(
              compiler,
              code + '90',
              execution,
              async (cpu) => {
                const numeric = preserveNumeric(cpu);
                const before = initial(
                  0x1000n,
                  { 0: 0x1122334455660010n, 3: 0x6000n, 4: 0x1122334400006000n },
                  0x102n,
                );
                cpu.setState(before);
                const first = await cpu.run({ budget: 1n });
                outcome(first, 'budget', 1n, 1n);
                equal(first.debugException, undefined, 'new SS suppresses own step');
                same(
                  first.state.interruptibility,
                  { sti: false, ss: true },
                  'history across profiles',
                );
                const expected = before.registers.slice();
                if (form.startsWith('pop')) expected[4] = 0x1122334400006000n + BigInt(width);
                same(first.state.registers, expected, 'source and old-width pointer banks');
                const context = structuredClone(execution);
                if (legacy) {
                  context.segments.ss.selector = 16;
                  context.segments.ss.base = 0x100n;
                } else context.segments.ss = loadedData(32);
                same(cpu.readContext(), context, 'complete installed or retained cache');
                const nextPc = 0x1000n + BigInt(code.length / 2);
                const next = await cpu.run({ budget: 1n });
                debug(
                  next,
                  nextPc,
                  nextPc + 1n,
                  true,
                  legacy && execution.mode === 'virtual8086' ? 0x20102n : 0x102n,
                );
                cpu.setContext(context);
                same(cpu.readContext(), context, 'produced full checkpoint roundtrip');
                numeric();
              },
              {
                data: [
                  ...(form === 'register'
                    ? []
                    : [
                        {
                          base: 0x6000n,
                          bytes: form === 'pop32' ? '10000000' : '1000',
                          write: false,
                        },
                      ]),
                  ...(legacy ? [] : [{ base: 0x4010n, bytes: DATA32, write: false }]),
                ],
              },
            );
          }
        }
      },
    },
    {
      name: 'system context-equal MOV SS suppresses once across runs and a second load does not extend it',
      async run() {
        for (const second of ['90', '8ed0', 'fb']) {
          await using(
            compiler,
            '8ed0' + second,
            snapshot('protected'),
            async (cpu) => {
              const numeric = preserveNumeric(cpu);
              cpu.setState(initial(0x1000n, { 0: 16n }, 0x102n));
              const first = await cpu.run({ budget: 1n });
              outcome(first, 'budget', 1n, 1n);
              equal(first.state.flags, 0x102n, 'MOV SS preserves TF');
              same(first.state.interruptibility, { sti: false, ss: true }, 'first SS history');
              equal(first.debugException, undefined, 'own step suppressed');
              for (const input of [{ budget: 0n }, { budget: 1n, stop: 0x1002n }]) {
                const gate = await cpu.run(input);
                same(gate.state, first.state, 'gate does not consume shadow');
              }
              const saved = cpu.readState();
              cpu.setState(saved);
              const next = await cpu.run({ budget: 1n, stop: 0x1002n + BigInt(second.length / 2) });
              outcome(next, 'debug-exception', 1n, 1n);
              debug(
                next,
                0x1002n,
                0x1002n + BigInt(second.length / 2),
                true,
                second === 'fb' ? 0x302n : 0x102n,
              );
              equal(next.state.flags, second === 'fb' ? 0x302n : 0x102n, 'next instruction flags');
              numeric();
            },
            { data: [{ base: 0x4010n, bytes: DATA32, write: false }] },
          );
        }
      },
    },
    {
      name: 'system POP SS freezes old pointer width and LSS remains immediately step eligible',
      async run() {
        const execution = snapshot('protected', 0, true, false);
        await using(
          compiler,
          '1790',
          execution,
          async (cpu) => {
            const numeric = preserveNumeric(cpu);
            cpu.setState(initial(0x1000n, { 4: 0x112233445566fffcn }, 0x10102n));
            const pop = await cpu.run({ budget: 1n });
            outcome(pop, 'budget', 1n, 1n);
            equal(pop.state.registers[4], 0x1122334455660000n, 'old16 pointer increment');
            equal(pop.state.flags, 0x102n, 'RF begin and own TF suppression');
            same(pop.state.interruptibility, { sti: false, ss: true }, 'successful POP history');
            equal(cpu.readContext().segments.ss.selector, 24, 'new SS selector');
            equal(cpu.readContext().segments.ss.default32, true, 'new SS width');
            const nop = await cpu.run({ budget: 1n });
            debug(nop, 0x1001n, 0x1002n, true, 0x102n);
            numeric();
          },
          {
            data: [
              { base: 0xfffcn, bytes: '18000000', write: false },
              { base: 0x4018n, bytes: DATA32, write: false },
            ],
          },
        );
        await using(
          compiler,
          '0fb223',
          snapshot('protected'),
          async (cpu) => {
            const numeric = preserveNumeric(cpu);
            cpu.setState(initial(0x1000n, { 3: 0x6000n, 4: 0x1122334400005000n }, 0x102n));
            const result = await cpu.run({ budget: 1n });
            outcome(result, 'debug-exception', 1n, 1n);
            debug(result, 0x1000n, 0x1003n, true, 0x102n);
            equal(
              result.state.registers[4],
              0x1122334400007000n,
              'LSS32 preserves raw upper outside long64',
            );
            numeric();
          },
          {
            data: [
              { base: 0x6000n, bytes: '007000001000', write: false },
              { base: 0x4010n, bytes: DATA32, write: false },
            ],
          },
        );
      },
    },
    {
      name: 'system private fault repair preserves history and reports only the completed successor trap',
      async run() {
        const cpu = await createCpu({
          compiler,
          context: snapshot(),
          entry: 0x1000n,
          limits: LIMITS,
          memoryLimits: { maxBackings: 3, maxMappings: 3, maxBackingBytes: 64 },
          memory: {
            backings: [{ id: 'code', bytes: hex('8b03') }],
            mappings: [
              {
                base: 0x1000n,
                backing: 'code',
                offset: 0,
                length: 2,
                permissions: { read: true, write: false, execute: true },
              },
            ],
          },
        });
        try {
          const numeric = preserveNumeric(cpu);
          cpu.setState(initial(0x1000n, { 3: 0x6000n }, 0x10102n, { sti: false, ss: true }));
          const faulted = await cpu.run({ budget: 1n });
          outcome(faulted, 'data-fault', 1n, 0n);
          equal(faulted.state.flags, 0x102n, 'late fault clears RF');
          same(
            faulted.state.interruptibility,
            { sti: false, ss: true },
            'fault detection is not delivery',
          );
          equal(faulted.debugException, undefined, 'unexecuted load has no trap');
          cpu.addBacking({ id: 'data', bytes: hex('78563412') });
          cpu.setMappings([
            {
              base: 0x1000n,
              backing: 'code',
              offset: 0,
              length: 2,
              permissions: { read: true, write: false, execute: true },
            },
            {
              base: 0x6000n,
              backing: 'data',
              offset: 0,
              length: 4,
              permissions: { read: true, write: false, execute: false },
            },
          ]);
          const repaired = await cpu.run({ budget: 1n });
          outcome(repaired, 'debug-exception', 1n, 1n);
          debug(repaired, 0x1000n, 0x1002n, true, 0x102n);
          equal(repaired.state.registers[0], 0x12345678n, 'repaired load executes once');
          numeric();
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'system STI history distinguishes IF0 and IF1 and a trap clears a newly created interval',
      async run() {
        for (const flags of [2n, 0x202n, 0x102n]) {
          await using(compiler, 'fbfbfa', snapshot(), async (cpu) => {
            const numeric = preserveNumeric(cpu);
            cpu.setState(initial(0x1000n, {}, flags));
            const first = await cpu.run({ budget: 1n });
            outcome(first, flags === 0x102n ? 'debug-exception' : 'budget', 1n, 1n);
            if (flags === 0x102n) debug(first, 0x1000n, 0x1001n, true, 0x302n);
            else {
              same(
                first.state.interruptibility,
                { sti: flags === 2n, ss: false },
                'only IF0 starts shadow',
              );
              const second = await cpu.run({ budget: 1n });
              same(
                second.state.interruptibility,
                { sti: false, ss: false },
                'STI IF1 does not renew',
              );
              const third = await cpu.run({ budget: 1n });
              equal(third.state.flags, 2n, 'CLI clears only IF');
            }
            numeric();
          });
        }
      },
    },
  ];
}
