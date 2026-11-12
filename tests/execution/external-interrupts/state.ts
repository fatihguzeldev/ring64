import {
  using,
  execution,
  input,
  same,
  equal,
  check,
  throws,
  gate,
  image,
  DESCRIPTORS,
  STACK,
  FILL,
  EMPTY,
  type Scenario,
} from './fixture.js';

export function stateScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'external checkpoints detach all activity and queue variants and reject inconsistent replacement atomically',
      async run() {
        await using(compiler, '90', execution(), async (cpu) => {
          const base = input(0x1000n, { 4: 0x8000n }, 0x202n);
          for (const event of [
            { kind: 'ready' },
            { kind: 'halted' },
            { kind: 'shutdown' },
            {
              kind: 'pending-interrupt',
              interrupt: {
                source: { kind: 'irq', vector: 13 },
                returnPc: 0x1000n,
                savedFlags: 0x202n,
              },
            },
            {
              kind: 'pending-interrupt',
              interrupt: { source: { kind: 'nmi' }, returnPc: 0x1000n, savedFlags: 0x202n },
            },
          ]) {
            cpu.setState({
              ...base,
              event,
              interrupts: { irq: 255, nmiPending: true, nmiBlocked: true },
            } as never);
            const captured = cpu.readState();
            cpu.setState(captured);
            same(cpu.readState(), captured, 'complete checkpoint roundtrip');
            const detached = cpu.readState();
            detached.interrupts.irq = 1;
            detached.interrupts.nmiPending = false;
            if (detached.event.kind === 'pending-interrupt')
              detached.event.interrupt.returnPc = 99n;
            same(cpu.readState(), captured, 'nested projections are detached');
          }
          const pending = {
            ...base,
            event: {
              kind: 'pending-interrupt',
              interrupt: { source: { kind: 'nmi' }, returnPc: 0x1000n, savedFlags: 0x202n },
            },
            interrupts: { ...EMPTY, nmiBlocked: true },
          };
          cpu.setState(pending as never);
          const before = cpu.readState();
          for (const replacement of [
            { ...pending, interrupts: undefined },
            { ...pending, interrupts: null },
            { ...pending, interrupts: { ...EMPTY, irq: 256 } },
            { ...pending, interrupts: { ...EMPTY, irq: '2' } },
            { ...pending, interrupts: { ...EMPTY, nmiPending: 1, nmiBlocked: true } },
            { ...pending, interrupts: EMPTY },
            { ...pending, event: { kind: 'halted' }, interruptibility: { sti: false, ss: true } },
            {
              ...pending,
              event: {
                kind: 'pending-interrupt',
                interrupt: { ...pending.event.interrupt, returnPc: 0x1001n },
              },
            },
            {
              ...pending,
              event: {
                kind: 'pending-interrupt',
                interrupt: { ...pending.event.interrupt, savedFlags: 0x10202n },
              },
            },
            {
              ...pending,
              event: {
                kind: 'pending-interrupt',
                interrupt: { ...pending.event.interrupt, source: { kind: 'nmi', vector: 2 } },
              },
            },
            {
              ...pending,
              event: {
                kind: 'pending-interrupt',
                interrupt: { ...pending.event.interrupt, errorCode: 0 },
              },
            },
            {
              ...pending,
              flags: 2n,
              event: {
                kind: 'pending-interrupt',
                interrupt: {
                  source: { kind: 'irq', vector: 2 },
                  returnPc: 0x1000n,
                  savedFlags: 2n,
                },
              },
            },
          ]) {
            throws(() => cpu.setState(replacement as never), 'invalid event/queue checkpoint');
            same(
              cpu.readState(),
              before,
              'rejection publishes no scalar, activity or queue changes',
            );
          }
          cpu.setState({ registers: base.registers, flags: base.flags, rip: base.rip });
          same(cpu.readState().event, { kind: 'ready' }, 'old event omission selects ready');
          same(cpu.readState().interrupts, EMPTY, 'old queue omission selects empty/unblocked');
        });
      },
    },
    {
      name: 'external context replacement cancels accepted activity and blocking but preserves unaccepted queues',
      async run() {
        await using(compiler, '90', execution(), async (cpu) => {
          cpu.setState({
            ...input(),
            event: { kind: 'halted' },
            interrupts: { irq: 0x20, nmiPending: true, nmiBlocked: true },
          });
          const context = cpu.readContext();
          const before = cpu.readState();
          throws(() => cpu.setContext({ ...context, cpl: 4 } as never), 'invalid context');
          same(cpu.readState(), before, 'failed context import preserves complete activity');
          cpu.setContext(context);
          same(
            cpu.readState().event,
            { kind: 'ready' },
            'equal host context explicitly leaves halt',
          );
          same(
            cpu.readState().interrupts,
            { irq: 0x20, nmiPending: true, nmiBlocked: false },
            'queues preserved, block cleared',
          );
          let captures = 0;
          throws(
            () =>
              cpu.setState({
                ...input(),
                get interrupts() {
                  captures++;
                  cpu.requestNmi();
                  return { ...EMPTY, irq: 256 };
                },
              }),
            'invalid outer capture',
          );
          equal(captures, 1, 'interrupt projection captured once');
          same(
            cpu.readState().interrupts,
            { irq: 0x20, nmiPending: true, nmiBlocked: false },
            'successful nested queueing survives outer rejection',
          );
          for (const vector of [-1, 256, 1.5, NaN, '2', null, new Number(2)]) {
            throws(
              () => cpu.requestInterrupt(vector as never),
              'invalid vector rejects even while full',
            );
          }
        });
      },
    },
    {
      name: 'external accepted NMI blocks before private gate refusal and a coalesced latch waits until IRET begins',
      async run() {
        await using(
          compiler,
          '90',
          execution(),
          async (cpu) => {
            cpu.setState(input());
            cpu.setTimeState({ tsc: 100n, tscAux: 7 });
            cpu.requestNmi();
            const accepted = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
            equal(accepted.reason, 'event-budget', 'acceptance occurs without attempt');
            same(
              accepted.state.interrupts,
              { ...EMPTY, nmiBlocked: true },
              'immediate acceptance blocking',
            );
            cpu.requestNmi();
            cpu.requestNmi();
            const refused = await cpu.run({ budget: 1n, eventDelivery: { budget: 1n } });
            equal(refused.reason, 'system-memory-fault', 'private IDT permission refusal');
            equal(
              cpu.readTimeState().tsc,
              100n,
              'NMI acceptance blocking and refused entry tick zero',
            );
            check(
              refused.systemMemoryFault && 'vector' in refused.systemMemoryFault,
              'vector-bearing gate diagnostic',
            );
            equal(refused.systemMemoryFault.vector, 2, 'NMI table provenance');
            equal(
              refused.systemMemoryFault?.instructionPc,
              0x1000n,
              'external boundary diagnostic',
            );
            same(refused.state.event, accepted.state.event, 'accepted source stays frozen');
            same(
              refused.state.interrupts,
              { ...EMPTY, nmiPending: true, nmiBlocked: true },
              'one coalesced pending NMI',
            );
            same(cpu.readMemory(STACK, 256), new Uint8Array(256).fill(0xa5), 'no partial frame');
            cpu.setMappings([
              {
                base: 0x1000n,
                backing: 'code',
                offset: 0,
                length: 1,
                permissions: { read: true, write: false, execute: true },
              },
              {
                base: 0x4008n,
                backing: 'data0',
                offset: 0,
                length: 16,
                permissions: { read: true, write: true, execute: false },
              },
              {
                base: STACK,
                backing: 'data1',
                offset: 0,
                length: 256,
                permissions: { read: true, write: true, execute: false },
              },
              {
                base: 0x8010n,
                backing: 'data2',
                offset: 0,
                length: 8,
                permissions: { read: true, write: true, execute: false },
              },
              {
                base: 0x2000n,
                backing: 'data3',
                offset: 0,
                length: 1,
                permissions: { read: true, write: true, execute: true },
              },
            ]);
            const entered = await cpu.run({
              budget: 1n,
              stop: 0x2000n,
              eventDelivery: { budget: 1n },
            });
            equal(entered.reason, 'stop', 'retry accepted NMI despite its own blocking');
            same(
              entered.state.interrupts,
              refused.state.interrupts,
              'successful entry does not unblock',
            );
            const returned = await cpu.run({ budget: 1n, eventDelivery: { budget: 1n } });
            equal(
              returned.reason,
              'budget',
              'IRET permits pending second NMI before post-work gate',
            );
            equal(returned.retired, 1n, 'only IRET retires');
            equal(
              cpu.readTimeState().tsc,
              101n,
              'blocked latch and second NMI frame add no ticks to IRET',
            );
            equal(returned.deliveryAttempts, 1n, 'one second-NMI attempt');
            equal(returned.state.rip, 0x2000n, 'second NMI handler');
            same(
              returned.state.interrupts,
              { ...EMPTY, nmiBlocked: true },
              'second source consumed and blocks',
            );
            same(
              cpu.readMemory(0x7ff4n, 12),
              image([0x1000n, 8n, 2n], 4),
              'one frame at completed IRET continuation',
            );
          },
          {
            data: [
              DESCRIPTORS,
              { base: STACK, bytes: FILL },
              { base: 0x8010n, bytes: gate(32, 8, 0x2000n, 0), read: false },
              { base: 0x2000n, bytes: 'cf', execute: true },
            ],
          },
        );
      },
    },
    {
      name: 'external intake rejects asynchronous compilation without mutating either bounded source',
      async run() {
        await using(compiler, '90', execution(), async (cpu) => {
          cpu.setState({ ...input(), interrupts: { ...EMPTY, nmiBlocked: true } });
          cpu.requestInterrupt(0x20);
          cpu.requestNmi();
          const compile = WebAssembly.compile;
          let observed = false;
          WebAssembly.compile = async (bytes) => {
            throws(() => cpu.requestInterrupt(0x21), 'IRQ intake during compile');
            throws(() => cpu.requestNmi(), 'NMI intake during compile');
            observed = true;
            await Promise.resolve();
            return compile(bytes);
          };
          try {
            const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 1n } });
            check(observed, 'real generated module used asynchronous compiler');
            same(
              result.state.interrupts,
              { irq: 0x20, nmiPending: true, nmiBlocked: true },
              'rejected intake leaves sources unchanged',
            );
          } finally {
            WebAssembly.compile = compile;
          }
        });
      },
    },
  ];
}
