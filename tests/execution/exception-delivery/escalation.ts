import {
  using,
  snapshot,
  initial,
  loadedCode,
  loadedData,
  withGate,
  gate,
  hex,
  CODE32,
  DATA32,
  STACK,
  FILL,
  image,
  same,
  equal,
  ready,
  delivery,
  type Scenario,
} from './fixture.js';

function absentGate(): string {
  const value = gate(32, 8, 0x2000n, 0);
  return value.slice(0, 10) + '0e' + value.slice(12);
}

export function escalationScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'contributory entry failure stages #DF before an exhausted delivery allowance and later writes its zero code',
      async run() {
        const execution = snapshot('protected');
        execution.segments.cs = loadedCode(32);
        execution.segments.ss = loadedData(32);
        const address = withGate(execution, 0);
        await using(
          compiler,
          'f7f1',
          execution,
          async (cpu) => {
            cpu.setState(initial(0x1000n, { 0: 6n, 1: 0n, 2: 0n, 4: 0x8000n }, 0x202n));
            const staged = await cpu.run({ budget: 1n, exceptionDelivery: { budget: 1n } });
            delivery(staged, 'event-budget', 0n, 1n, 0n);
            same(
              staged.state.event,
              {
                kind: 'pending',
                exception: {
                  vector: 8,
                  instructionPc: 0x1000n,
                  returnPc: 0x1000n,
                  savedFlags: 0x10202n,
                  errorCode: 0,
                },
              },
              'double fault retains original inspectable boundary',
            );
            equal(staged.state.registers[4], 0x8000n, 'failed first entry retains stack');
            same(cpu.readMemory(STACK, 256), new Uint8Array(256).fill(0xa5), 'no half entry');
            const entered = await cpu.run({
              budget: 1n,
              stop: 0x3000n,
              exceptionDelivery: { budget: 1n },
            });
            delivery(entered, 'stop', 0n, 1n, 0n);
            ready(entered);
            same(
              cpu.readMemory(0x7ff0n, 16),
              image([0n, 0x1000n, 8n, 0x10202n], 4),
              '#DF zero code and original source',
            );
          },
          {
            data: [
              { base: 0x4008n, bytes: CODE32 + DATA32 },
              { base: address, bytes: absentGate() },
              { base: 0x8040n, bytes: gate(32, 8, 0x3000n, 0) },
              { base: STACK, bytes: FILL },
            ],
          },
        );
      },
    },
    {
      name: 'benign trap entry failure delivers its secondary #NP with EXT instead of immediately escalating',
      async run() {
        const execution = snapshot('protected');
        execution.segments.cs = loadedCode(32);
        execution.segments.ss = loadedData(32);
        const address = withGate(execution, 1);
        await using(
          compiler,
          '90',
          execution,
          async (cpu) => {
            cpu.setState(initial(0x1000n, { 4: 0x8000n }, 0x302n));
            const staged = await cpu.run({ budget: 1n, exceptionDelivery: { budget: 1n } });
            delivery(staged, 'event-budget', 1n, 1n, 0n);
            same(
              staged.state.event,
              {
                kind: 'pending',
                exception: {
                  vector: 11,
                  instructionPc: 0x1000n,
                  returnPc: 0x1001n,
                  savedFlags: 0x10302n,
                  errorCode: 11,
                },
              },
              'secondary #NP retains completed trap continuation and IDT EXT',
            );
            equal(staged.state.rip, 0x1001n, 'completed NOP is never replayed');
            const entered = await cpu.run({
              budget: 1n,
              stop: 0x3000n,
              exceptionDelivery: { budget: 1n },
            });
            delivery(entered, 'stop', 0n, 1n, 0n);
            ready(entered);
            same(
              cpu.readMemory(0x7ff0n, 16),
              image([11n, 0x1001n, 8n, 0x10302n], 4),
              'secondary fault frame with exact EXT code',
            );
          },
          {
            data: [
              { base: 0x4008n, bytes: CODE32 + DATA32 },
              { base: address, bytes: absentGate() },
              { base: 0x8058n, bytes: gate(32, 8, 0x3000n, 0) },
              { base: STACK, bytes: FILL },
            ],
          },
        );
      },
    },
    {
      name: 'architectural failure during #DF retains shutdown while missing private backing remains repairable',
      async run() {
        for (const missing of [false, true]) {
          const execution = snapshot('protected');
          execution.segments.cs = loadedCode(32);
          execution.segments.ss = loadedData(32);
          const address = withGate(execution, 0);
          await using(
            compiler,
            'f7f1',
            execution,
            async (cpu) => {
              cpu.setState(initial(0x1000n, { 0: 6n, 1: 0n, 2: 0n, 4: 0x8000n }, 0x202n));
              const result = await cpu.run({ budget: 1n, exceptionDelivery: { budget: 2n } });
              delivery(result, missing ? 'system-memory-fault' : 'shutdown', 0n, 2n, 0n);
              if (missing) {
                same(
                  result.state.event,
                  {
                    kind: 'pending',
                    exception: {
                      vector: 8,
                      instructionPc: 0x1000n,
                      returnPc: 0x1000n,
                      savedFlags: 0x10202n,
                      errorCode: 0,
                    },
                  },
                  'private refusal preserves pending #DF',
                );
                equal(result.systemMemoryFault?.table, 'idt', 'missing #DF gate provenance');
                equal(result.systemMemoryFault?.address, 0x8040n, 'unmapped #DF gate address');
              } else {
                same(result.state.event, { kind: 'shutdown' }, 'retained shutdown');
                const again = await cpu.run({
                  budget: 0n,
                  stop: 0x1000n,
                  exceptionDelivery: { budget: 4n },
                });
                delivery(again, 'shutdown', 0n, 0n, 4n);
                cpu.setState(initial(0x1000n, { 0: 6n, 1: 0n, 2: 0n, 4: 0x8000n }, 0x202n));
                const reported = await cpu.run({ budget: 1n });
                equal(
                  reported.reason,
                  'divide-error',
                  'explicit scalar replacement leaves shutdown',
                );
                ready(reported);
              }
              same(
                cpu.readMemory(STACK, 256),
                new Uint8Array(256).fill(0xa5),
                'all failed admissions leave guards untouched',
              );
              same(cpu.readMemory(address, 8), hex(absentGate()), 'gate remains unchanged');
            },
            {
              data: [
                { base: 0x4008n, bytes: CODE32 + DATA32 },
                { base: address, bytes: absentGate() },
                ...(missing ? [] : [{ base: 0x8040n, bytes: absentGate() }]),
                { base: STACK, bytes: FILL },
              ],
            },
          );
        }
      },
    },
  ];
}
