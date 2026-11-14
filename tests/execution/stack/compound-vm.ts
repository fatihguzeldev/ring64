import {
  using,
  snapshot,
  initial,
  loadedCode,
  loadedData,
  CODE32,
  DATA32,
  TSS,
  gate,
  withGate,
  image,
  hex,
  same,
  equal,
  type Scenario,
} from '../software-events/fixture.js';

export function compoundVmScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'compound virtual8086 small-stack SS and GP use the ordinary CPL3 to CPL0 TSS route instead of real shutdown',
      async run() {
        for (const sp of [3n, 7n])
          for (const allowance of [0n, 1n]) {
            const execution = snapshot('virtual8086');
            execution.tr = { ...TSS };
            const vector = sp === 3n ? 12 : 13;
            const gateAddress = withGate(execution, vector);
            await using(
              compiler,
              '60',
              execution,
              async (cpu) => {
                const before = initial(
                  0x1000n,
                  { 0: 0x1122334455667788n, 4: 0x11223344abcd0000n + sp },
                  0x3002n,
                );
                cpu.setState(before);
                cpu.setTimeState({ tsc: 100n, tscAux: 0x89abcdef });
                const result = await cpu.run({
                  budget: 1n,
                  repeatBudget: 0n,
                  stop: 0x2000n,
                  eventDelivery: { budget: allowance },
                });
                equal(
                  result.reason,
                  allowance === 0n ? 'event-budget' : 'stop',
                  'VM source delivery gate',
                );
                equal(result.retired, 0n, 'failed PUSHA has no retirement');
                equal(
                  result.deliveryAttempts,
                  allowance,
                  'VM only consumes admitted entry attempt',
                );
                same(
                  cpu.readTimeState(),
                  { tsc: 100n, tscAux: 0x89abcdef },
                  'VM entry adds no virtual instruction',
                );
                const oldStack = new Uint8Array(16).fill(0xa5);
                if (sp === 3n) oldStack.set(hex('8877'), 1);
                same(cpu.readMemory(0n, 16), oldStack, 'VM ordered prefix or pre-payload GP');
                if (allowance === 0n) {
                  same(
                    result.state,
                    {
                      ...before,
                      event: {
                        kind: 'pending',
                        exception: {
                          vector,
                          instructionPc: 0x1000n,
                          returnPc: 0x1000n,
                          savedFlags: 0x33002n,
                          errorCode: 0,
                        },
                      },
                    },
                    'VM source stays pending with original raw SP',
                  );
                  same(cpu.readContext(), execution, 'pending source does not change VM context');
                } else {
                  same(
                    result.state,
                    {
                      ...before,
                      registers: before.registers.map((value, bank) =>
                        bank === 4 ? 0x7058n : value,
                      ),
                      rip: 0x2000n,
                      event: { kind: 'ready' },
                    },
                    'VM fault entry chooses TSS kernel stack',
                  );
                  same(
                    cpu.readMemory(0x7058n, 40),
                    image([0n, 0x1000n, 0n, 0x33002n, 0xabcd0000n + sp, 0n, 0n, 0n, 0n, 0n], 4),
                    'literal ten-slot VM fault frame',
                  );
                  const segments = {
                    ...execution.segments,
                    cs: loadedCode(32),
                    ss: loadedData(32),
                  };
                  for (const name of ['es', 'ds', 'fs', 'gs'] as const)
                    segments[name] = { ...segments[name], selector: 0, usable: false };
                  same(
                    cpu.readContext(),
                    { ...execution, mode: 'protected', cpl: 0, segments },
                    'VM entry complete loaded-cache publication',
                  );
                }
              },
              {
                data: [
                  { base: 0n, bytes: 'a5'.repeat(16) },
                  { base: 0x4008n, bytes: CODE32 + DATA32 },
                  { base: gateAddress, bytes: gate(32, 8, 0x2000n, 0), write: false },
                  { base: 0x5004n, bytes: '807000001000', write: false },
                  { base: 0x6f80n, bytes: 'a5'.repeat(256) },
                ],
              },
            );
          }
      },
    },
  ];
}
