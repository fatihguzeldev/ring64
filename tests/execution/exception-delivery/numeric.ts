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
  same,
  equal,
  ready,
  delivery,
  noDeliveryFault,
  type Scenario,
} from './fixture.js';

export function numericScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'reserved MXCSR #GP has an error slot and handler cleanup permits a repaired fault retry',
      async run() {
        const execution = snapshot('protected');
        execution.segments.cs = loadedCode(32);
        execution.segments.ss = loadedData(32);
        const address = withGate(execution, 13);
        await using(
          compiler,
          '0fae150060000090',
          execution,
          async (cpu) => {
            cpu.setState(initial(0x1000n, { 4: 0x8000n }, 0x202n));
            const entered = await cpu.run({
              budget: 1n,
              stop: 0x2000n,
              exceptionDelivery: { budget: 1n },
            });
            delivery(entered, 'stop', 0n, 1n, 0n);
            ready(entered);
            noDeliveryFault(entered);
            equal(cpu.readMxcsr(), 0x1f80, 'invalid load preserves MXCSR');
            equal(entered.state.registers[4], 0x7ff0n, 'four-dword exception frame');
            same(
              cpu.readMemory(0x7ff0n, 16),
              image([0n, 0x1000n, 8n, 0x10202n], 4),
              'literal #GP(0) frame',
            );
            cpu.writeMemory(0x6000n, image([0x1f80n], 4));
            const repaired = await cpu.run({ budget: 3n, exceptionDelivery: { budget: 1n } });
            delivery(repaired, 'budget', 3n, 0n, 1n);
            ready(repaired);
            equal(repaired.state.rip, 0x1007n, 'retry reaches original instruction continuation');
            equal(repaired.state.registers[4], 0x8000n, 'handler removes error slot before IRET');
            equal(repaired.state.flags, 0x202n, 'saved flags replace cleanup arithmetic');
          },
          {
            data: [
              { base: 0x4008n, bytes: CODE32 + DATA32 },
              { base: address, bytes: gate(32, 8, 0x2000n, 0), write: false },
              { base: 0x2000n, bytes: '83c404cf', execute: true },
              { base: 0x6000n, bytes: '00000100' },
              { base: STACK, bytes: FILL },
            ],
          },
        );
      },
    },
    {
      name: 'x87 #MF saves the waiting checker PC while the handler clears deferred producer status',
      async run() {
        const execution = snapshot('protected');
        execution.segments.cs = loadedCode(32);
        execution.segments.ss = loadedData(32);
        const address = withGate(execution, 16);
        await using(
          compiler,
          '9b90',
          execution,
          async (cpu) => {
            const numeric = cpu.readX87State();
            cpu.setX87State({
              ...numeric,
              controlWord: 0x37e,
              statusWord: 0x8081,
              instructionPointer: 0x4444n,
              dataPointer: 0x5555n,
              opcode: 0x123,
            });
            cpu.setState(initial(0x1000n, { 4: 0x8000n }, 0x202n));
            const staged = await cpu.run({ budget: 1n, exceptionDelivery: { budget: 0n } });
            delivery(staged, 'event-budget', 0n, 0n, 0n);
            same(
              staged.state.event,
              {
                kind: 'pending',
                exception: {
                  vector: 16,
                  instructionPc: 0x1000n,
                  returnPc: 0x1000n,
                  savedFlags: 0x10202n,
                },
              },
              'checker source is separate from raw x87 producer',
            );
            equal(cpu.readX87State().instructionPointer, 0x4444n, 'saved producer is retained');
            const result = await cpu.run({ budget: 3n, exceptionDelivery: { budget: 1n } });
            delivery(result, 'budget', 3n, 1n, 0n);
            ready(result);
            equal(result.state.rip, 0x1001n, 'WAIT retry completed after FNCLEX');
            equal(cpu.readX87State().statusWord & 0x80ff, 0, 'handler cleared pending conditions');
            equal(
              cpu.readX87State().instructionPointer,
              0x4444n,
              'handler does not replace producer pointer',
            );
            same(
              cpu.readMemory(0x7ff4n, 12),
              image([0x1000n, 8n, 0x10202n], 4),
              'saved checker fault frame',
            );
          },
          {
            data: [
              { base: 0x4008n, bytes: CODE32 + DATA32 },
              { base: address, bytes: gate(32, 8, 0x2000n, 0), write: false },
              { base: 0x2000n, bytes: 'dbe2cf', execute: true },
              { base: STACK, bytes: FILL },
            ],
          },
        );
      },
    },
    {
      name: 'SIMD #XM publishes MXCSR status and preserves the destination until a handler masks and retries it',
      async run() {
        const execution = snapshot('protected');
        execution.segments.cs = loadedCode(32);
        execution.segments.ss = loadedData(32);
        const address = withGate(execution, 19);
        await using(
          compiler,
          'f30f5ec190',
          execution,
          async (cpu) => {
            const bank = Array.from({ length: 16 }, (_, i) => BigInt(i) << 112n);
            bank[0] = 0x112233445566778899aabbcc3f800000n;
            bank[1] = 0n;
            cpu.setXmmState(bank);
            cpu.setMxcsr(0x1d80);
            cpu.setState(initial(0x1000n, { 4: 0x8000n }, 0x202n));
            const entered = await cpu.run({
              budget: 1n,
              stop: 0x2000n,
              exceptionDelivery: { budget: 1n },
            });
            delivery(entered, 'stop', 0n, 1n, 0n);
            noDeliveryFault(entered);
            equal(cpu.readMxcsr(), 0x1d84, 'unmasked divide status is visible in handler');
            same(cpu.readXmmState(), bank, 'faulting destination and unrelated lanes preserved');
            same(
              cpu.readMemory(0x7ff4n, 12),
              image([0x1000n, 8n, 0x10202n], 4),
              'SIMD retry boundary',
            );
            const result = await cpu.run({ budget: 3n, exceptionDelivery: { budget: 1n } });
            delivery(result, 'budget', 3n, 0n, 1n);
            ready(result);
            const expected = [...bank];
            expected[0] = 0x112233445566778899aabbcc7f800000n;
            same(cpu.readXmmState(), expected, 'masked retry writes only low scalar lane');
            equal(cpu.readMxcsr(), 0x1f84, 'masked retry retains reportable divide status');
            equal(result.state.rip, 0x1004n, 'SIMD continuation');
          },
          {
            data: [
              { base: 0x4008n, bytes: CODE32 + DATA32 },
              { base: address, bytes: gate(32, 8, 0x2000n, 0), write: false },
              { base: 0x2000n, bytes: '0fae1500600000cf', execute: true },
              { base: 0x6000n, bytes: '801f0000' },
              { base: STACK, bytes: FILL },
            ],
          },
        );
      },
    },
  ];
}
