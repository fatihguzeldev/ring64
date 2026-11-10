import {
  using,
  snapshot,
  initial,
  loadedCode,
  loadedData,
  withGate,
  gate,
  CODE32,
  CODE64,
  DATA32,
  STACK,
  FILL,
  image,
  same,
  equal,
  check,
  ready,
  delivery,
  noDeliveryFault,
  preserveNumeric,
  type Scenario,
} from './fixture.js';

export function boundaryScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'exception allowance suspension preserves its source and initial gates precede retained delivery',
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
            const before = initial(0x1000n, { 0: 6n, 1: 0n, 2: 0n, 4: 0x8000n }, 0x202n);
            cpu.setState(before);
            const reported = await cpu.run({ budget: 1n });
            equal(reported.reason, 'divide-error', 'default report behavior');
            equal(reported.deliveryAttempts, undefined, 'omitted allowance has no attempt count');
            equal(
              reported.remainingDeliveryBudget,
              undefined,
              'omitted allowance has no remainder',
            );
            ready(reported);
            const staged = await cpu.run({ budget: 1n, exceptionDelivery: { budget: 0n } });
            delivery(staged, 'event-budget', 0n, 0n, 0n);
            same(
              staged.state.event,
              {
                kind: 'pending',
                exception: {
                  vector: 0,
                  instructionPc: 0x1000n,
                  returnPc: 0x1000n,
                  savedFlags: 0x10202n,
                },
              },
              'retained divide source',
            );
            same(cpu.readMemory(STACK, 256), new Uint8Array(256).fill(0xa5), 'no entry attempt');
            const detached = cpu.readState();
            check(detached.event.kind === 'pending', 'detached pending event');
            detached.event.exception.savedFlags = 2n;
            same(cpu.readState(), staged.state, 'readback mutation does not alter retained event');
            for (const options of [
              { budget: 0n, exceptionDelivery: { budget: 1n } },
              { budget: 1n, stop: 0x1000n, exceptionDelivery: { budget: 1n } },
            ]) {
              const gated = await cpu.run(options);
              delivery(gated, options.budget === 0n ? 'budget' : 'stop', 0n, 0n, 1n);
              same(gated.state, staged.state, 'entry gate preserves retained source');
            }
            const omitted = await cpu.run({ budget: 1n });
            equal(omitted.reason, 'pending-exception', 'omission cannot replay source');
            same(omitted.state, staged.state, 'omitted option retains pending checkpoint');
            const entered = await cpu.run({
              budget: 1n,
              stop: 0x2000n,
              exceptionDelivery: { budget: 1n },
            });
            delivery(entered, 'stop', 0n, 1n, 0n);
            ready(entered);
            noDeliveryFault(entered);
            equal(entered.state.rip, 0x2000n, 'handler stop before unmapped fetch');
            const frame = cpu.readMemory(0x7ff4n, 12);
            same(frame, image([0x1000n, 8n, 0x10202n], 4), 'captured fault boundary');
            const fetched = await cpu.run({ budget: 1n, exceptionDelivery: { budget: 1n } });
            delivery(fetched, 'fetch-fault', 0n, 0n, 1n);
            ready(fetched);
            same(cpu.readMemory(0x7ff4n, 12), frame, 'delivered frame is not replayed');
          },
          {
            data: [
              { base: 0x4008n, bytes: CODE32 + DATA32 },
              { base: address, bytes: gate(32, 8, 0x2000n, 0), write: false },
              { base: STACK, bytes: FILL },
            ],
          },
        );
      },
    },
    {
      name: 'completed long64 branch trap delivers its destination before the final instruction allowance expires',
      async run() {
        const execution = snapshot();
        execution.segments.cs = loadedCode(64);
        execution.segments.ss = loadedData(32);
        const address = withGate(execution, 1);
        await using(
          compiler,
          'eb0e',
          execution,
          async (cpu) => {
            const numeric = preserveNumeric(cpu);
            cpu.setState(initial(0x1000n, { 4: 0x8000n }, 0x302n));
            const result = await cpu.run({ budget: 1n, exceptionDelivery: { budget: 1n } });
            delivery(result, 'budget', 1n, 1n, 0n);
            ready(result);
            noDeliveryFault(result);
            equal(result.state.rip, 0x2000n, 'handler PC despite no remaining instruction work');
            equal(result.state.registers[4], 0x7fd8n, 'five-qword frame');
            equal(result.state.flags, 2n, 'entry clears TF and IF');
            same(
              cpu.readMemory(0x7fd8n, 40),
              image([0x1010n, 8n, 0x302n, 0x8000n, 16n], 8),
              'trap saves destination rather than source or sequential fallthrough',
            );
            same(result.state.interruptibility, { sti: false, ss: false }, 'entry clears history');
            numeric();
          },
          {
            data: [
              { base: 0x4008n, bytes: CODE64 + DATA32 },
              { base: address, bytes: gate(64, 8, 0x2000n, 0), write: false },
              { base: STACK, bytes: FILL },
            ],
          },
        );
      },
    },
    {
      name: 'partial and final repeated comparison traps retain distinct flags RF boundaries and retirement',
      async run() {
        const execution = snapshot('protected');
        execution.segments.cs = loadedCode(32);
        execution.segments.ss = loadedData(32);
        const address = withGate(execution, 1);
        await using(
          compiler,
          'f3a690',
          execution,
          async (cpu) => {
            cpu.setState(initial(0x1000n, { 1: 2n, 4: 0x8000n, 6: 0x6000n, 7: 0x6100n }, 0x302n));
            const partial = await cpu.run({
              budget: 1n,
              repeatBudget: 2n,
              stop: 0x2000n,
              exceptionDelivery: { budget: 1n },
            });
            delivery(partial, 'stop', 0n, 1n, 0n);
            ready(partial);
            equal(partial.repeatIterations, 1n, 'only the first comparison completed');
            equal(partial.state.registers[1], 1n, 'remaining repeated count');
            equal(partial.state.registers[6], 0x6001n, 'completed source advance');
            equal(partial.state.registers[7], 0x6101n, 'completed destination advance');
            equal(partial.state.flags, 0x46n, 'handler sees last comparison and entry flags');
            same(
              cpu.readMemory(0x7ff4n, 12),
              image([0x1000n, 8n, 0x10346n], 4),
              'partial saved RF',
            );
            const returned = await cpu.run({ budget: 1n });
            equal(returned.reason, 'budget', 'IRET completes');
            equal(returned.state.rip, 0x1000n, 'unfinished repetition resumes at source');
            equal(returned.state.flags, 0x10346n, 'IRET restores selected RF and TF');
            const final = await cpu.run({
              budget: 1n,
              repeatBudget: 1n,
              exceptionDelivery: { budget: 1n },
            });
            delivery(final, 'budget', 1n, 1n, 0n);
            equal(final.repeatIterations, 1n, 'remaining element is not replayed');
            equal(final.state.registers[1], 0n, 'repetition completed');
            same(
              cpu.readMemory(0x7ff4n, 12),
              image([0x1002n, 8n, 0x397n], 4),
              'final trap has next PC and no forced RF',
            );
          },
          {
            data: [
              { base: 0x4008n, bytes: CODE32 + DATA32 },
              { base: address, bytes: gate(32, 8, 0x2000n, 0), write: false },
              { base: 0x2000n, bytes: 'cf', execute: true },
              { base: 0x6000n, bytes: '0102' },
              { base: 0x6100n, bytes: '0103' },
              { base: STACK, bytes: FILL },
            ],
          },
        );
      },
    },
    {
      name: 'staged STI single-step retains its new shadow until automatic entry actually commits',
      async run() {
        const execution = snapshot('protected');
        execution.segments.cs = loadedCode(32);
        execution.segments.ss = loadedData(32);
        const address = withGate(execution, 1);
        await using(
          compiler,
          'fb90',
          execution,
          async (cpu) => {
            cpu.setState(initial(0x1000n, { 4: 0x8000n }, 0x102n));
            const staged = await cpu.run({ budget: 1n, exceptionDelivery: { budget: 0n } });
            delivery(staged, 'event-budget', 1n, 0n, 0n);
            same(
              staged.state.interruptibility,
              { sti: true, ss: false },
              'staging is not delivery',
            );
            same(
              staged.state.event,
              {
                kind: 'pending',
                exception: {
                  vector: 1,
                  instructionPc: 0x1000n,
                  returnPc: 0x1001n,
                  savedFlags: 0x302n,
                },
              },
              'STI trap frame inputs',
            );
            const entered = await cpu.run({
              budget: 1n,
              stop: 0x2000n,
              exceptionDelivery: { budget: 1n },
            });
            delivery(entered, 'stop', 0n, 1n, 0n);
            same(
              entered.state.interruptibility,
              { sti: false, ss: false },
              'committed entry clears STI interval',
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
      name: 'branch-trap entry refusal diagnoses its source PC independently of the saved branch destination',
      async run() {
        const execution = snapshot();
        execution.segments.cs = loadedCode(64);
        withGate(execution, 1);
        await using(compiler, 'eb0e', execution, async (cpu) => {
          cpu.setState(initial(0x1000n, { 4: 0x8000n }, 0x302n));
          const refused = await cpu.run({ budget: 1n, exceptionDelivery: { budget: 1n } });
          delivery(refused, 'system-memory-fault', 1n, 1n, 0n);
          equal(
            refused.systemMemoryFault?.instructionPc,
            0x1000n,
            'diagnostic names originating branch',
          );
          equal(refused.state.rip, 0x1010n, 'continuation remains completed destination');
          same(
            refused.state.event,
            {
              kind: 'pending',
              exception: {
                vector: 1,
                instructionPc: 0x1000n,
                returnPc: 0x1010n,
                savedFlags: 0x302n,
              },
            },
            'source and continuation are separately retained',
          );
        });
      },
    },
    {
      name: 'MOV SS suppresses its own TF source while STI with TF delivers at its completed boundary',
      async run() {
        for (const ss of [true, false]) {
          const execution = snapshot('protected');
          execution.segments.cs = loadedCode(32);
          execution.segments.ss = loadedData(32);
          const address = withGate(execution, 1);
          await using(
            compiler,
            ss ? '8ed090' : 'fb90',
            execution,
            async (cpu) => {
              cpu.setState(initial(0x1000n, { 0: 16n, 4: 0x8000n }, ss ? 0x302n : 0x102n));
              const first = await cpu.run({ budget: 1n, exceptionDelivery: { budget: 1n } });
              delivery(first, 'budget', 1n, ss ? 0n : 1n, ss ? 1n : 0n);
              if (ss) {
                same(
                  first.state.interruptibility,
                  { sti: false, ss: true },
                  'SS history remains pending',
                );
                const next = await cpu.run({ budget: 1n, exceptionDelivery: { budget: 1n } });
                delivery(next, 'budget', 1n, 1n, 0n);
              }
              same(
                cpu.readState().interruptibility,
                { sti: false, ss: false },
                'committed entry clears both histories',
              );
              same(
                cpu.readMemory(0x7ff4n, 12),
                image([ss ? 0x1003n : 0x1001n, 8n, 0x302n], 4),
                'selected TF completion frame',
              );
            },
            {
              data: [
                { base: 0x4008n, bytes: CODE32 + DATA32 },
                { base: address, bytes: gate(32, 8, 0x2000n, 0), write: false },
                { base: STACK, bytes: FILL },
              ],
            },
          );
        }
      },
    },
  ];
}
