import {
  using,
  snapshot,
  initial,
  equal,
  same,
  type Scenario,
} from '../exception-delivery/fixture.js';
export function registerScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'hardware debug guest MOVDR treats mod bits as register and uses the fixed extended profile',
      async run() {
        await using(compiler, '0f23c00f2104', snapshot(), async (cpu) => {
          cpu.setState(initial(0x1000n, { 0: 0x800000000000n }));
          const r = await cpu.run({ budget: 2n });
          equal(r.reason, 'budget', 'two MOVDR instructions');
          equal(r.retired, 2n, 'both retire');
          equal(r.state.registers[4], 0x800000000000n, 'mod00 rm4 is RSP without SIB');
          same(
            cpu.readDebugState().addresses,
            [0x800000000000n, 0n, 0n, 0n],
            'guest writes raw noncanonical DR0',
          );
        });
      },
    },
  ];
}
