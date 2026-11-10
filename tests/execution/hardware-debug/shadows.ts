import {
  using,
  snapshot,
  initial,
  DATA32,
  equal,
  same,
  type Scenario,
} from '../exception-delivery/fixture.js';
export function shadowScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'hardware debug MOV and POP SS defer their actual operand hits across idle bank edits',
      async run() {
        for (const [code, source, sp] of [
          ['8e1390', 0x6000n, 0x7000n],
          ['1790', 0x6002n, 0x6000n],
        ] as const)
          for (const flags of [0x202n, 0x302n])
            await using(
              compiler,
              code,
              snapshot('protected'),
              async (cpu) => {
                cpu.setDebugState({
                  addresses: [source, 0x1000n + BigInt(code.length / 2 - 1), 0n, 0n],
                  dr6: 0n,
                  dr7: 0x00030405n,
                });
                cpu.setState(initial(0x1000n, { 3: 0x6000n, 4: sp }, flags));
                const first = await cpu.run({ budget: 1n });
                equal(first.reason, 'budget', 'producer suppresses own trap');
                same(
                  first.state.debugContinuation,
                  { breakpoints: 1, originPc: 0x1000n },
                  'durable captured operand',
                );
                same(first.state.interruptibility, { sti: false, ss: true }, 'SS interval');
                equal(cpu.readDebugState().dr6, 0xffff0ff0n, 'DR6 awaits selection');
                const original = first.state;
                cpu.setDebugState({ addresses: [0n, 0n, 0n, 0n], dr6: 0n, dr7: 0n });
                same(cpu.readState(), original, 'bank setter preserves history');
                for (const opts of [{ budget: 0n }, { budget: 1n, stop: first.state.rip }]) {
                  const gate = await cpu.run(opts);
                  same(gate.state, original, 'initial gate preserves history');
                }
                const next = await cpu.run({ budget: 1n });
                equal(next.reason, 'debug-exception', 'successor selects historical hit');
                equal(next.retired, 1n, 'successor retirement');
                equal(next.debugException?.breakpoints, 1, 'bank disable cannot erase history');
                equal(next.debugException?.singleStep, flags === 0x302n, 'successor TF');
                equal(next.debugException?.deferredOriginPc, 0x1000n, 'oldest origin');
                equal(next.state.debugContinuation, undefined, 'selected source consumes defer');
                equal(next.state.interruptibility.ss, false, 'completed trap ends SS');
              },
              {
                data: [
                  { base: 0x4010n, bytes: DATA32 },
                  { base: 0x6000n, bytes: '10000000' },
                ],
              },
            );
      },
    },
    {
      name: 'hardware debug SS REP data waits across a private repeat yield and partial TF merges immediately',
      async run() {
        for (const step of [false, true])
          for (const delivery of [false, true])
            await using(
              compiler,
              'f3a4',
              snapshot(),
              async (cpu) => {
                cpu.setDebugState({
                  addresses: [0x3000n, 0x4000n, 0n, 0n],
                  dr6: 0n,
                  dr7: 0x00130405n,
                });
                cpu.setState({
                  ...initial(0x1000n, { 1: 2n, 6: 0x3000n, 7: 0x4000n }, step ? 0x302n : 0x202n, {
                    sti: false,
                    ss: true,
                  }),
                  debugContinuation: { breakpoints: 4, originPc: 0xfffn },
                });
                const first = await cpu.run({
                  budget: 1n,
                  repeatBudget: 1n,
                  ...(delivery ? { eventDelivery: { budget: 0n } } : {}),
                });
                if (step) {
                  equal(
                    first.reason,
                    delivery ? 'event-budget' : 'debug-exception',
                    'partial TF selects now',
                  );
                  equal(first.retired, 0n, 'unfinished instruction');
                  equal(first.repeatIterations, 1n, 'first completed element');
                  equal(cpu.readDebugState().dr6, 0xffff4ff7n, 'data plus historical plus BS');
                  equal(first.state.debugContinuation, undefined, 'partial source owns history');
                  equal(
                    first.state.interruptibility.ss,
                    delivery,
                    'only selected delivery checkpoint retains SS',
                  );
                  if (delivery) {
                    const e = first.state.event;
                    equal(e.kind, 'pending', 'captured pending');
                    if (e.kind === 'pending') {
                      same(
                        e.exception.debug,
                        {
                          class: 'trap',
                          cause: 'data-breakpoint',
                          breakpoints: 7,
                          singleStep: true,
                          instructionCompleted: false,
                          deferredOriginPc: 0xfffn,
                        },
                        'combined pending source',
                      );
                      equal(e.exception.savedFlags, 0x10302n, 'partial saved RF');
                    }
                    cpu.setState(first.state);
                    const omitted = await cpu.run({ budget: 1n });
                    equal(
                      omitted.reason,
                      'pending-exception',
                      'fresh option omission accepts checkpoint',
                    );
                  }
                } else {
                  equal(first.reason, 'repeat-budget', 'SS data-only must defer');
                  same(
                    first.state.debugContinuation,
                    { breakpoints: 7, originPc: 0xfffn },
                    'first element durably joined',
                  );
                  equal(cpu.readDebugState().dr6, 0xffff0ff0n, 'no status before selection');
                  const last = await cpu.run({
                    budget: 1n,
                    repeatBudget: 1n,
                    ...(delivery ? { eventDelivery: { budget: 0n } } : {}),
                  });
                  equal(
                    last.reason,
                    delivery ? 'event-budget' : 'debug-exception',
                    'completion selects',
                  );
                  equal(last.retired, 1n, 'whole REP retirement');
                  equal(cpu.readDebugState().dr6, 0xffff0ff7n, 'all captured slots');
                }
              },
              {
                data: [
                  { base: 0x3000n, bytes: '0102' },
                  { base: 0x4000n, bytes: '0000' },
                ],
              },
            );
      },
    },
    {
      name: 'hardware debug private fault retains SS history and a recognized decode fault discards it',
      async run() {
        for (const [code, reason, preserve] of [
          ['8b03', 'data-fault', true],
          ['0f0b', 'unsupported', false],
          ['82', 'unsupported', true],
        ] as const)
          await using(compiler, code, snapshot(), async (cpu) => {
            cpu.setState({
              ...initial(0x1000n, { 3: 0x7000n }, 0x202n, { sti: false, ss: true }),
              debugContinuation: { breakpoints: 8, originPc: 0xff0n },
            });
            const r = await cpu.run({ budget: 1n });
            equal(r.reason, reason, 'selected failure');
            equal(
              r.state.debugContinuation !== undefined,
              preserve,
              'recognition owns cancellation',
            );
            equal(cpu.readDebugState().dr6, 0xffff0ff0n, 'no data status from refusal');
          });
      },
    },
  ];
}
