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
  equal,
  same,
  type Scenario,
} from '../exception-delivery/fixture.js';
import { profiles } from '../far-control/fixture.js';

export function correctnessReviewScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'hardware debug reviewed MOVDR width and ignored address bits across all imported profiles',
      async run() {
        for (const context of profiles()) {
          await using(compiler, '660f23000f2104', context, async (cpu) => {
            cpu.setState(
              initial(0x1000n, { 0: 0x11223344deadbeefn, 4: 0x88776655aabbccddn }, 0x108d7n),
            );
            const before = cpu.readState();
            const bank = cpu.readDebugState();
            const result = await cpu.run({ budget: 2n });
            if (context.mode === 'virtual8086') {
              equal(result.reason, 'protection-fault', 'VM MOVDR is privileged');
              equal(result.protectionFault?.vector, 13, 'VM GP');
              equal(result.protectionFault?.errorCode, 0, 'VM hard zero');
              equal(result.retired, 0n, 'no VM transfer');
              same(cpu.readDebugState(), bank, 'VM debug bank unchanged');
              same(result.state.registers, before.registers, 'VM destination unchanged');
            } else {
              equal(result.reason, 'budget', 'both raw register transfers execute');
              equal(result.retired, 2n, 'both transfers retire');
              const value = context.mode === 'long64' ? 0x11223344deadbeefn : 0xdeadbeefn;
              same(
                cpu.readDebugState().addresses,
                [value, 0n, 0n, 0n],
                'DR writes use fixed mode width',
              );
              const registers = before.registers.slice();
              registers[4] = context.mode === 'long64' ? value : 0x88776655deadbeefn;
              same(result.state.registers, registers, 'GPR32 follows inherited upper-bank policy');
              equal(result.state.rip, 0x1007n, 'no SIB or displacement consumed');
            }
            equal(result.state.flags, 0x8d7n, 'only RF begin changes undefined arithmetic flags');
          });
        }
      },
    },
    {
      name: 'hardware debug reviewed MOVDR legality beats privilege and privilege beats GD',
      async run() {
        for (const [code, illegal] of [
          ['0f21c0', false],
          ['0f21e0', true],
          ['f00f21c0', true],
          ['440f21c0', true],
        ] as const) {
          const context = snapshot(code.startsWith('44') ? 'long64' : 'protected', 3);
          await using(compiler, code, context, async (cpu) => {
            cpu.setDebugState({ addresses: [0x1234n, 0n, 0n, 0n], dr6: 0xe00fn, dr7: 0x2400n });
            const bank = cpu.readDebugState();
            const state = initial(0x1000n, { 0: 0x1122334455667788n }, 0x10202n);
            cpu.setState(state);
            const report = await cpu.run({ budget: 1n });
            equal(
              report.reason,
              illegal ? 'invalid-encoding' : 'protection-fault',
              code + ' report priority',
            );
            equal(report.retired, 0n, 'unexecuted source');
            equal(report.state.flags, illegal ? 0x10202n : 0x202n, 'decode versus begun RF phase');
            same(cpu.readDebugState(), bank, 'earlier fault never publishes BD or transfer');
            same(report.state.registers, state.registers, 'no GPR transfer');
            cpu.setState(state);
            const selected = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
            same(
              selected.state.event,
              {
                kind: 'pending',
                exception: {
                  vector: illegal ? 6 : 13,
                  instructionPc: 0x1000n,
                  returnPc: 0x1000n,
                  savedFlags: 0x10202n,
                  ...(illegal ? {} : { errorCode: 0 }),
                },
              },
              code + ' selected prior fault has no debug discriminant',
            );
            same(cpu.readDebugState(), bank, 'selection preserves GD/status');
          });
        }
      },
    },
    {
      name: 'hardware debug reviewed GD precedes upper32 validation and failed writes preserve control',
      async run() {
        for (const code of ['0f23f0', '0f23f8']) {
          await using(compiler, code, snapshot(), async (cpu) => {
            const state = initial(0x1000n, { 0: 0x100000000n }, 0x10202n);
            cpu.setDebugState({ addresses: [0n, 0n, 0n, 0n], dr6: 0xfn, dr7: 0x2400n });
            cpu.setState(state);
            const gd = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
            equal(gd.reason, 'event-budget', 'GD selected before invalid target value');
            same(
              gd.state.event,
              {
                kind: 'pending',
                exception: {
                  vector: 1,
                  instructionPc: 0x1000n,
                  returnPc: 0x1000n,
                  savedFlags: 0x10202n,
                  debug: { class: 'fault', cause: 'general-detect' },
                },
              },
              'exact GD source',
            );
            equal(cpu.readDebugState().dr6, 0xffff2ff0n, 'BD set while stale Bn replaced');
            equal(cpu.readDebugState().dr7, 0x2400n, 'GD survives allowance zero');
            cpu.setDebugState({ addresses: [0n, 0n, 0n, 0n], dr6: 0xe00fn, dr7: 0x400n });
            cpu.setState(state);
            const bank = cpu.readDebugState();
            const gp = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
            same(
              gp.state.event,
              {
                kind: 'pending',
                exception: {
                  vector: 13,
                  instructionPc: 0x1000n,
                  returnPc: 0x1000n,
                  savedFlags: 0x10202n,
                  errorCode: 0,
                },
              },
              'upper32 writes are GP0 without GD',
            );
            equal(gp.retired, 0n, 'invalid register write never retires');
            same(
              cpu.readDebugState(),
              bank,
              'invalid high bits never modify either control register',
            );
          });
        }
      },
    },
    {
      name: 'hardware debug reviewed RF suppresses execute only and DR6 sticky causes do not become current causes',
      async run() {
        await using(
          compiler,
          '488b03',
          snapshot(),
          async (cpu) => {
            cpu.setDebugState({
              addresses: [0x1000n, 0x3000n, 0n, 0n],
              dr6: 0xe00fn,
              dr7: 0xb00405n,
            });
            const state = initial(0x1000n, { 3: 0x3000n }, 0x202n);
            cpu.setState(state);
            const execute = await cpu.run({ budget: 1n });
            equal(execute.reason, 'debug-exception', 'execute first');
            equal(execute.retired, 0n, 'load unexecuted');
            equal(execute.debugException?.resumeFlags, 0x202n, 'execute does not force RF');
            equal(cpu.readDebugState().dr6, 0xffffeff1n, 'Bn replaced while BD BS BT stay sticky');
            same(execute.state.registers, state.registers, 'execute destination suppressed');
            cpu.setState({ ...state, flags: 0x10202n });
            const data = await cpu.run({ budget: 1n });
            equal(data.reason, 'debug-exception', 'RF does not suppress data watch');
            equal(data.retired, 1n, 'load committed');
            equal(data.state.registers[0], 0x0807060504030201n, 'full load result');
            equal(data.debugException?.breakpoints, 2, 'only current data slot');
            equal(data.debugException?.singleStep, false, 'sticky BS is not current TF');
            equal(data.debugException?.resumeFlags, 0x202n, 'ordinary begin consumed RF');
            equal(cpu.readDebugState().dr6, 0xffffeff2n, 'old execute B0 replaced by data B1');
          },
          { data: [{ base: 0x3000n, bytes: '0102030405060708' }] },
        );
      },
    },
    {
      name: 'hardware debug reviewed execute uses linear CS identity before limit while gates and RF stay prior',
      async run() {
        const context = snapshot('protected');
        context.segments.cs.base = 0x2000n;
        context.segments.cs.limit = 0xfff;
        await using(
          compiler,
          '6690',
          context,
          async (cpu) => {
            cpu.setDebugState({ addresses: [0x3000n, 0n, 0n, 0n], dr6: 0n, dr7: 0x401n });
            const state = initial(0x1000n, {}, 0x202n);
            cpu.setState(state);
            for (const options of [{ budget: 0n }, { budget: 1n, stop: 0x1000n }]) {
              const gated = await cpu.run(options);
              equal(gated.reason, options.budget === 0n ? 'budget' : 'stop', 'initial gate wins');
              equal(cpu.readDebugState().dr6, 0xffff0ff0n, 'gates cannot select execute status');
            }
            const fault = await cpu.run({ budget: 1n });
            equal(fault.reason, 'debug-exception', 'linear execute match beats CS limit');
            equal(fault.debugException?.breakpoints, 1, 'CS-derived comparator');
            equal(fault.retired, 0n, 'no bytes execute');
            cpu.setState({ ...state, flags: 0x10202n });
            const suppressed = await cpu.run({ budget: 1n });
            equal(suppressed.reason, 'segment-fault', 'RF exposes predecessor CS-limit fault');
            equal(suppressed.state.flags, 0x10202n, 'CS-limit failure is before RF begin');
            same(suppressed.state.registers, state.registers, 'no decode effects');
          },
          { entry: 0x1000n, codeBase: 0x3000n },
        );
      },
    },
    {
      name: 'hardware debug reviewed GD entry failure preserves source or selects benign secondary without debug metadata',
      async run() {
        for (const denied of [false, true]) {
          const context = snapshot('protected');
          context.segments.cs = loadedCode(32);
          context.segments.ss = loadedData(32);
          const address = withGate(context, 1);
          const absent =
            gate(32, 8, 0x2000n, 0).slice(0, 10) + '0e' + gate(32, 8, 0x2000n, 0).slice(12);
          await using(
            compiler,
            '0f21c0',
            context,
            async (cpu) => {
              cpu.setDebugState({ addresses: [0n, 0n, 0n, 0n], dr6: 0n, dr7: 0x2400n });
              cpu.setState(initial(0x1000n, { 4: 0x8000n }, 0x10202n));
              const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 1n } });
              equal(
                result.reason,
                denied ? 'system-memory-fault' : 'event-budget',
                'entry failure kind',
              );
              equal(result.retired, 0n, 'MOVDR never executed');
              equal(result.deliveryAttempts, 1n, 'exactly one failed admission');
              same(
                result.state.event,
                {
                  kind: 'pending',
                  exception: {
                    vector: denied ? 1 : 11,
                    instructionPc: 0x1000n,
                    returnPc: 0x1000n,
                    savedFlags: 0x10202n,
                    ...(denied
                      ? { debug: { class: 'fault', cause: 'general-detect' } }
                      : { errorCode: 0xb }),
                  },
                },
                'private retains GD source, benign architectural replacement drops it',
              );
              equal(cpu.readDebugState().dr7, 0x2400n, 'neither failed entry clears GD');
              equal(cpu.readDebugState().dr6, 0xffff2ff0n, 'original selected BD is not replayed');
              same(cpu.readContext(), context, 'failed handler context never commits');
              same(
                cpu.readMemory(STACK, 256),
                new Uint8Array(256).fill(0xa5),
                'no half handler frame',
              );
            },
            {
              data: [
                { base: 0x4008n, bytes: CODE32 + DATA32 },
                { base: address, bytes: absent, read: !denied },
                { base: STACK, bytes: FILL },
              ],
            },
          );
        }
      },
    },
  ];
}
