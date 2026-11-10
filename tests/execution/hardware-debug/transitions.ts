import {
  using,
  snapshot,
  initial,
  loadedCode,
  loadedData,
  withGate,
  gate,
  CODE32,
  DATA32,
  STACK,
  FILL,
  image,
  equal,
  same,
  type Scenario,
} from '../exception-delivery/fixture.js';
export function transitionScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'hardware debug deferred HLT publishes before halted activity and queued NMI with the last allowance',
      async run() {
        for (const delivery of [false, true])
          await using(compiler, 'f4', snapshot(), async (cpu) => {
            cpu.setState({
              ...initial(0x1000n, {}, 0x202n, { sti: false, ss: true }),
              debugContinuation: { breakpoints: 2, originPc: 0xff0n },
              interrupts: { irq: null, nmiPending: true, nmiBlocked: false },
            });
            const r = await cpu.run({
              budget: 1n,
              ...(delivery ? { eventDelivery: { budget: 0n } } : {}),
            });
            equal(r.reason, delivery ? 'event-budget' : 'debug-exception', 'selected source wins');
            equal(r.retired, 1n, 'HLT retired');
            equal(r.state.rip, 0x1001n, 'HALT successor');
            equal(r.state.event.kind, delivery ? 'pending' : 'ready', 'no stale halted state');
            equal(r.state.interrupts.nmiPending, true, 'NMI still queued');
            equal(cpu.readDebugState().dr6, 0xffff0ff2n, 'historical slot published');
          });
      },
    },
    {
      name: 'hardware debug deferred software trap captures the transitioned handler boundary and INT1 cancels only after success',
      async run() {
        for (const kind of ['cc', 'f1'] as const) {
          const c = snapshot('protected');
          c.segments.cs = loadedCode(32);
          c.segments.ss = loadedData(32);
          const a = withGate(c, kind === 'cc' ? 3 : 1);
          await using(
            compiler,
            kind,
            c,
            async (cpu) => {
              cpu.setDebugState({ addresses: [0n, 0n, 0n, 0n], dr6: 0n, dr7: 0x2400n });
              cpu.setState({
                ...initial(0x1000n, { 4: 0x8000n }, 0x202n, { sti: false, ss: true }),
                debugContinuation: { breakpoints: 4, originPc: 0xff0n },
              });
              const r = await cpu.run({ budget: 1n, stop: 0x2000n, eventDelivery: { budget: 0n } });
              equal(
                r.reason,
                kind === 'cc' ? 'event-budget' : 'budget',
                'post-entry trap priority',
              );
              equal(r.retired, 1n, 'software instruction charged once');
              equal(r.state.rip, 0x2000n, 'software target');
              equal(r.state.registers[4], 0x7ff4n, 'first frame committed');
              same(
                cpu.readMemory(0x7ff4n, 12),
                image([0x1001n, 8n, 0x202n], 4),
                'literal software frame',
              );
              equal(r.state.debugContinuation, undefined, 'history consumed or canceled');
              if (kind === 'cc') {
                same(
                  r.state.event,
                  {
                    kind: 'pending',
                    exception: {
                      vector: 1,
                      instructionPc: 0x1000n,
                      returnPc: 0x2000n,
                      savedFlags: 2n,
                      debug: {
                        class: 'trap',
                        cause: 'data-breakpoint',
                        breakpoints: 4,
                        singleStep: false,
                        instructionCompleted: true,
                        deferredOriginPc: 0xff0n,
                      },
                    },
                  },
                  'new-boundary source',
                );
                equal(cpu.readDebugState().dr7, 0x2400n, 'no automatic DB entry yet');
              } else {
                equal(cpu.readDebugState().dr6, 0xffff0ff0n, 'INT1 creates no DR6 cause');
                equal(cpu.readDebugState().dr7, 0x400n, 'successful software INT1 clears GD');
              }
            },
            {
              data: [
                { base: 0x4008n, bytes: CODE32 + DATA32 },
                { base: a, bytes: gate(32, 8, 0x2000n, 0) },
                { base: 0x2000n, bytes: '90', execute: true },
                { base: STACK, bytes: FILL },
              ],
            },
          );
        }
      },
    },
    {
      name: 'hardware debug INT1 private refusal retains historical data and GD for guest repair',
      async run() {
        const c = snapshot('protected');
        withGate(c, 1);
        await using(compiler, 'f1', c, async (cpu) => {
          cpu.setDebugState({ addresses: [0n, 0n, 0n, 0n], dr6: 0n, dr7: 0x2400n });
          const before = {
            ...initial(0x1000n, { 4: 0x8000n }, 0x202n, { sti: false, ss: true }),
            debugContinuation: { breakpoints: 8, originPc: 0xff0n },
          };
          cpu.setState(before);
          const r = await cpu.run({ budget: 1n });
          equal(r.reason, 'system-memory-fault', 'private IDT refusal');
          equal(r.retired, 0n, 'software entry uncommitted');
          same(r.state.debugContinuation, before.debugContinuation, 'historical cause survives');
          equal(cpu.readDebugState().dr7, 0x2400n, 'GD stays armed');
          equal(cpu.readDebugState().dr6, 0xffff0ff0n, 'no canceled source status');
        });
      },
    },
  ];
}
