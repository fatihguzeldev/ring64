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

export function basicScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'exception delivery repairs a protected32 divide error and IRET retries its source exactly once',
      async run() {
        const execution = snapshot('protected');
        execution.segments.cs = loadedCode(32);
        execution.segments.ss = loadedData(32);
        const address = withGate(execution, 0);
        await using(
          compiler,
          'f7f190',
          execution,
          async (cpu) => {
            cpu.setState(initial(0x1000n, { 0: 6n, 1: 0n, 2: 0n, 4: 0x8000n }, 0x202n));
            const result = await cpu.run({
              budget: 3n,
              exceptionDelivery: { budget: 2n },
            });
            delivery(result, 'budget', 3n, 1n, 1n);
            ready(result);
            noDeliveryFault(result);
            equal(result.state.rip, 0x1002n, 'DIV continuation');
            equal(result.state.registers[0], 3n, 'repaired quotient');
            equal(result.state.registers[1], 2n, 'handler divisor');
            equal(result.state.registers[2], 0n, 'repaired remainder');
            equal(result.state.registers[4], 0x8000n, 'restored stack');
            equal(result.state.flags, 0x202n, 'RF consumed by successful retried DIV');
            same(cpu.readMemory(0x7ff4n, 12), image([0x1000n, 8n, 0x10202n], 4), 'fault frame');
            same(cpu.readMemory(STACK, 244), new Uint8Array(244).fill(0xa5), 'lower guard');
          },
          {
            data: [
              { base: 0x4008n, bytes: CODE32 + DATA32 },
              { base: address, bytes: gate(32, 8, 0x2000n, 0), write: false },
              { base: 0x2000n, bytes: 'b902000000cf', execute: true },
              { base: STACK, bytes: FILL },
            ],
          },
        );
      },
    },
  ];
}
