import {
  using,
  snapshot,
  initial,
  equal,
  same,
  type Scenario,
} from '../exception-delivery/fixture.js';
export function dataScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'hardware debug operand matches retire once and merge simultaneous slots and TF',
      async run() {
        for (const flags of [0x202n, 0x302n])
          await using(
            compiler,
            '8b03',
            snapshot(),
            async (cpu) => {
              cpu.setDebugState({
                addresses: [0x3000n, 0x3002n, 0n, 0n],
                dr6: 0n,
                dr7: 0x007f0405n,
              });
              cpu.setState(initial(0x1000n, { 3: 0x3000n }, flags));
              const r = await cpu.run({ budget: 1n });
              equal(r.reason, 'debug-exception', 'data boundary');
              equal(r.retired, 1n, 'completed instruction');
              equal(r.state.rip, 0x1002n, 'resume after load');
              equal(r.state.registers[0], 0x04030201n, 'load committed');
              equal(r.debugException?.breakpoints, 3, 'overlapping slots');
              equal(r.debugException?.singleStep, flags === 0x302n, 'sampled TF');
              equal(
                cpu.readDebugState().dr6,
                flags === 0x302n ? 0xffff4ff3n : 0xffff0ff3n,
                'selected DR6',
              );
              same(r.state.event, { kind: 'ready' }, 'report only');
            },
            { data: [{ base: 0x3000n, bytes: '01020304' }] },
          );
      },
    },
  ];
}
