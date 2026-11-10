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
  same,
  equal,
  check,
  throws,
  ready,
  delivery,
  type Scenario,
} from './fixture.js';
import { rejects } from '../../support/fixture.js';

export function stateScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'pending checkpoint replacement validates discriminants and uses the context after reentrant capture',
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
            const staged = await cpu.run({ budget: 1n, exceptionDelivery: { budget: 0n } });
            delivery(staged, 'event-budget', 0n, 0n, 0n);
            const pending = cpu.readState();
            check(pending.event.kind === 'pending', 'checkpoint contains retained exception');
            const source = pending.event.exception;
            for (const event of [
              undefined,
              null,
              { kind: 'unknown' },
              { kind: 'pending' },
              { kind: 'pending', exception: { ...source, vector: 2 } },
              { kind: 'pending', exception: { ...source, returnPc: 0x1001n } },
              { kind: 'pending', exception: { ...source, instructionPc: -1n } },
              { kind: 'pending', exception: { ...source, savedFlags: 0x202n } },
              { kind: 'pending', exception: { ...source, savedFlags: 0x30202n } },
              { kind: 'pending', exception: { ...source, errorCode: 0 } },
              { kind: 'pending', exception: { ...source, vector: 13 } },
              { kind: 'pending', exception: { ...source, vector: 13, errorCode: 65536 } },
              { kind: 'pending', exception: { ...source, vector: 8, errorCode: 1 } },
            ]) {
              throws(
                () => cpu.setState({ ...pending, event } as never),
                'malformed pending checkpoint',
              );
              same(cpu.readState(), pending, 'rejected checkpoint publishes nothing');
            }
            cpu.setMxcsr(0x1f81);
            same(cpu.readState(), pending, 'numeric import preserves pending frame inputs');
            const numeric = cpu.readX87State();
            cpu.setX87State(numeric);
            same(cpu.readState(), pending, 'raw x87 import preserves pending source');
            let captures = 0;
            cpu.setState({
              ...pending,
              get event() {
                captures++;
                cpu.setMxcsr(0x1f82);
                return pending.event;
              },
            });
            equal(captures, 1, 'caller-controlled event property captured once');
            equal(
              cpu.readMxcsr(),
              0x1f82,
              'outer scalar import retains successful nested numeric write',
            );
            same(cpu.readState(), pending, 'complete pending checkpoint replaced atomically');
            const vm = snapshot('virtual8086');
            throws(
              () =>
                cpu.setState({
                  ...pending,
                  get event() {
                    cpu.setContext(vm);
                    return pending.event;
                  },
                }),
              'pending VM image validated against publication context',
            );
            same(cpu.readContext(), vm, 'successful nested context replacement remains committed');
            same(
              cpu.readState().event,
              { kind: 'ready' },
              'nested context cleared pending before outer rejection',
            );
            equal(
              cpu.readState().rip,
              pending.rip,
              'rejected outer import preserves scalar continuation',
            );
            cpu.setContext(execution);
            cpu.setState(pending);
            same(cpu.readState(), pending, 'context-first checkpoint restore retains source');
            cpu.setContext(cpu.readContext());
            same(
              cpu.readState().event,
              { kind: 'ready' },
              'equal context replacement explicitly cancels delivery',
            );
            cpu.setState(pending);
            cpu.setState({ registers: pending.registers, rip: pending.rip, flags: pending.flags });
            same(
              cpu.readState().event,
              { kind: 'ready' },
              'old scalar input omission selects ready',
            );
            cpu.setState({ ...pending, event: { kind: 'shutdown' } });
            cpu.setMxcsr(0x1f80);
            same(
              cpu.readState().event,
              { kind: 'shutdown' },
              'numeric import cannot leave shutdown',
            );
            const shutdown = await cpu.run({ budget: 0n });
            equal(shutdown.reason, 'shutdown', 'shutdown precedes entry allowance gates');
            cpu.setContext(cpu.readContext());
            same(
              cpu.readState().event,
              { kind: 'ready' },
              'explicit context replacement leaves shutdown',
            );
          },
          {
            data: [
              { base: 0x4008n, bytes: CODE32 + DATA32 },
              { base: address, bytes: gate(32, 8, 0x2000n, 0) },
              { base: STACK, bytes: FILL },
            ],
          },
        );
      },
    },
    {
      name: 'delivery option validation is atomic and explicit undefined retains default reporting',
      async run() {
        const execution = snapshot('protected');
        await using(compiler, 'f7f1', execution, async (cpu) => {
          cpu.setState(initial(0x1000n, { 0: 6n, 1: 0n, 2: 0n }, 0x202n));
          const before = cpu.readState();
          for (const exceptionDelivery of [
            null,
            false,
            {},
            { budget: 1 },
            { budget: -1n },
            { budget: 1n << 64n },
          ]) {
            await rejects(
              () => cpu.run({ budget: 1n, exceptionDelivery } as never),
              'invalid delivery option',
            );
            same(cpu.readState(), before, 'invalid options perform no guest work');
          }
          let captures = 0;
          const reported = await cpu.run({
            budget: 1n,
            get exceptionDelivery() {
              captures++;
              return undefined;
            },
          });
          equal(captures, 1, 'run option captured once');
          equal(reported.reason, 'divide-error', 'explicit undefined selects report mode');
          equal(reported.deliveryAttempts, undefined, 'report mode omits automatic accounting');
          ready(reported);
        });
      },
    },
  ];
}
