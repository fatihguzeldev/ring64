import {
  using,
  snapshot,
  initial,
  same,
  equal,
  throws,
  type Scenario,
} from '../exception-delivery/fixture.js';

export function bankScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'hardware debug bank normalizes reserved fields and preserves atomic independent projections',
      async run() {
        await using(compiler, '90', snapshot(), async (cpu) => {
          same(
            cpu.readDebugState(),
            { addresses: [0n, 0n, 0n, 0n], dr6: 0xffff0ff0n, dr7: 0x400n },
            'fresh bank',
          );
          const bank = {
            addresses: [0x800000000000n, 0xffffffffffffffffn, 3n, 4n],
            dr6: 0xffffffffn,
            dr7: 0xffffffffn,
          };
          cpu.setDebugState(bank);
          bank.addresses[0] = 0n;
          const normalized = {
            addresses: [0x800000000000n, 0xffffffffffffffffn, 3n, 4n],
            dr6: 0xffffefffn,
            dr7: 0xffff27ffn,
          };
          same(cpu.readDebugState(), normalized, 'raw address and normalized controls');
          const read = cpu.readDebugState();
          read.addresses[1] = 0n;
          same(cpu.readDebugState(), normalized, 'detached readback');
          const before = cpu.readState();
          throws(
            () => cpu.setDebugState({ ...normalized, dr6: 1n << 32n }),
            'upper32 host rejection',
          );
          same(cpu.readState(), before, 'failed bank import preserves scalar');
          same(cpu.readDebugState(), normalized, 'failed bank atomicity');
          cpu.setState({
            ...initial(),
            interruptibility: { sti: false, ss: true },
            debugContinuation: { breakpoints: 8, originPc: 0xfffn },
          });
          cpu.setDebugState({ addresses: [0n, 0n, 0n, 0n], dr6: 0n, dr7: 0n });
          same(
            cpu.readState().debugContinuation,
            { breakpoints: 8, originPc: 0xfffn },
            'bank repair keeps historical disabled slot',
          );
          const result = await cpu.run({ budget: 0n });
          equal(result.reason, 'budget', 'initial gate');
          same(
            result.state.debugContinuation,
            { breakpoints: 8, originPc: 0xfffn },
            'gate preserves continuation',
          );
          throws(
            () =>
              cpu.setState({ ...initial(), debugContinuation: { breakpoints: 1, originPc: 0n } }),
            'continuation requires SS',
          );
          cpu.setContext(cpu.readContext());
          equal(cpu.readState().debugContinuation, undefined, 'equal context cancels continuation');
          same(
            cpu.readDebugState(),
            { addresses: [0n, 0n, 0n, 0n], dr6: 0xffff0ff0n, dr7: 0x400n },
            'context preserves bank',
          );
        });
      },
    },
  ];
}
