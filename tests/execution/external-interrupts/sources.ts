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
  encoded,
  DESCRIPTORS,
  STACK,
  FILL,
  EMPTY,
  CODE16,
  CODE32,
  CODE64,
  DATA16,
  DATA32,
  type Scenario,
} from './fixture.js';

const absent = '00200800000e0000';

export function sourceScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'external NMI ignores STI inhibition and trap-gate IF permits a later IRQ before handler bytes',
      async run() {
        await using(
          compiler,
          '90',
          execution(),
          async (cpu) => {
            cpu.setState(input(0x1100n, { 4: 0x8000n }, 0x202n, { sti: true, ss: false }));
            cpu.setTimeState({ tsc: 100n, tscAux: 7 });
            cpu.requestInterrupt(0x20);
            cpu.requestNmi();
            const captured = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
            equal(captured.reason, 'event-budget', 'NMI eligible inside the selected STI profile');
            same(
              captured.state.event,
              {
                kind: 'pending-interrupt',
                interrupt: { source: { kind: 'nmi' }, returnPc: 0x1100n, savedFlags: 0x202n },
              },
              'NMI selected independently of IF and IRQ',
            );
            same(
              captured.state.interruptibility,
              { sti: true, ss: false },
              'acceptance does not clear STI interval',
            );
            const entered = await cpu.run({
              budget: 1n,
              stop: 0x2000n,
              eventDelivery: { budget: 1n },
            });
            equal(entered.reason, 'stop', 'NMI handler gate precedes fresh IRQ arbitration');
            equal(entered.state.flags, 0x202n, 'trap gate preserves IF');
            same(
              entered.state.interrupts,
              { irq: 0x20, nmiPending: false, nmiBlocked: true },
              'only NMI consumed',
            );
            const nested = await cpu.run({
              budget: 1n,
              stop: 0x3000n,
              eventDelivery: { budget: 1n },
            });
            equal(
              nested.reason,
              'stop',
              'preserved IF permits IRQ before unmapped NMI-handler bytes',
            );
            equal(nested.retired, 0n, 'no source or handler instruction fetched');
            equal(
              cpu.readTimeState().tsc,
              100n,
              'NMI and nested IRQ arbitration/frames perform zero clock work',
            );
            same(
              cpu.readMemory(0x7fe8n, 12),
              image([0x2000n, 8n, 0x202n], 4),
              'IRQ saves trap-handler boundary',
            );
          },
          {
            data: [
              DESCRIPTORS,
              { base: STACK, bytes: FILL },
              { base: 0x8010n, bytes: gate(32, 8, 0x2000n, 0, true) },
              { base: 0x8100n, bytes: gate(32, 8, 0x3000n, 0) },
            ],
          },
        );
      },
    },
    {
      name: 'external eligible IRQ reports without consumption and accepts before unmapped guest fetch only when opted in',
      async run() {
        await using(
          compiler,
          '90',
          execution(),
          async (cpu) => {
            cpu.setState(input(0x1100n, { 4: 0x8000n }, 0x202n));
            equal(cpu.requestInterrupt(0x20), true, 'first IRQ slot');
            equal(cpu.requestInterrupt(0x21), false, 'occupied slot never overwritten');
            for (const options of [{ budget: 0n }, { budget: 1n, stop: 0x1100n }, { budget: 1n }]) {
              const result = await cpu.run(options);
              equal(
                result.reason,
                options.budget === 0n ? 'budget' : 'stop' in options ? 'stop' : 'pending-interrupt',
                'initial/report frontier',
              );
              equal(result.resources.compilations, 0, 'no source-byte compilation');
              same(result.state.event, { kind: 'ready' }, 'report never accepts');
              same(
                result.state.interrupts,
                { ...EMPTY, irq: 0x20 },
                'report retains original slot',
              );
            }
            const accepted = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
            equal(accepted.reason, 'event-budget', 'zero entry allowance still accepts');
            equal(accepted.retired, 0n, 'source instruction not fetched');
            same(
              accepted.state.event,
              {
                kind: 'pending-interrupt',
                interrupt: {
                  source: { kind: 'irq', vector: 0x20 },
                  returnPc: 0x1100n,
                  savedFlags: 0x202n,
                },
              },
              'captured IRQ',
            );
            equal(cpu.requestInterrupt(0x21), true, 'accepted source vacated slot');
            const omitted = await cpu.run({ budget: 1n });
            equal(omitted.reason, 'pending-interrupt', 'accepted source survives omitted option');
            same(omitted.state.event, accepted.state.event, 'frozen source retained');
            const entered = await cpu.run({
              budget: 1n,
              stop: 0x2000n,
              exceptionDelivery: { budget: 1n },
            });
            equal(
              entered.reason,
              'stop',
              'backward-compatible option also delivers external source',
            );
            same(
              cpu.readMemory(0x7ff4n, 12),
              image([0x1100n, 8n, 0x202n], 4),
              'IRQ no error slot or forced RF',
            );
            same(
              entered.state.interrupts,
              { ...EMPTY, irq: 0x21 },
              'later IRQ retained through interrupt gate',
            );
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
      name: 'external controller-selected vectors keep IRQ identity instead of exception or NMI interpretation',
      async run() {
        for (const vector of [0, 2, 8, 13, 255]) {
          await using(
            compiler,
            '90',
            execution(),
            async (cpu) => {
              cpu.setState(input(0x1000n, { 4: 0x8000n }, 0x202n));
              cpu.requestInterrupt(vector);
              const result = await cpu.run({
                budget: 1n,
                stop: 0x2000n,
                eventDelivery: { budget: 1n },
              });
              equal(result.reason, 'stop', 'IRQ entry');
              equal(result.retired, 0n, 'automatic entry is not a guest instruction');
              equal(result.state.registers[4], 0x7ff4n, 'exact three-slot arity');
              same(
                cpu.readMemory(0x7ff4n, 12),
                image([0x1000n, 8n, 0x202n], 4),
                'no exception error slot',
              );
              same(result.state.interrupts, EMPTY, 'IRQ2 does not establish NMI blocking');
            },
            {
              data: [
                DESCRIPTORS,
                { base: STACK, bytes: FILL },
                { base: 0x8000n + BigInt(vector * 8), bytes: gate(32, 8, 0x2000n, 0) },
              ],
            },
          );
        }
      },
    },
    {
      name: 'external vector13 entry failure is benign and stages exact EXT-aware secondary before double fault',
      async run() {
        await using(
          compiler,
          '90',
          execution(),
          async (cpu) => {
            cpu.setState(input(0x1000n, { 4: 0x8000n }, 0x202n));
            cpu.requestInterrupt(13);
            const secondary = await cpu.run({ budget: 1n, eventDelivery: { budget: 1n } });
            equal(secondary.reason, 'event-budget', 'shared allowance exhausted by first entry');
            equal(secondary.deliveryAttempts, 1n, 'one failed external attempt');
            same(
              secondary.state.event,
              {
                kind: 'pending',
                exception: {
                  vector: 11,
                  instructionPc: 0x1000n,
                  returnPc: 0x1000n,
                  savedFlags: 0x10202n,
                  errorCode: 0x6b,
                },
              },
              'IRQ13 is benign independently of vector',
            );
            same(secondary.state.interrupts, EMPTY, 'accepted request cannot be replayed');
            const fault = await cpu.run({
              budget: 1n,
              stop: 0x3000n,
              eventDelivery: { budget: 1n },
            });
            equal(fault.reason, 'stop', 'secondary #NP delivered');
            same(
              cpu.readMemory(0x7ff0n, 16),
              image([0x6bn, 0x1000n, 8n, 0x10202n], 4),
              'only secondary fault has an error slot',
            );
          },
          {
            data: [
              DESCRIPTORS,
              { base: STACK, bytes: FILL },
              { base: 0x8068n, bytes: absent },
              { base: 0x8058n, bytes: gate(32, 8, 0x3000n, 0) },
            ],
          },
        );
      },
    },
    {
      name: 'external real and protected16 frames preserve raw SP and imported control widths',
      async run() {
        for (const real of [true, false]) {
          const context = snapshot(real ? 'real' : 'protected', 0, false, false);
          context.idtr = { base: 0x8000n, limit: 0x7ff };
          if (!real) {
            context.segments.cs = loadedCode(16);
            context.segments.ss = loadedData(16);
          }
          await using(
            compiler,
            '90',
            context,
            async (cpu) => {
              cpu.setState(input(0x1000n, { 4: 0x11223344abcd8000n }, 0x202n));
              cpu.requestInterrupt(0x20);
              const entered = await cpu.run({
                budget: 1n,
                stop: 0x2000n,
                eventDelivery: { budget: 1n },
              });
              equal(entered.reason, 'stop', '16-bit external entry');
              equal(entered.state.registers[4], 0x11223344abcd7ffan, 'raw high SP preserved');
              same(
                cpu.readMemory(0x7ffan, 6),
                image([0x1000n, real ? 0n : 8n, 0x202n], 2),
                'fixed/gate-width slots',
              );
              const returned = await cpu.run({ budget: 1n });
              equal(returned.state.rip, 0x1000n, 'IRET continuation');
              equal(returned.state.registers[4], 0x11223344abcd8000n, 'raw SP restored');
            },
            {
              data: [
                ...(!real ? [{ base: 0x4008n, bytes: CODE16 + DATA16 }] : []),
                { base: STACK, bytes: FILL },
                {
                  base: 0x8000n + BigInt(0x20 * (real ? 4 : 8)),
                  bytes: real ? encoded(image([0x2000n, 0n], 2)) : gate(16, 8, 0x2000n, 0),
                },
                { base: 0x2000n, bytes: 'cf', execute: true },
              ],
            },
          );
        }
      },
    },
    {
      name: 'external compatibility and long64 entry share qword frames and return source context without forced RF',
      async run() {
        for (const source of ['compatibility', 'long64'] as const) {
          const context = snapshot(source);
          context.segments.cs = loadedCode(source === 'long64' ? 64 : 32, 0x18);
          context.segments.ss = loadedData(32);
          context.idtr = { base: 0x8000n, limit: 0xfff };
          await using(
            compiler,
            '90',
            context,
            async (cpu) => {
              cpu.setState(input(0x1000n, { 4: 0x8000n }, 0x202n));
              cpu.requestNmi();
              const entered = await cpu.run({
                budget: 1n,
                stop: 0x2000n,
                eventDelivery: { budget: 1n },
              });
              equal(entered.reason, 'stop', 'IA32e NMI entry');
              equal(cpu.readContext().mode, 'long64', 'handler submode');
              same(
                cpu.readMemory(0x7fd8n, 40),
                image([0x1000n, 0x18n, 0x202n, 0x8000n, 16n], 8),
                'five qword external slots',
              );
              const returned = await cpu.run({ budget: 1n });
              equal(returned.reason, 'budget', 'IRETQ completes');
              equal(returned.state.flags, 0x202n, 'no synthesized RF');
              same(cpu.readContext(), context, 'complete source context restored');
              same(returned.state.interrupts, EMPTY, 'IRET unblocks NMI');
            },
            {
              data: [
                { base: 0x4008n, bytes: CODE64 + DATA32 + (source === 'long64' ? CODE64 : CODE32) },
                { base: STACK, bytes: FILL },
                { base: 0x8020n, bytes: gate(64, 8, 0x2000n, 0) },
                { base: 0x2000n, bytes: '48cf', execute: true },
              ],
            },
          );
        }
      },
    },
    {
      name: 'external virtual8086 IRQ bypasses software IOPL admission and creates a returnable nine-slot frame',
      async run() {
        const context = snapshot('virtual8086');
        for (const [index, key] of (['cs', 'ss', 'es', 'ds', 'fs', 'gs'] as const).entries()) {
          context.segments[key].selector = (index + 1) * 0x1000;
          context.segments[key].base = BigInt(index + 1) << 16n;
        }
        context.idtr = { base: 0x8000n, limit: 0x7ff };
        context.tr = { selector: 0x28, valid: true, base: 0x5000n, limit: 0x67, attributes: 0x8b };
        await using(
          compiler,
          '90',
          context,
          async (cpu) => {
            cpu.setState(input(0x1000n, { 4: 0x11223344abcd7020n }, 0x202n));
            cpu.requestInterrupt(0x20);
            const entered = await cpu.run({
              budget: 1n,
              stop: 0x2000n,
              eventDelivery: { budget: 1n },
            });
            equal(entered.reason, 'stop', 'IRQ ignores VM IOPL0 software gate restriction');
            same(
              cpu.readMemory(0x7f5cn, 36),
              image(
                [
                  0x1000n,
                  0x1000n,
                  0x20202n,
                  0xabcd7020n,
                  0x2000n,
                  0x3000n,
                  0x4000n,
                  0x5000n,
                  0x6000n,
                ],
                4,
              ),
              'nine-slot VM frame without RF/error code',
            );
            const returned = await cpu.run({ budget: 1n });
            equal(returned.reason, 'budget', 'IRETD restores VM');
            equal(returned.state.rip, 0x1000n, 'VM continuation');
            equal(returned.state.flags, 0x202n, 'scalar VM remains mode-derived');
            same(cpu.readContext(), context, 'complete VM segment caches restored');
          },
          {
            codeBase: 0x11000n,
            data: [
              DESCRIPTORS,
              { base: STACK, bytes: FILL },
              { base: 0x8100n, bytes: gate(32, 8, 0x2000n, 0) },
              { base: 0x5004n, bytes: encoded(image([0x7f80n], 4)) + '1000' },
              { base: 0x2000n, bytes: 'cf', execute: true },
            ],
          },
        );
      },
    },
    {
      name: 'external escalation exhausts one allowance and shutdown wakes only for its selected unblocked NMI',
      async run() {
        await using(
          compiler,
          '90',
          execution(),
          async (cpu) => {
            cpu.setState(input(0x1000n, { 4: 0x8000n }, 0x202n));
            cpu.requestInterrupt(13);
            const terminal = await cpu.run({ budget: 1n, eventDelivery: { budget: 3n } });
            equal(terminal.reason, 'shutdown', 'external to #NP to #DF chain');
            equal(terminal.deliveryAttempts, 3n, 'every failed attempt debits shared allowance');
            same(terminal.state.event, { kind: 'shutdown' }, 'terminal activity');
            cpu.requestInterrupt(0x20);
            const inert = await cpu.run({ budget: 0n, eventDelivery: { budget: 1n } });
            equal(inert.reason, 'shutdown', 'IRQ cannot wake or change shutdown priority');
            cpu.requestNmi();
            const noOption = await cpu.run({ budget: 1n });
            equal(noOption.reason, 'shutdown', 'omitted option cannot wake shutdown');
            for (const options of [{ budget: 0n }, { budget: 1n, stop: 0x1000n }]) {
              const gated = await cpu.run({ ...options, eventDelivery: { budget: 1n } });
              equal(
                gated.reason,
                options.budget === 0n ? 'budget' : 'stop',
                'eligible NMI restores initial gates',
              );
              same(gated.state.event, { kind: 'shutdown' }, 'gate leaves shutdown intact');
              equal(gated.state.interrupts.nmiPending, true, 'gate does not consume NMI');
            }
            const accepted = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
            equal(
              accepted.reason,
              'event-budget',
              'zero allowance permits selected NMI wake acceptance',
            );
            check(
              accepted.state.event.kind === 'pending-interrupt',
              'shutdown leaves into frozen NMI',
            );
            same(
              accepted.state.interrupts,
              { irq: 0x20, nmiPending: false, nmiBlocked: true },
              'wake consumes only NMI',
            );
            const entered = await cpu.run({
              budget: 1n,
              stop: 0x2000n,
              eventDelivery: { budget: 1n },
            });
            equal(entered.reason, 'stop', 'selected deterministic shutdown boundary can enter NMI');
            same(
              cpu.readMemory(0x7ff4n, 12),
              image([0x1000n, 8n, 0x202n], 4),
              'inspectable boundary only',
            );
          },
          {
            data: [
              DESCRIPTORS,
              { base: STACK, bytes: FILL },
              { base: 0x8068n, bytes: absent },
              { base: 0x8058n, bytes: absent },
              { base: 0x8040n, bytes: absent },
              { base: 0x8010n, bytes: gate(32, 8, 0x2000n, 0) },
            ],
          },
        );
      },
    },
  ];
}
