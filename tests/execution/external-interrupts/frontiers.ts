import {
  using,
  execution,
  input,
  snapshot,
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
  type Scenario,
} from './fixture.js';

export function frontierScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'external IRET early unblock crosses imported modes but stays behind decode and resource admission',
      async run() {
        for (const mode of [
          'real',
          'protected',
          'virtual8086',
          'compatibility',
          'long64',
        ] as const) {
          for (const code32 of mode === 'protected' ? [false, true] : [true]) {
            const context = snapshot(mode, 0, code32);
            await using(compiler, mode === 'long64' ? '48cf' : 'cf', context, async (cpu) => {
              cpu.setState({ ...input(), interrupts: { ...EMPTY, nmiBlocked: true } });
              cpu.requestNmi();
              const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
              equal(
                result.reason,
                mode === 'virtual8086' ? 'event-budget' : 'data-fault',
                'selected IRET failure',
              );
              equal(result.retired, 0n, 'failed IRET');
              same(
                result.state.interrupts,
                { ...EMPTY, nmiPending: true },
                'commencing IRET unblocks before frame/privilege checks',
              );
              if (mode === 'virtual8086') {
                check(result.state.event.kind === 'pending', 'VM IOPL fault selected before NMI');
                equal(result.state.event.exception.vector, 13, 'synchronous IRET fault wins');
              }
            });
          }
        }
        for (const packet of [
          { code: 'f0cf', reason: 'invalid-encoding', limited: false },
          { code: '66', reason: 'fetch-fault', limited: false },
          { code: 'cf', reason: 'resource-limit', limited: true },
        ]) {
          await using(
            compiler,
            packet.code,
            execution(),
            async (cpu) => {
              cpu.setState({ ...input(), interrupts: { ...EMPTY, nmiBlocked: true } });
              cpu.requestNmi();
              const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 1n } });
              equal(result.reason, packet.reason, 'pre-begin frontier');
              same(
                result.state.interrupts,
                { ...EMPTY, nmiPending: true, nmiBlocked: true },
                'pre-begin failure cannot unblock',
              );
            },
            { ...(packet.limited ? { limits: { maxArtifactBytes: 1 } } : {}) },
          );
        }
        await using(compiler, 'cf', execution(), async (cpu) => {
          cpu.setState({
            ...input(0x1000n, { 4: 0x8000n }, 0x4002n),
            interrupts: { ...EMPTY, nmiBlocked: true },
          });
          cpu.requestNmi();
          const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
          equal(result.reason, 'unsupported', 'unsupported task return frontier');
          same(
            result.state.interrupts,
            { ...EMPTY, nmiPending: true },
            'unsupported task return still commenced IRET',
          );
        });
      },
    },
    {
      name: 'external HLT required bytes maximum length and artifact refusal precede halt retirement',
      async run() {
        for (const packet of [
          { code: 'f0', reason: 'fetch-fault', limited: false },
          { code: '66'.repeat(15) + 'f4', reason: 'invalid-encoding', limited: false },
          { code: 'f4', reason: 'resource-limit', limited: true },
        ]) {
          await using(
            compiler,
            packet.code,
            execution(),
            async (cpu) => {
              cpu.setState(input());
              const before = cpu.readState();
              const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 1n } });
              equal(result.reason, packet.reason, 'inherited pre-begin frontier');
              equal(result.retired, 0n, 'no HLT retirement');
              same(result.state, before, 'no activity or scalar publication');
            },
            { ...(packet.limited ? { limits: { maxArtifactBytes: 1 } } : {}) },
          );
        }
      },
    },
    {
      name: 'external MOV POP SS and LSS retain their distinct incoming STI suppression lifetimes',
      async run() {
        for (const kind of ['mov', 'pop', 'lss'] as const) {
          const code = kind === 'mov' ? '8ed090' : kind === 'pop' ? '1790' : '0fb20390';
          const sourceLength = kind === 'mov' ? 2n : kind === 'pop' ? 1n : 3n;
          await using(
            compiler,
            code,
            execution(),
            async (cpu) => {
              cpu.setState(
                input(0x1000n, { 0: 16n, 3: 0x6000n, 4: 0x8000n }, 0x202n, {
                  sti: true,
                  ss: false,
                }),
              );
              cpu.requestInterrupt(0x20);
              const result = await cpu.run({
                budget: kind === 'lss' ? 1n : 2n,
                eventDelivery: { budget: 1n },
              });
              equal(result.reason, 'budget', 'external completion before final allowance gate');
              equal(
                result.retired,
                kind === 'lss' ? 1n : 2n,
                'SS producer adds delay while LSS does not',
              );
              equal(result.deliveryAttempts, 1n, 'IRQ accepted only when shadow expires');
              const sp = kind === 'pop' ? 0x7ff8n : 0x7ff4n;
              same(
                cpu.readMemory(sp, 12),
                image([0x1000n + sourceLength + (kind === 'lss' ? 0n : 1n), 8n, 0x202n], 4),
                'selected source continuation',
              );
            },
            {
              data: [
                DESCRIPTORS,
                { base: STACK, bytes: FILL + '10000000' },
                { base: 0x8100n, bytes: gate(32, 8, 0x2000n, 0) },
                { base: 0x6000n, bytes: encoded(image([0x1234n], 4)) + '1000' },
              ],
            },
          );
        }
      },
    },
    {
      name: 'external shutdown NMI wake excludes blocked and SS-inhibited checkpoint states',
      async run() {
        for (const blocked of [false, true]) {
          await using(compiler, '90', execution(), async (cpu) => {
            cpu.setState({
              ...input(0x1000n, { 4: 0x8000n }, 2n, { sti: false, ss: !blocked }),
              event: { kind: 'shutdown' },
              interrupts: { ...EMPTY, nmiPending: true, nmiBlocked: blocked },
            });
            const before = cpu.readState();
            const result = await cpu.run({
              budget: 0n,
              stop: 0x1000n,
              eventDelivery: { budget: 1n },
            });
            equal(
              result.reason,
              'shutdown',
              'ineligible NMI cannot restore initial execution gates',
            );
            equal(result.deliveryAttempts, 0n, 'no attempt');
            same(result.state, before, 'complete terminal checkpoint retained');
          });
        }
      },
    },
  ];
}
