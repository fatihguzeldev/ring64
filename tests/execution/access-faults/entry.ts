import {
  using,
  snapshot,
  initial,
  loadedCode,
  loadedData,
  withGate,
  gate,
  CODE32,
  CODE64,
  DATA32,
  STACK,
  FILL,
  same,
  equal,
  delivery,
  type Scenario,
} from '../exception-delivery/fixture.js';

export function entryScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'architectural access stack admission selects secondary SS then DF and shutdown without a half frame',
      async run() {
        for (const benign of [false, true]) {
          const execution = snapshot('protected');
          execution.segments.cs = loadedCode(32);
          execution.segments.ss = loadedData(32);
          execution.segments.ss.limit = 0x7ff7;
          const address = withGate(execution, benign ? 6 : 13);
          await using(
            compiler,
            benign ? 'f090' : '0f2803',
            execution,
            async (cpu) => {
              cpu.setState(initial(0x1000n, { 3: 0x6001n, 4: 0x8000n }, 0x202n));
              const first = await cpu.run({ budget: 1n, eventDelivery: { budget: 1n } });
              delivery(first, 'event-budget', 0n, 1n, 0n);
              same(
                first.state.event,
                {
                  kind: 'pending',
                  exception: {
                    vector: benign ? 12 : 8,
                    instructionPc: 0x1000n,
                    returnPc: 0x1000n,
                    savedFlags: 0x10202n,
                    errorCode: 0,
                  },
                },
                'benign replacement versus contributory escalation',
              );
              same(
                cpu.readMemory(STACK, 256),
                new Uint8Array(256).fill(0xa5),
                'atomic failed frame',
              );
              const result = await cpu.run({
                budget: 1n,
                eventDelivery: { budget: benign ? 2n : 1n },
              });
              equal(result.reason, 'shutdown', 'contributory failure during DF entry');
              same(result.state.event, { kind: 'shutdown' }, 'terminal double-fault state');
              same(
                cpu.readMemory(STACK, 256),
                new Uint8Array(256).fill(0xa5),
                'no writes after escalation',
              );
            },
            {
              data: [
                { base: 0x4008n, bytes: CODE32 + DATA32 },
                { base: address, bytes: gate(32, 8, 0x2000n, 0) },
                ...(benign ? [{ base: 0x8060n, bytes: gate(32, 8, 0x2000n, 0) }] : []),
                { base: 0x8040n, bytes: gate(32, 8, 0x2000n, 0) },
                { base: STACK, bytes: FILL },
              ],
            },
          );
        }
      },
    },
    {
      name: 'architectural access noncanonical IDT NMI entry retains blocking and a hard-zero benign secondary',
      async run() {
        for (const overflow of [false, true]) {
          const execution = snapshot();
          execution.segments.cs = loadedCode(64);
          execution.segments.ss = loadedData(32);
          execution.idtr = { base: overflow ? 0xfffffffffffffff0n : 0x7ffffffffff0n, limit: 0xfff };
          await using(
            compiler,
            '90',
            execution,
            async (cpu) => {
              cpu.setState(initial(0x1000n, { 4: 0x8000n }, 0x202n));
              cpu.requestNmi();
              const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 1n } });
              delivery(result, overflow ? 'system-memory-fault' : 'event-budget', 0n, 1n, 0n);
              equal(result.state.interrupts.nmiBlocked, true, 'accepted NMI remains blocked');
              if (overflow) {
                equal(result.systemMemoryFault?.cause, 'address-range', 'widened domain refusal');
                equal(
                  result.state.event.kind,
                  'pending-interrupt',
                  'private failure retains original NMI',
                );
              } else
                same(
                  result.state.event,
                  {
                    kind: 'pending',
                    exception: {
                      vector: 13,
                      instructionPc: 0x1000n,
                      returnPc: 0x1000n,
                      savedFlags: 0x10202n,
                      errorCode: 0,
                    },
                  },
                  'NMI source is benign even though its number is 2',
                );
              same(cpu.readMemory(STACK, 256), new Uint8Array(256).fill(0xa5), 'no half frame');
            },
            { data: [{ base: STACK, bytes: FILL }] },
          );
        }
      },
    },
    {
      name: 'architectural access in-domain noncanonical descriptor reads select GP but widened overflow remains private',
      async run() {
        for (const overflow of [false, true]) {
          const execution = snapshot();
          execution.gdtr = { base: overflow ? 0xfffffffffffffff8n : 0x7ffffffffff8n, limit: 0x7f };
          await using(compiler, '8ed8', execution, async (cpu) => {
            cpu.setState(initial(0x1000n, { 0: 16n }));
            const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
            equal(result.reason, overflow ? 'system-memory-fault' : 'event-budget', 'GDT geometry');
            if (!overflow)
              equal(
                result.state.event.kind === 'pending' && result.state.event.exception.vector,
                13,
                'descriptor GP0',
              );
          });
        }
      },
    },
  ];
}
