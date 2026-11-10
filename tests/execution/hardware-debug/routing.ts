import {
  using,
  snapshot,
  initial,
  equal,
  same,
  type Scenario,
} from '../exception-delivery/fixture.js';
export function routingScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'hardware debug active miss loops retain native routing and one artifact',
      async run() {
        for (const rw of [0, 3])
          await using(
            compiler,
            '8b038907e2fa',
            snapshot(),
            async (cpu) => {
              cpu.setDebugState({
                addresses: [0x5000n, 0n, 0n, 0n],
                dr6: 0n,
                dr7: 0x401n | (BigInt(rw) << 16n),
              });
              cpu.setState(initial(0x1000n, { 1: 1001n, 3: 0x3000n, 7: 0x4000n }, 0x202n));
              const r = await cpu.run({ budget: 3003n });
              equal(r.reason, 'budget', 'all misses complete');
              equal(r.retired, 3003n, 'all loop work');
              equal(r.state.registers[1], 0n, 'loop counter');
              equal(r.state.rip, 0x1006n, 'loop exit');
              same(cpu.readMemory(0x4000n, 4), new Uint8Array([1, 2, 3, 4]), 'stores commit');
              equal(r.resources.nativeEntries, 1, 'active misses keep native loop');
              equal(r.resources.dispatches, 0, 'no per-instruction host dispatch');
              equal(r.resources.cachedArtifacts, 1, 'one finite activity owner');
              equal(cpu.readDebugState().dr6, 0xffff0ff0n, 'miss status unchanged');
            },
            {
              data: [
                { base: 0x3000n, bytes: '01020304' },
                { base: 0x4000n, bytes: '00000000' },
              ],
            },
          );
      },
    },
    {
      name: 'hardware debug native interior execute and data hits stop before successors',
      async run() {
        for (const exec of [false, true])
          await using(
            compiler,
            '8b038907e2fa',
            snapshot(),
            async (cpu) => {
              cpu.setDebugState({
                addresses: [exec ? 0x1004n : 0x4000n, 0n, 0n, 0n],
                dr6: 0n,
                dr7: exec ? 0x401n : 0x10401n,
              });
              cpu.setState(initial(0x1000n, { 1: 3n, 3: 0x3000n, 7: 0x4000n }, 0x202n));
              const r = await cpu.run({ budget: 9n });
              equal(r.reason, 'debug-exception', 'interior source');
              equal(r.retired, 2n, 'load and store commit before LOOP');
              equal(r.state.rip, 0x1004n, 'next instruction boundary');
              equal(r.state.registers[1], 3n, 'LOOP never begins');
              equal(r.debugException?.class, exec ? 'fault' : 'trap', 'source class');
              equal(r.debugException?.breakpoints, 1, 'one current source');
              equal(r.resources.nativeEntries, 1, 'source selected inside native owner');
              same(cpu.readMemory(0x4000n, 4), new Uint8Array([1, 2, 3, 4]), 'one store');
            },
            {
              data: [
                { base: 0x3000n, bytes: '01020304' },
                { base: 0x4000n, bytes: '00000000' },
              ],
            },
          );
      },
    },
    {
      name: 'hardware debug active miss cannot route through successful code invalidation',
      async run() {
        await using(
          compiler,
          '880790',
          snapshot(),
          async (cpu) => {
            cpu.setDebugState({ addresses: [0x5000n, 0n, 0n, 0n], dr6: 0n, dr7: 0x30401n });
            cpu.setState(initial(0x1000n, { 0: 0xf4n, 7: 0x1002n }, 0x202n));
            const r = await cpu.run({ budget: 3n });
            equal(r.reason, 'halted', 'changed successor is fetched');
            equal(r.retired, 2n, 'store plus new HLT');
            equal(r.state.rip, 0x1003n, 'new halted continuation');
            equal(r.resources.compilations, 2, 'invalidated owner is replaced');
            equal(r.resources.nativeEntries, 2, 'only code invalidation exits the owner');
            equal(r.resources.dispatches, 1, 'one genuine redispatch');
            same(
              cpu.readMemory(0x1000n, 3),
              new Uint8Array([0x88, 0x07, 0xf4]),
              'watched miss still writes code',
            );
          },
          { codeWrite: true },
        );
      },
    },
    {
      name: 'hardware debug active miss admits an eligible NMI before native continuation and budget gates',
      async run() {
        await using(compiler, '9090', snapshot(), async (cpu) => {
          cpu.setDebugState({ addresses: [0x5000n, 0n, 0n, 0n], dr6: 0n, dr7: 0x401n });
          cpu.setState({
            ...initial(0x1000n, {}, 0x202n, { sti: false, ss: true }),
            interrupts: { irq: null, nmiPending: true, nmiBlocked: false },
          });
          const r = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
          equal(r.reason, 'event-budget', 'NMI boundary precedes exhausted instruction quota');
          equal(r.retired, 1n, 'only inhibited instruction completes');
          equal(r.state.rip, 0x1001n, 'eligible NMI continuation');
          same(
            r.state.event,
            {
              kind: 'pending-interrupt',
              interrupt: { source: { kind: 'nmi' }, returnPc: 0x1001n, savedFlags: 0x202n },
            },
            'exact accepted NMI',
          );
          same(
            r.state.interrupts,
            { irq: null, nmiPending: false, nmiBlocked: true },
            'NMI lifecycle',
          );
          equal(cpu.readDebugState().dr6, 0xffff0ff0n, 'miss does not select DB');
        });
      },
    },
  ];
}
