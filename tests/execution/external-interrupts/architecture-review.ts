import {
  using,
  execution,
  input,
  snapshot,
  same,
  equal,
  gate,
  image,
  encoded,
  throws,
  DESCRIPTORS,
  STACK,
  FILL,
  EMPTY,
  type Scenario,
} from './fixture.js';

export function architectureReviewScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'external VM RF checkpoint preserves a frozen IRQ across later NMI and rejects incompatible host context images',
      async run() {
        const context = snapshot('virtual8086');
        context.idtr = { base: 0x8000n, limit: 0x7ff };
        context.tr = { selector: 0x28, valid: true, base: 0x5000n, limit: 0x67, attributes: 0x8b };
        await using(
          compiler,
          '90',
          context,
          async (cpu) => {
            cpu.setState(input(0x1100n, { 4: 0x11223344abcd7020n }, 0x10202n));
            cpu.requestInterrupt(0x20);
            const accepted = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
            equal(accepted.reason, 'event-budget', 'capture precedes entry and source fetch');
            equal(accepted.deliveryAttempts, 0n, 'no attempt');
            equal(accepted.state.flags, 0x10202n, 'before-instruction RF stays live');
            same(
              accepted.state.event,
              {
                kind: 'pending-interrupt',
                interrupt: {
                  source: { kind: 'irq', vector: 0x20 },
                  returnPc: 0x1100n,
                  savedFlags: 0x30202n,
                },
              },
              'saved VM is derived while incoming RF is preserved',
            );
            cpu.requestInterrupt(0x21);
            cpu.requestNmi();
            const checkpoint = cpu.readState();
            cpu.setContext(execution());
            const replacement = cpu.readState();
            same(replacement.event, { kind: 'ready' }, 'host context cancels the captured source');
            same(
              replacement.interrupts,
              { ...EMPTY, irq: 0x21, nmiPending: true },
              'uncaptured requests retain CPU identity',
            );
            throws(() => cpu.setState(checkpoint), 'saved VM cannot be restored in protected mode');
            same(cpu.readState(), replacement, 'rejected old-context image publishes nothing');
            same(cpu.readContext(), execution(), 'failed scalar import preserves current context');
            cpu.setContext(context);
            cpu.setState(checkpoint);
            same(
              cpu.readState(),
              checkpoint,
              'context then complete checkpoint restores the source',
            );
            if (checkpoint.event.kind !== 'pending-interrupt')
              throw new Error('expected accepted IRQ checkpoint');
            for (const changed of [
              { ...checkpoint, flags: 0x202n },
              {
                ...checkpoint,
                event: {
                  kind: 'pending-interrupt',
                  interrupt: { ...checkpoint.event.interrupt, savedFlags: 0x20202n },
                },
              },
              {
                ...checkpoint,
                event: {
                  kind: 'pending-interrupt',
                  interrupt: { ...checkpoint.event.interrupt, savedFlags: 0x10202n },
                },
              },
            ]) {
              throws(() => cpu.setState(changed as never), 'captured RF/VM must match publication');
              same(cpu.readState(), checkpoint, 'RF/VM rejection preserves both queues and event');
            }
            const entered = await cpu.run({
              budget: 1n,
              stop: 0x2000n,
              eventDelivery: { budget: 1n },
            });
            equal(
              entered.reason,
              'stop',
              'handler gate precedes new NMI and unmapped handler fetch',
            );
            equal(entered.retired, 0n, 'frozen entry executes no guest instruction');
            equal(entered.deliveryAttempts, 1n, 'frozen IRQ wins over later queued NMI');
            equal(entered.state.flags, 2n, 'handler clears RF and IF');
            same(
              entered.state.interrupts,
              replacement.interrupts,
              'later requests remain unaccepted',
            );
            same(
              cpu.readMemory(0x7f5cn, 36),
              image([0x1100n, 0n, 0x30202n, 0xabcd7020n, 0n, 0n, 0n, 0n, 0n], 4),
              'literal VM frame contains captured RF and VM without an error slot',
            );
          },
          {
            data: [
              DESCRIPTORS,
              { base: STACK, bytes: FILL },
              { base: 0x8100n, bytes: gate(32, 8, 0x2000n, 0) },
              { base: 0x5004n, bytes: encoded(image([0x7f80n], 4)) + '1000' },
            ],
          },
        );
      },
    },
    {
      name: 'external blocked NMI survives software INT RETF and an intervening IRQ entry',
      async run() {
        await using(
          compiler,
          'cd2090',
          execution(),
          async (cpu) => {
            const retained = { ...EMPTY, nmiPending: true, nmiBlocked: true };
            cpu.setState({
              ...input(0x1000n, { 4: 0x8000n }, 0x202n),
              interrupts: retained,
            });
            const software = await cpu.run({
              budget: 1n,
              stop: 0x2000n,
              eventDelivery: { budget: 1n },
            });
            equal(software.reason, 'budget', 'software INT retires before handler gates');
            equal(software.deliveryAttempts, 0n, 'software INT is ordinary instruction work');
            equal(software.state.rip, 0x2000n, 'trap gate handler');
            equal(software.state.flags, 0x202n, 'trap gate retains IF');
            same(software.state.interrupts, retained, 'software INT cannot unblock NMI');
            same(cpu.readMemory(0x7ff4n, 12), image([0x1002n, 8n, 0x202n], 4), 'software frame');
            const returned = await cpu.run({ budget: 1n, eventDelivery: { budget: 1n } });
            equal(returned.reason, 'budget', 'RETF completes');
            equal(returned.deliveryAttempts, 0n, 'latched NMI remains blocked through RETF');
            equal(returned.state.rip, 0x1002n, 'far return continuation');
            equal(returned.state.registers[4], 0x7ffcn, 'RETF consumes only PC and CS');
            same(returned.state.interrupts, retained, 'RETF cannot substitute for IRET unblock');
            cpu.requestInterrupt(0x21);
            const irq = await cpu.run({
              budget: 1n,
              stop: 0x3000n,
              eventDelivery: { budget: 1n },
            });
            equal(irq.reason, 'stop', 'eligible IRQ can enter while true NMI is blocked');
            equal(irq.retired, 0n, 'source successor is not executed');
            equal(irq.deliveryAttempts, 1n, 'one IRQ attempt');
            same(irq.state.interrupts, retained, 'IRQ entry preserves NMI blocking and latch');
            same(
              cpu.readMemory(0x7ff0n, 12),
              image([0x1002n, 8n, 0x202n], 4),
              'IRQ begins from completed RETF stack without an error slot',
            );
          },
          {
            data: [
              DESCRIPTORS,
              { base: STACK, bytes: FILL },
              { base: 0x8100n, bytes: gate(32, 8, 0x2000n, 0, true) },
              { base: 0x8108n, bytes: gate(32, 8, 0x3000n, 0) },
              { base: 0x2000n, bytes: 'cb', execute: true },
            ],
          },
        );
      },
    },
  ];
}
