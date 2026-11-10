import {
  using,
  execution,
  input,
  snapshot,
  loadedCode,
  loadedData,
  same,
  equal,
  check,
  gate,
  image,
  DESCRIPTORS,
  STACK,
  FILL,
  EMPTY,
  preserveNumeric,
  type Scenario,
} from './fixture.js';

export function activityScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'external opted-in HLT publishes halt through final budget and stop without exception staging',
      async run() {
        await using(compiler, 'f4', execution(), async (cpu) => {
          for (const options of [
            { budget: 1n, eventDelivery: { budget: 0n } },
            { budget: 1n, eventDelivery: { budget: 1n } },
            { budget: 1n, exceptionDelivery: { budget: 1n } },
            { budget: 2n, stop: 0x1001n, eventDelivery: { budget: 1n } },
          ]) {
            cpu.setState(input());
            const result = await cpu.run(options);
            equal(result.reason, options.budget === 1n ? 'budget' : 'stop', 'post-HLT host gate');
            equal(result.retired, 1n, 'HLT retired once');
            equal(result.deliveryAttempts, 0n, 'HLT does not stage a processor exception');
            equal(result.state.rip, 0x1001n, 'completed continuation');
            same(result.state.event, { kind: 'halted' }, 'halt activity survives host gates');
          }
        });
      },
    },
    {
      name: 'external HLT publishes persistent next-PC activity without fetching its successor',
      async run() {
        await using(compiler, 'f4', execution(), async (cpu) => {
          const numeric = preserveNumeric(cpu);
          cpu.setState(input());
          const completed = await cpu.run({ budget: 1n });
          equal(completed.reason, 'budget', 'last allowance gate');
          equal(completed.retired, 1n, 'HLT retirement');
          equal(completed.state.rip, 0x1001n, 'continuation after HLT');
          same(completed.state.event, { kind: 'halted' }, 'persistent activity');
          for (const options of [{ budget: 3n }, { budget: 3n, eventDelivery: { budget: 1n } }]) {
            const halted = await cpu.run(options);
            equal(halted.reason, 'halted', 'no successor fetch');
            equal(halted.retired, 0n, 'no repeated HLT retirement');
            equal(halted.resources.nativeEntries, 0, 'halted does not invoke generated code');
            same(halted.state, completed.state, 'halted state remains stable');
          }
          cpu.requestInterrupt(0x20);
          const masked = await cpu.run({ budget: 1n, eventDelivery: { budget: 1n } });
          equal(masked.reason, 'halted', 'masked IRQ cannot wake IF0');
          same(masked.state.interrupts, { ...EMPTY, irq: 0x20 }, 'masked IRQ retained');
          numeric();
        });
      },
    },
    {
      name: 'external HLT works across imported modes and faults before retirement at CPL3 or LOCK',
      async run() {
        for (const mode of [
          'real',
          'protected',
          'virtual8086',
          'compatibility',
          'long64',
        ] as const) {
          for (const width of mode === 'protected' ? ([16, 32] as const) : ([32] as const)) {
            const context = snapshot(mode, 0, width === 32);
            if (mode !== 'real' && mode !== 'virtual8086') {
              context.segments.cs = loadedCode(mode === 'long64' ? 64 : width);
              context.segments.ss = loadedData(32);
            }
            await using(compiler, 'f4', context, async (cpu) => {
              cpu.setState(input());
              const result = await cpu.run({ budget: 2n });
              equal(result.reason, mode === 'virtual8086' ? 'protection-fault' : 'halted', mode);
              equal(result.retired, mode === 'virtual8086' ? 0n : 1n, `${mode} retirement`);
              if (mode === 'virtual8086') {
                equal(result.protectionFault?.vector, 13, 'VM HLT vector');
                equal(result.protectionFault?.errorCode, 0, 'VM HLT hard zero');
                same(result.state.event, { kind: 'ready' }, 'fault does not halt');
              } else same(result.state.event, { kind: 'halted' }, `${mode} activity`);
            });
          }
        }
        for (const code of ['f4', 'f0f4']) {
          const context = snapshot('protected', 3);
          context.segments.cs = loadedCode(32, 11, 3);
          context.segments.ss = loadedData(32, 19, 3);
          await using(compiler, code, context, async (cpu) => {
            cpu.setState(input());
            const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
            equal(result.reason, 'event-budget', 'selected HLT producer');
            equal(result.retired, 0n, 'invalid or privileged HLT does not retire');
            check(result.state.event.kind === 'pending', 'typed processor source');
            equal(result.state.event.exception.vector, code === 'f4' ? 13 : 6, 'LOCK precedes CPL');
            equal(result.state.event.exception.returnPc, 0x1000n, 'faulting HLT PC');
          });
        }
        for (const code of ['6667f2f3f4', '4866f4']) {
          await using(compiler, code, snapshot(), async (cpu) => {
            cpu.setState(input());
            const result = await cpu.run({ budget: 2n });
            equal(result.reason, 'halted', 'ignored admitted prefixes');
            equal(result.state.rip, 0x1000n + BigInt(code.length / 2), 'decoded HLT length');
          });
        }
      },
    },
    {
      name: 'external STI HLT accepts a frozen IRQ before final budget and retains it across later NMI',
      async run() {
        await using(
          compiler,
          'fbf4',
          execution(),
          async (cpu) => {
            cpu.setState(input());
            equal(cpu.requestInterrupt(0x20), true, 'empty IRQ intake');
            const staged = await cpu.run({ budget: 2n, eventDelivery: { budget: 0n } });
            equal(staged.reason, 'event-budget', 'acceptance before last allowance gate');
            equal(staged.retired, 2n, 'STI and HLT both retire');
            same(
              staged.state.event,
              {
                kind: 'pending-interrupt',
                interrupt: {
                  source: { kind: 'irq', vector: 0x20 },
                  returnPc: 0x1002n,
                  savedFlags: 0x202n,
                },
              },
              'post-HLT frozen source',
            );
            same(
              staged.state.interruptibility,
              { sti: false, ss: false },
              'HLT consumed STI delay',
            );
            same(cpu.readMemory(STACK, 256), new Uint8Array(256).fill(0xa5), 'no attempt frame');
            cpu.requestNmi();
            const entered = await cpu.run({
              budget: 1n,
              stop: 0x2000n,
              eventDelivery: { budget: 1n },
            });
            equal(entered.reason, 'stop', 'retained IRQ serviced before newly queued NMI');
            equal(entered.deliveryAttempts, 1n, 'one IRQ attempt');
            same(
              entered.state.interrupts,
              { ...EMPTY, nmiPending: true },
              'NMI waits at handler stop',
            );
            same(cpu.readMemory(0x7ff4n, 12), image([0x1002n, 8n, 0x202n], 4), 'post-HLT frame');
          },
          {
            data: [
              DESCRIPTORS,
              { base: STACK, bytes: FILL },
              { base: 0x8100n, bytes: gate(32, 8, 0x2000n, 0) },
            ],
          },
        );
      },
    },
    {
      name: 'external TF HLT completion outranks NMI and the handler gate outranks further nesting',
      async run() {
        await using(
          compiler,
          'f4',
          execution(),
          async (cpu) => {
            cpu.setState(input(0x1000n, { 4: 0x8000n }, 0x102n, { sti: false, ss: true }));
            cpu.requestNmi();
            const staged = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
            equal(staged.reason, 'event-budget', 'completion trap is staged');
            check(staged.state.event.kind === 'pending', 'HLT has woken into processor event');
            equal(staged.state.event.exception.vector, 1, '#DB before NMI');
            equal(
              staged.state.event.exception.returnPc,
              0x1001n,
              'completed HLT trap continuation',
            );
            same(staged.state.interrupts, { ...EMPTY, nmiPending: true }, 'NMI remains unaccepted');
            const trapped = await cpu.run({
              budget: 1n,
              stop: 0x2000n,
              eventDelivery: { budget: 1n },
            });
            equal(trapped.reason, 'stop', '#DB handler stop precedes NMI acceptance');
            same(
              cpu.readMemory(0x7ff4n, 12),
              image([0x1001n, 8n, 0x102n], 4),
              'completed trap frame',
            );
            const nested = await cpu.run({
              budget: 1n,
              stop: 0x3000n,
              eventDelivery: { budget: 1n },
            });
            equal(nested.reason, 'stop', 'NMI can nest before first debug-handler byte');
            equal(nested.retired, 0n, 'no handler instruction executed');
            same(
              nested.state.interrupts,
              { ...EMPTY, nmiBlocked: true },
              'NMI blocked at acceptance',
            );
            same(
              cpu.readMemory(0x7fe8n, 12),
              image([0x2000n, 8n, 2n], 4),
              'NMI saves handler boundary',
            );
          },
          {
            data: [
              DESCRIPTORS,
              { base: STACK, bytes: FILL },
              { base: 0x8008n, bytes: gate(32, 8, 0x2000n, 0) },
              { base: 0x8010n, bytes: gate(32, 8, 0x3000n, 0) },
            ],
          },
        );
      },
    },
  ];
}
