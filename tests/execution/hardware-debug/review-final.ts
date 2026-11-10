import {
  using,
  snapshot,
  initial,
  loadedCode,
  loadedData,
  CODE64,
  DATA32,
  image,
  encoded,
  hex,
  equal,
  same,
  preserveNumeric,
  type Scenario,
} from '../exception-delivery/fixture.js';

export function finalOwnerReviewScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [false, true].map((invalid) => ({
    name: invalid
      ? 'hardware debug final review invalid IRET target discards deferred and tentative hits before status publication'
      : 'hardware debug final review IRET combines disabled historical slot with current stack hit and TF while preserving restored RF',
    async run() {
      const context = snapshot();
      context.segments.cs = loadedCode(64);
      context.segments.ss = loadedData(32, 16);
      const frame = image([invalid ? 0x800000000000n : 0x2000n, 8n, 0x10202n, 0x7000n, 16n], 8);
      const guardedFrame = 'a5'.repeat(8) + encoded(frame) + 'a5'.repeat(8);
      await using(
        compiler,
        '48cf',
        context,
        async (cpu) => {
          const bank = { addresses: [0n, 0x6020n, 0n, 0n], dr6: 0n, dr7: 0xb00404n };
          cpu.setDebugState(bank);
          cpu.setState({
            ...initial(0x1000n, { 4: 0x6000n }, 0x302n, { sti: false, ss: true }),
            debugContinuation: { breakpoints: 1, originPc: 0xff0n },
            interrupts: { irq: null, nmiPending: false, nmiBlocked: true },
          });
          const before = cpu.readState();
          const beforeContext = cpu.readContext();
          const numeric = preserveNumeric(cpu);
          const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
          equal(result.reason, 'event-budget', 'selected source precedes budget');
          equal(result.retired, invalid ? 0n : 1n, 'retirement');
          equal(result.remaining, invalid ? 1n : 0n, 'remaining instruction allowance');
          equal(result.repeatIterations, 0n, 'no repeat work');
          equal(result.remainingRepeatBudget, 1n, 'repeat allowance untouched');
          equal(result.deliveryAttempts, 0n, 'selected source needs no entry attempt');
          equal(result.remainingDeliveryBudget, 0n, 'entry allowance untouched');
          same(
            result.state,
            {
              registers: before.registers.map((value, index) =>
                !invalid && index === 4 ? 0x7000n : value,
              ),
              flags: invalid ? 0x302n : 0x10202n,
              rip: invalid ? 0x1000n : 0x2000n,
              interruptibility: { sti: false, ss: invalid },
              interrupts: { irq: null, nmiPending: false, nmiBlocked: false },
              event: {
                kind: 'pending',
                exception: invalid
                  ? {
                      vector: 13,
                      instructionPc: 0x1000n,
                      returnPc: 0x1000n,
                      savedFlags: 0x10302n,
                      errorCode: 0,
                    }
                  : {
                      vector: 1,
                      instructionPc: 0x1000n,
                      returnPc: 0x2000n,
                      savedFlags: 0x10202n,
                      debug: {
                        class: 'trap',
                        cause: 'data-breakpoint',
                        breakpoints: 3,
                        singleStep: true,
                        instructionCompleted: true,
                        deferredOriginPc: 0xff0n,
                      },
                    },
              },
            },
            'complete scalar source, consumed history, restored RF and early NMI unblock',
          );
          same(cpu.readContext(), beforeContext, 'same-context return or uncommitted target fault');
          same(
            cpu.readDebugState(),
            { ...bank, dr6: invalid ? 0xffff0ff0n : 0xffff4ff3n },
            'only selected current and historical causes update status',
          );
          same(
            cpu.readMemory(0x5ff8n, 56),
            hex(guardedFrame),
            'whole source frame and guards unchanged',
          );
          cpu.setState(result.state);
          same(cpu.readState(), result.state, 'exact pending checkpoint round trip');
          numeric();
        },
        {
          data: [
            { base: 0x4008n, bytes: CODE64 + DATA32 },
            { base: 0x5ff8n, bytes: guardedFrame },
          ],
        },
      );
    },
  }));
}
