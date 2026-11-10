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
  delivery,
  type Scenario,
} from '../exception-delivery/fixture.js';
export function recoveryScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'hardware debug execute handler sets saved RF and IRET retries without disabling the comparator',
      async run() {
        const c = snapshot('protected');
        c.segments.cs = loadedCode(32);
        c.segments.ss = loadedData(32);
        const a = withGate(c, 1);
        await using(
          compiler,
          '9082',
          c,
          async (cpu) => {
            cpu.setDebugState({ addresses: [0x1000n, 0n, 0n, 0n], dr6: 0n, dr7: 0x401n });
            cpu.setState(initial(0x1000n, { 4: 0x8000n }, 0x202n));
            const r = await cpu.run({ budget: 3n, eventDelivery: { budget: 2n } });
            delivery(r, 'budget', 3n, 1n, 1n);
            equal(r.state.rip, 0x1001n, 'exact retried NOP continuation');
            equal(r.state.flags, 0x202n, 'retry consumes RF');
            equal(cpu.readDebugState().dr7, 0x401n, 'comparator remains installed');
            same(
              cpu.readMemory(0x7ff4n, 12),
              image([0x1000n, 8n, 0x10202n], 4),
              'handler edited only saved RF',
            );
          },
          {
            data: [
              { base: 0x4008n, bytes: CODE32 + DATA32 },
              { base: a, bytes: gate(32, 8, 0x2000n, 0) },
              { base: 0x2000n, bytes: '814c240800000100cf', execute: true },
              { base: STACK, bytes: FILL },
            ],
          },
        );
      },
    },
    {
      name: 'hardware debug GD status precedes admission and successful entry lets the guest clear status and retry MOVDR',
      async run() {
        const c = snapshot('protected');
        c.segments.cs = loadedCode(32);
        c.segments.ss = loadedData(32);
        const a = withGate(c, 1);
        await using(
          compiler,
          '0f21c0',
          c,
          async (cpu) => {
            cpu.setDebugState({ addresses: [0n, 0n, 0n, 0n], dr6: 0n, dr7: 0x2400n });
            cpu.setState(initial(0x1000n, { 4: 0x8000n }, 0x202n));
            const staged = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
            equal(staged.reason, 'event-budget', 'GD staged');
            equal(cpu.readDebugState().dr6, 0xffff2ff0n, 'BD published before entry');
            equal(cpu.readDebugState().dr7, 0x2400n, 'GD retained until entry');
            same(
              staged.state.event,
              {
                kind: 'pending',
                exception: {
                  vector: 1,
                  instructionPc: 0x1000n,
                  returnPc: 0x1000n,
                  savedFlags: 0x10202n,
                  debug: { class: 'fault', cause: 'general-detect' },
                },
              },
              'GD fault source',
            );
            const r = await cpu.run({ budget: 5n, eventDelivery: { budget: 1n } });
            delivery(r, 'budget', 5n, 1n, 0n);
            equal(r.state.rip, 0x1003n, 'MOVDR retried');
            equal(cpu.readDebugState().dr7, 0x400n, 'entry cleared GD');
            equal(cpu.readDebugState().dr6, 0xffff0ff0n, 'guest cleared BD');
          },
          {
            data: [
              { base: 0x4008n, bytes: CODE32 + DATA32 },
              { base: a, bytes: gate(32, 8, 0x2000n, 0) },
              { base: 0x2000n, bytes: '0f21f0b8f00fffff0f23f0cf', execute: true },
              { base: STACK, bytes: FILL },
            ],
          },
        );
      },
    },
  ];
}
