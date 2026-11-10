import {
  using,
  snapshot,
  initial,
  equal,
  same,
  type Scenario,
} from '../exception-delivery/fixture.js';

export function activityReviewScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'hardware debug reviewed idle data activation cannot reuse a warmed inactive owner',
      async run() {
        await using(
          compiler,
          '8b039083c001',
          snapshot(),
          async (cpu) => {
            const initialState = initial(0x1000n, { 3: 0x3000n }, 0x202n);
            cpu.setState(initialState);
            const warm = await cpu.run({ budget: 1n });
            equal(warm.reason, 'budget', 'inactive owner warmed');
            equal(warm.state.registers[0], 0x12345678n, 'warm load result');
            cpu.setDebugState({ addresses: [0x3000n, 0n, 0n, 0n], dr6: 0n, dr7: 0x30401n });
            cpu.setState(initialState);
            const active = await cpu.run({ budget: 1n });
            equal(active.reason, 'debug-exception', 'idle activation rejects inactive owner');
            equal(active.retired, 1n, 'watched load commits exactly once');
            equal(active.state.rip, 0x1002n, 'no successor executes before trap');
            equal(active.debugException?.breakpoints, 1, 'new bank is visible to the retained PC');
            equal(cpu.readDebugState().dr6, 0xffff0ff1n, 'current active source');
            const registers = initialState.registers.slice();
            registers[0] = 0x12345678n;
            same(active.state.registers, registers, 'only architectural load destination changes');
            cpu.setDebugState({ addresses: [0x3000n, 0n, 0n, 0n], dr6: 0n, dr7: 0n });
            cpu.setState(initialState);
            const inactive = await cpu.run({ budget: 1n });
            equal(inactive.reason, 'budget', 'removed comparator cannot keep firing');
            equal(inactive.resources.compilations, 0, 'original inactive owner is reusable');
            equal(inactive.retired, 1n, 'inactive load commits once');
            equal(inactive.state.rip, 0x1002n, 'inactive instruction boundary');
            equal(cpu.readDebugState().dr6, 0xffff0ff0n, 'no synthetic hit after deactivation');
            same(inactive.state.registers, registers, 'same literal scalar outcome');
            same(
              cpu.readMemory(0x3000n, 4),
              Uint8Array.of(0x78, 0x56, 0x34, 0x12),
              'read never writes',
            );
          },
          { data: [{ base: 0x3000n, bytes: '78563412' }] },
        );
      },
    },
  ];
}
