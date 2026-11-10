import {
  using,
  execution,
  input,
  same,
  equal,
  gate,
  image,
  DESCRIPTORS,
  STACK,
  FILL,
  EMPTY,
  type Scenario,
} from './fixture.js';

export function cacheScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'external frame executable aliases invalidate warmed middle entries before return execution',
      async run() {
        await using(
          compiler,
          '90'.repeat(16),
          execution(),
          async (cpu) => {
            cpu.setState(input());
            await cpu.run({ budget: 1n });
            equal(cpu.inspectTranslations().length, 1, 'plain source and middle entries warmed');
            cpu.setMappings([
              {
                base: 0x1000n,
                backing: 'code',
                offset: 0,
                length: 16,
                permissions: { read: true, write: false, execute: true },
              },
              {
                base: 0x7ff4n,
                backing: 'code',
                offset: 0,
                length: 12,
                permissions: { read: true, write: true, execute: false },
              },
              {
                base: 0x4008n,
                backing: 'data0',
                offset: 0,
                length: 16,
                permissions: { read: true, write: true, execute: false },
              },
              {
                base: 0x8010n,
                backing: 'data1',
                offset: 0,
                length: 8,
                permissions: { read: true, write: true, execute: false },
              },
              {
                base: 0x2000n,
                backing: 'data2',
                offset: 0,
                length: 1,
                permissions: { read: true, write: true, execute: true },
              },
            ]);
            cpu.setState(input(0x1000n, { 0: 0n, 4: 0x8000n }, 2n, { sti: false, ss: true }));
            cpu.requestNmi();
            const entered = await cpu.run({
              budget: 2n,
              stop: 0x2000n,
              eventDelivery: { budget: 1n },
            });
            equal(entered.reason, 'stop', 'source NOP completes before accepted NMI');
            equal(entered.retired, 1n, 'one source retirement');
            equal(
              entered.resources.cachedArtifacts,
              0,
              'frame invalidates active and warmed source owners',
            );
            same(
              cpu.readMemory(0x1000n, 12),
              image([0x1001n, 8n, 2n], 4),
              'literal frame overwrote source backing',
            );
            const returned = await cpu.run({ budget: 1n });
            equal(returned.state.rip, 0x1001n, 'IRET targets overwritten middle entry');
            const resumed = await cpu.run({ budget: 1n });
            equal(
              resumed.reason,
              'data-fault',
              'changed ADC [EAX],AL bytes execute instead of cached NOP',
            );
            equal(resumed.retired, 0n, 'stale NOP cannot retire');
          },
          {
            data: [
              DESCRIPTORS,
              { base: 0x8010n, bytes: gate(32, 8, 0x2000n, 0) },
              { base: 0x2000n, bytes: 'cf', execute: true },
            ],
          },
        );
      },
    },
    {
      name: 'external committed entry survives handler translation refusal and resumed IRET without frame replay',
      async run() {
        await using(
          compiler,
          '9090',
          execution(),
          async (cpu) => {
            cpu.setState(input(0x1000n, { 4: 0x8000n }, 2n, { sti: false, ss: true }));
            cpu.requestNmi();
            const entered = await cpu.run({ budget: 2n, eventDelivery: { budget: 1n } });
            equal(entered.reason, 'resource-limit', 'source translation used the only allowance');
            equal(entered.retired, 1n, 'source NOP completed');
            equal(entered.deliveryAttempts, 1n, 'entry committed once');
            same(entered.state.event, { kind: 'ready' }, 'delivery already completed');
            same(
              entered.state.interrupts,
              { ...EMPTY, nmiBlocked: true },
              'NMI blocking survives translation refusal',
            );
            const frame = image([0x1001n, 8n, 2n], 4);
            same(cpu.readMemory(0x7ff4n, 12), frame, 'one committed frame');
            const returned = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
            equal(returned.reason, 'budget', 'IRET can run with no automatic allowance');
            equal(returned.deliveryAttempts, 0n, 'completed frame never re-entered');
            equal(returned.state.registers[4], 0x8000n, 'exact stack restoration');
            const resumed = await cpu.run({ budget: 1n });
            equal(resumed.state.rip, 0x1002n, 'remaining NOP executes once');
            same(cpu.readMemory(0x7ff4n, 12), frame, 'no frame replay on either resume');
          },
          {
            limits: { maxTranslationsPerRun: 1, maxCachedArtifacts: 1 },
            data: [
              DESCRIPTORS,
              { base: STACK, bytes: FILL },
              { base: 0x8010n, bytes: gate(32, 8, 0x2000n, 0) },
              { base: 0x2000n, bytes: 'cf', execute: true },
            ],
          },
        );
      },
    },
  ];
}
