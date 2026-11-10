import {
  using,
  snapshot,
  initial,
  loadedCode,
  loadedData,
  withGate,
  gate,
  CODE64,
  DATA32,
  STACK,
  FILL,
  same,
  equal,
  preserveNumeric,
  type Scenario,
} from '../exception-delivery/fixture.js';

export function correctnessReviewScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'architectural access reviewed SS fault publishes live predecessor scalar vector and direction state',
      async run() {
        await using(compiler, '48ffc0660fefc9fd488b0424', snapshot(), async (cpu) => {
          preserveNumeric(cpu);
          const numeric = {
            xmm: cpu.readXmmState(),
            mxcsr: cpu.readMxcsr(),
            x87: cpu.readX87State(),
          };
          cpu.setState(initial(0x1000n, { 0: 0x1234n, 4: 0x800000000000n }, 0x10202n));
          const before = cpu.readState();
          const fault = await cpu.run({ budget: 4n, eventDelivery: { budget: 0n } });
          equal(fault.reason, 'event-budget', 'selected SS fault');
          equal(fault.retired, 3n, 'only INC PXOR STD retire');
          equal(fault.remaining, 1n, 'failed MOV leaves its allowance');
          const registers = before.registers.slice();
          registers[0] = 0x1235n;
          same(fault.state.registers, registers, 'fault preserves live INC result and dirty banks');
          equal(fault.state.flags, 0x606n, 'INC parity plus live IF and STD direction');
          same(
            fault.state.event,
            {
              kind: 'pending',
              exception: {
                vector: 12,
                instructionPc: 0x1008n,
                returnPc: 0x1008n,
                savedFlags: 0x10606n,
                errorCode: 0,
              },
            },
            'actual failure PC and captured live flags',
          );
          numeric.xmm[1] = 0n;
          same(cpu.readXmmState(), numeric.xmm, 'live predecessor PXOR is published once');
          equal(cpu.readMxcsr(), numeric.mxcsr, 'MXCSR preservation');
          same(cpu.readX87State(), numeric.x87, 'x87 preservation');
          const retained = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
          same(
            retained.state,
            fault.state,
            'retained entry neither replays predecessors nor loses state',
          );
        });
      },
    },
    {
      name: 'architectural access reviewed partial comparisons save entry flags and commit only completed elements',
      async run() {
        for (const scas of [false, true]) {
          const context = snapshot('protected');
          context.segments[scas ? 'es' : 'ds'].limit = scas ? 0x7000 : 0x6000;
          await using(
            compiler,
            scas ? 'f2ae' : 'f3a6',
            context,
            async (cpu) => {
              cpu.setState(
                initial(0x1000n, { 0: 0x11n, 1: 3n, 4: 0x8000n, 6: 0x6000n, 7: 0x7000n }, 0x10202n),
              );
              const before = cpu.readState();
              const fault = await cpu.run({
                budget: 1n,
                repeatBudget: 3n,
                eventDelivery: { budget: 0n },
              });
              equal(fault.reason, 'event-budget', 'next selected segment access faults');
              equal(fault.retired, 0n, 'unfinished comparison does not retire');
              equal(fault.repeatIterations, 1n, 'exactly one completed comparison');
              equal(
                fault.remainingRepeatBudget,
                2n,
                'faulting element consumes no repeat allowance',
              );
              const registers = before.registers.slice();
              registers[1] = 2n;
              registers[7] = 0x7001n;
              if (!scas) registers[6] = 0x6001n;
              same(
                fault.state.registers,
                registers,
                'only completed element advances indices/count',
              );
              equal(
                fault.state.flags,
                0x202n,
                'fault restores entry arithmetic flags without resurrecting RF',
              );
              same(
                fault.state.event,
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
                'fault image differs from last completed comparison trap flags',
              );
              same(
                cpu.readMemory(0x6000n, 3),
                new Uint8Array([0x11, 0x22, 0x33]),
                'source bytes unchanged',
              );
              same(
                cpu.readMemory(0x7000n, 3),
                new Uint8Array(scas ? [0x22, 0x33, 0x44] : [0x11, 0x22, 0x33]),
                'comparison never writes',
              );
            },
            {
              data: [
                { base: 0x6000n, bytes: '112233' },
                { base: 0x7000n, bytes: scas ? '223344' : '112233' },
              ],
            },
          );
        }
      },
    },
    {
      name: 'architectural access reviewed INT1 stack and handler canonical faults retain hard zero under EXT1',
      async run() {
        for (const stack of [true, false]) {
          const context = snapshot();
          context.segments.cs = loadedCode(64);
          context.segments.ss = loadedData(32);
          const address = withGate(context, 1);
          await using(
            compiler,
            'f1',
            context,
            async (cpu) => {
              const state = initial(0x1000n, { 4: stack ? 0x800000000000n : 0x8000n }, 0x10202n);
              cpu.setState(state);
              const report = await cpu.run({ budget: 1n });
              equal(report.reason, 'protection-fault', 'INT1 selected target/stack check');
              equal(report.protectionFault?.vector, stack ? 12 : 13, 'stack versus handler vector');
              equal(report.protectionFault?.errorCode, 0, 'hard zero does not receive INT1 EXT');
              equal(report.retired, 0n, 'failed INT1');
              cpu.setState(state);
              const fault = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
              same(
                fault.state.event,
                {
                  kind: 'pending',
                  exception: {
                    vector: stack ? 12 : 13,
                    instructionPc: 0x1000n,
                    returnPc: 0x1000n,
                    savedFlags: 0x10202n,
                    errorCode: 0,
                  },
                },
                'delivery uses the same hard-zero producer',
              );
              same(
                fault.state.registers,
                state.registers,
                'failed admission preserves the source stack',
              );
              same(
                cpu.readMemory(STACK, 256),
                new Uint8Array(256).fill(0xa5),
                'no partial INT1 frame',
              );
            },
            {
              data: [
                { base: 0x4008n, bytes: CODE64 + DATA32 },
                { base: address, bytes: gate(64, 8, stack ? 0x2000n : 0x800000000000n, 0) },
                { base: STACK, bytes: FILL },
              ],
            },
          );
        }
      },
    },
  ];
}
