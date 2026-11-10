import {
  using,
  snapshot,
  initial,
  same,
  equal,
  check,
  throws,
  type Scenario,
} from '../exception-delivery/fixture.js';
import type { RunResult } from '../../../host/index.js';

export function reviewCaptureScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'hardware debug review captured bank rejects a completed nested cached run and preserves nested intake after invalid input',
      async run() {
        await using(compiler, '48ffc0ebfb', snapshot(), async (cpu) => {
          cpu.setState(initial(0x1000n, { 0: 0n }, 0x202n));
          await cpu.run({ budget: 2n });
          const bank = cpu.readDebugState();
          let nested: Promise<RunResult> | undefined;
          let captures = 0;
          throws(
            () =>
              cpu.setDebugState({
                get addresses() {
                  captures++;
                  nested = cpu.run({ budget: 1n });
                  return [0n, 0n, 0n, 0n];
                },
                dr6: 0n,
                dr7: 0x400n,
              }),
            'completed nested run invalidates outer bank publication',
          );
          equal(captures, 1, 'bank array captured once');
          check(nested, 'nested run admitted');
          const result = await nested;
          equal(result.resources.compilations, 0, 'nested execution uses real retained module');
          equal(result.state.registers[0], 2n, 'nested INC retained');
          equal(result.state.rip, 0x1003n, 'outer operation executed no further guest instruction');
          same(cpu.readState(), result.state, 'outer rejection preserves nested state');
          same(cpu.readDebugState(), bank, 'outer bank not published');
          throws(
            () =>
              cpu.setDebugState({
                get addresses() {
                  cpu.requestNmi();
                  return [0n, 0n, 0n, -1n];
                },
                dr6: 0n,
                dr7: 0x400n,
              }),
            'invalid address after nested intake',
          );
          equal(
            cpu.readState().interrupts.nmiPending,
            true,
            'nested intake survives input rejection',
          );
          same(cpu.readDebugState(), bank, 'malformed bank stays atomic');
        });
      },
    },
    {
      name: 'hardware debug review frozen checkpoints survive bank repair and imports never infer source history from current bytes',
      async run() {
        await using(compiler, '90', snapshot(), async (cpu) => {
          cpu.setDebugState({ addresses: [0x1000n, 0n, 0n, 0n], dr6: 0n, dr7: 0x401n });
          cpu.setState(initial(0x1000n, {}, 0x202n));
          const captured = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
          equal(captured.reason, 'event-budget', 'real execute source selected');
          cpu.setDebugState({ addresses: [0n, 0n, 0n, 0n], dr6: 0n, dr7: 0x400n });
          cpu.setState(captured.state);
          const omitted = await cpu.run({ budget: 1n });
          equal(omitted.reason, 'pending-exception', 'source remains after its slot was removed');
          same(omitted.state, captured.state, 'frozen source image unchanged');
          check(captured.state.event.kind === 'pending', 'selected processor event');
          const exception = captured.state.event.exception;
          throws(
            () =>
              cpu.setState({
                ...captured.state,
                event: {
                  kind: 'pending',
                  exception: {
                    ...exception,
                    get debug() {
                      cpu.setDebugState({ addresses: [0n, 0n, 0n, 0n], dr6: 0x4000n, dr7: 0x400n });
                      return {
                        class: 'fault' as const,
                        cause: 'execution-breakpoint' as const,
                        breakpoints: 0,
                      };
                    },
                  },
                },
              }),
            'invalid source after nested status repair',
          );
          same(cpu.readState(), captured.state, 'outer scalar rejection preserves pending source');
          equal(cpu.readDebugState().dr6, 0xffff4ff0n, 'successful nested status repair retained');
          const partial = {
            ...initial(0x1000n, {}, 0x302n),
            interruptibility: { sti: false, ss: true },
            event: {
              kind: 'pending' as const,
              exception: {
                vector: 1 as const,
                instructionPc: 0x1000n,
                returnPc: 0x1000n,
                savedFlags: 0x10302n,
                debug: {
                  class: 'trap' as const,
                  cause: 'data-breakpoint' as const,
                  breakpoints: 8,
                  singleStep: true,
                  instructionCompleted: false,
                  deferredOriginPc: 0xff0n,
                },
              },
            },
          };
          cpu.setState(partial);
          const imported = cpu.readState();
          check(
            imported.event.kind === 'pending' && imported.event.exception.debug?.class === 'trap',
            'equal PC imported as trap, despite current NOP bytes',
          );
          equal(
            imported.event.exception.debug.instructionCompleted,
            false,
            'unfinished source preserved',
          );
          equal(imported.interruptibility.ss, true, 'allowed combined partial TF inhibition');
          equal(
            imported.debugContinuation,
            undefined,
            'already selected history not also deferred',
          );
          const report = await cpu.run({ budget: 1n });
          equal(
            report.reason,
            'pending-exception',
            'frozen delivery-origin image accepted with option omitted',
          );
          same(report.state, imported, 'omission cannot reinterpret source');
          throws(
            () => cpu.setState({ ...partial, debugContinuation: { breakpoints: 1, originPc: 0n } }),
            'selected and deferred cannot coexist',
          );
          same(cpu.readState(), imported, 'invalid cross-fields publish nothing');
          cpu.setContext(cpu.readContext());
          same(cpu.readState().event, { kind: 'ready' }, 'equal context cancels selected source');
          equal(cpu.readDebugState().dr6, 0xffff4ff0n, 'context leaves status bank alone');
          cpu.setState({
            ...initial(0x3000n),
            interruptibility: { sti: false, ss: true },
            debugContinuation: { breakpoints: 2, originPc: 0x1111n },
          });
          cpu.setDebugState({ addresses: [0n, 0n, 0n, 0n], dr6: 0n, dr7: 0n });
          same(
            cpu.readState().debugContinuation,
            { breakpoints: 2, originPc: 0x1111n },
            'explicit rebound continuation independent of current bank',
          );
          cpu.setState(initial());
          equal(
            cpu.readState().debugContinuation,
            undefined,
            'scalar omission cancels only continuation',
          );
        });
      },
    },
    {
      name: 'hardware debug review cached middle entries and guest debug writes honor changed addresses and active profiles',
      async run() {
        await using(compiler, '909082', snapshot(), async (cpu) => {
          cpu.setState(initial(0x1000n, {}, 0x202n));
          const warmed = await cpu.run({ budget: 1n });
          equal(warmed.resources.cachedArtifacts, 1, 'plain owner includes a middle entry');
          cpu.setDebugState({ addresses: [0x1001n, 0n, 0n, 0n], dr6: 0n, dr7: 0x401n });
          const armed = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
          equal(armed.reason, 'event-budget', 'new execute comparator blocks retained suffix');
          equal(armed.retired, 0n, 'middle NOP not executed');
          equal(armed.resources.compilations, 0, 'execute source precedes browser/artifact work');
          equal(
            armed.resources.nativeEntries,
            0,
            'host admission did not enter stale plain module',
          );
          cpu.setDebugState({ addresses: [0n, 0n, 0n, 0n], dr6: 0n, dr7: 0x400n });
          cpu.setState(initial(0x1001n, {}, 0x202n));
          const removed = await cpu.run({ budget: 1n });
          equal(removed.reason, 'budget', 'removed source cannot keep firing');
          equal(removed.state.rip, 0x1002n, 'retained suffix executes once');
          cpu.setDebugState({ addresses: [0x1000n, 0n, 0n, 0n], dr6: 0n, dr7: 0x20401n });
          cpu.setState(initial(0x1000n, {}, 0x202n));
          const io = await cpu.run({ budget: 2n });
          equal(io.reason, 'budget', 'I/O comparator does not watch execution or memory');
          equal(io.retired, 2n, 'two plain NOPs');
          equal(
            io.resources.nativeEntries,
            1,
            'unsupported I/O source adds no per-instruction dispatch',
          );
        });
        for (const addressWrite of [false, true]) {
          await using(
            compiler,
            addressWrite ? '0f23c09082' : '0f23f89082',
            snapshot(),
            async (cpu) => {
              cpu.setDebugState({
                addresses: [addressWrite ? 0x2000n : 0x1003n, 0n, 0n, 0n],
                dr6: 0n,
                dr7: 0x401n,
              });
              cpu.setState(initial(0x1000n, { 0: addressWrite ? 0x1003n : 0x400n }, 0x202n));
              const result = await cpu.run({ budget: 2n });
              equal(
                result.reason,
                addressWrite ? 'debug-exception' : 'budget',
                'guest control write applies before native successor',
              );
              equal(result.retired, addressWrite ? 1n : 2n, 'no stale extra instruction');
              equal(
                result.state.rip,
                addressWrite ? 0x1003n : 0x1004n,
                'exact affected successor boundary',
              );
            },
          );
        }
      },
    },
  ];
}
