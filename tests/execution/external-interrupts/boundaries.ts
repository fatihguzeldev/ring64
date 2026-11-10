import {
  using,
  execution,
  input,
  same,
  equal,
  check,
  gate,
  image,
  DESCRIPTORS,
  STACK,
  FILL,
  EMPTY,
  preserveNumeric,
  type Scenario,
} from './fixture.js';

export function boundaryScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'external software INT commits its frame then applies handler gates before queued NMI nesting',
      async run() {
        await using(
          compiler,
          'cd20',
          execution(),
          async (cpu) => {
            for (const stop of [undefined, 0x2000n]) {
              cpu.setState(input(0x1000n, { 4: 0x8000n }, 2n, { sti: false, ss: true }));
              cpu.requestNmi();
              const entered = await cpu.run({
                budget: stop === undefined ? 1n : 2n,
                ...(stop === undefined ? {} : { stop }),
                eventDelivery: { budget: 1n },
              });
              equal(
                entered.reason,
                stop === undefined ? 'budget' : 'stop',
                'INT handler admission gate',
              );
              equal(entered.retired, 1n, 'software INT retires');
              equal(entered.deliveryAttempts, 0n, 'INT is not automatic and NMI remains queued');
              equal(entered.state.rip, 0x2000n, 'software handler boundary');
              same(
                entered.state.interrupts,
                { ...EMPTY, nmiPending: true },
                'handler gate prevents NMI acceptance',
              );
              same(
                cpu.readMemory(0x7ff4n, 12),
                image([0x1002n, 8n, 2n], 4),
                'INT frame committed once',
              );
              const nested = await cpu.run({
                budget: 1n,
                stop: 0x3000n,
                eventDelivery: { budget: 1n },
              });
              equal(nested.reason, 'stop', 'next run may accept queued NMI');
              equal(nested.retired, 0n, 'software handler bytes remain unmapped');
              same(cpu.readMemory(0x7fe8n, 12), image([0x2000n, 8n, 2n], 4), 'nested NMI boundary');
            }
          },
          {
            data: [
              DESCRIPTORS,
              { base: STACK, bytes: FILL },
              { base: 0x8100n, bytes: gate(32, 8, 0x2000n, 0) },
              { base: 0x8010n, bytes: gate(32, 8, 0x3000n, 0) },
            ],
          },
        );
      },
    },
    {
      name: 'external POPF and IRET service newly eligible IRQ before their final budget and stop gates',
      async run() {
        for (const returning of [false, true]) {
          await using(
            compiler,
            returning ? 'cf' : '9d',
            execution(),
            async (cpu) => {
              const before = input();
              const continuation = returning ? 0x1100n : 0x1001n;
              const frame = returning ? image([0x1100n, 8n, 0x202n], 4) : image([0x202n], 4);
              cpu.writeMemory(0x8000n, frame);
              cpu.setState(before);
              const warmed = await cpu.run({ budget: 1n });
              equal(warmed.reason, 'budget', 'warm plain control path');
              equal(warmed.state.rip, continuation, 'warm continuation');
              cpu.writeMemory(0x8000n, frame);
              cpu.setState(before);
              cpu.requestInterrupt(0x20);
              const result = await cpu.run({
                budget: 1n,
                stop: continuation,
                eventDelivery: { budget: 1n },
              });
              equal(result.reason, 'budget', 'handler budget gate follows entry');
              equal(result.retired, 1n, 'only the enabling control instruction retires');
              equal(result.deliveryAttempts, 1n, 'last allowance still delivers');
              equal(result.state.rip, 0x2000n, 'unmapped continuation was never fetched');
              equal(result.state.flags, 2n, 'handler live IF cleared');
              const sp = returning ? 0x8000n : 0x7ff8n;
              equal(result.state.registers[4], sp, 'entry starts from completed control stack');
              same(
                cpu.readMemory(sp, 12),
                image([continuation, 8n, 0x202n], 4),
                'captured post-control image',
              );
              same(result.state.interrupts, EMPTY, 'source consumed once');
            },
            {
              data: [
                DESCRIPTORS,
                { base: STACK, bytes: FILL + '00'.repeat(16) },
                { base: 0x8100n, bytes: gate(32, 8, 0x2000n, 0) },
              ],
            },
          );
        }
      },
    },
    {
      name: 'external faulting IRET unblocks NMI before private frame refusal and accepts it only on reentry',
      async run() {
        await using(
          compiler,
          'cf',
          execution(),
          async (cpu) => {
            const numeric = preserveNumeric(cpu);
            cpu.setState({ ...input(), interrupts: { ...EMPTY, nmiBlocked: true } });
            cpu.requestNmi();
            const refused = await cpu.run({ budget: 1n, eventDelivery: { budget: 1n } });
            equal(refused.reason, 'data-fault', 'IRET reads the unmapped old stack');
            equal(refused.retired, 0n, 'private IRET refusal does not retire');
            equal(refused.deliveryAttempts, 0n, 'newly unblocked NMI waits through private yield');
            same(
              refused.state.interrupts,
              { ...EMPTY, nmiPending: true },
              'early unblock survived refusal',
            );
            same(cpu.readMemory(STACK, 256), new Uint8Array(256).fill(0xa5), 'no half-frame');
            const entered = await cpu.run({
              budget: 1n,
              stop: 0x2000n,
              eventDelivery: { budget: 1n },
            });
            equal(entered.reason, 'stop', 'NMI precedes retry of inaccessible IRET stack');
            equal(entered.retired, 0n, 'IRET not retried');
            equal(entered.deliveryAttempts, 1n, 'one accepted NMI');
            same(
              entered.state.interrupts,
              { ...EMPTY, nmiBlocked: true },
              'acceptance blocks again',
            );
            same(
              cpu.readMemory(0x7ff4n, 12),
              image([0x1000n, 8n, 2n], 4),
              'before-instruction boundary',
            );
            numeric();
          },
          {
            data: [
              DESCRIPTORS,
              { base: STACK, bytes: FILL },
              { base: 0x8010n, bytes: gate(32, 8, 0x2000n, 0) },
            ],
          },
        );
      },
    },
    {
      name: 'external private REPE suspension and idle intake use published flags without manufacturing RF',
      async run() {
        await using(
          compiler,
          'f3a6',
          execution(),
          async (cpu) => {
            const numeric = preserveNumeric(cpu);
            cpu.setState(input(0x1000n, { 1: 3n, 4: 0x8000n, 6: 0x6000n, 7: 0x6100n }, 0x202n));
            const partial = await cpu.run({ budget: 1n, repeatBudget: 1n });
            equal(partial.reason, 'repeat-budget', 'private partial comparison');
            equal(partial.retired, 0n, 'unfinished instruction');
            equal(
              partial.state.flags,
              0x202n,
              'private suspension restores entry comparison flags',
            );
            equal(partial.repeatIterations, 1n, 'one comparison committed');
            cpu.requestInterrupt(0x20);
            const entered = await cpu.run({
              budget: 1n,
              stop: 0x2000n,
              eventDelivery: { budget: 1n },
            });
            equal(entered.reason, 'stop', 'idle request before resumed source bytes');
            equal(entered.repeatIterations, 0n, 'entry executes no repeated work');
            same(
              cpu.readMemory(0x7ff4n, 12),
              image([0x1000n, 8n, 0x202n], 4),
              'published flags and no synthetic RF',
            );
            const returned = await cpu.run({ budget: 1n });
            equal(returned.reason, 'budget', 'handler IRET');
            const final = await cpu.run({
              budget: 1n,
              repeatBudget: 2n,
              eventDelivery: { budget: 0n },
            });
            equal(final.reason, 'budget', 'remaining comparison completes');
            equal(final.repeatIterations, 2n, 'completed first element is not replayed');
            equal(final.state.registers[1], 0n, 'remaining count');
            equal(final.state.registers[6], 0x6003n, 'source progress');
            equal(final.state.registers[7], 0x6103n, 'destination progress');
            equal(final.state.flags, 0x246n, 'final equal comparison');
            numeric();
          },
          {
            data: [
              DESCRIPTORS,
              { base: STACK, bytes: FILL },
              { base: 0x8100n, bytes: gate(32, 8, 0x2000n, 0) },
              { base: 0x2000n, bytes: 'cf', execute: true },
              { base: 0x6000n, bytes: '112233' },
              { base: 0x6100n, bytes: '112233' },
            ],
          },
        );
      },
    },
    {
      name: 'external queued NMI cannot consume an SS interval until a privately resumed REP completes',
      async run() {
        await using(
          compiler,
          'f3a4',
          execution(),
          async (cpu) => {
            cpu.setState(
              input(0x1000n, { 1: 2n, 4: 0x8000n, 6: 0x6000n, 7: 0x6100n }, 0x202n, {
                sti: false,
                ss: true,
              }),
            );
            cpu.requestNmi();
            for (const repeatBudget of [0n, 1n, 0n]) {
              const partial = await cpu.run({
                budget: 1n,
                repeatBudget,
                eventDelivery: { budget: 1n },
              });
              equal(partial.reason, 'repeat-budget', 'incomplete REP remains inhibited');
              equal(partial.deliveryAttempts, 0n, 'no external attempt within REP');
              same(
                partial.state.interruptibility,
                { sti: false, ss: true },
                'private yield keeps SS interval',
              );
              same(partial.state.interrupts, { ...EMPTY, nmiPending: true }, 'latch retained');
            }
            const final = await cpu.run({
              budget: 1n,
              repeatBudget: 1n,
              eventDelivery: { budget: 1n },
            });
            equal(final.reason, 'budget', 'entry precedes completed REP budget');
            equal(final.retired, 1n, 'REP retires once');
            equal(final.repeatIterations, 1n, 'only remaining element completes');
            equal(final.deliveryAttempts, 1n, 'completion makes NMI eligible');
            equal(final.state.rip, 0x2000n, 'NMI handler');
            same(
              cpu.readMemory(0x7ff4n, 12),
              image([0x1002n, 8n, 0x202n], 4),
              'full-instruction continuation',
            );
            same(
              cpu.readMemory(0x6100n, 2),
              new Uint8Array([0x11, 0x22]),
              'completed stores retained',
            );
          },
          {
            data: [
              DESCRIPTORS,
              { base: STACK, bytes: FILL },
              { base: 0x8010n, bytes: gate(32, 8, 0x2000n, 0) },
              { base: 0x6000n, bytes: '1122' },
              { base: 0x6100n, bytes: 'a5a5' },
            ],
          },
        );
      },
    },
    {
      name: 'external inhibited queues reuse plain generated middle entries without per-instruction dispatch',
      async run() {
        await using(compiler, '83c001e2fb', execution(), async (cpu) => {
          for (const queued of [false, true]) {
            cpu.setState({
              ...input(0x1000n, { 0: 0n, 1: 1000n, 4: 0x8000n }),
              interrupts: { ...EMPTY, nmiBlocked: true },
            });
            if (queued) {
              cpu.requestInterrupt(0x20);
              cpu.requestNmi();
            }
            const result = await cpu.run({ budget: 2000n, eventDelivery: { budget: 1n } });
            equal(result.reason, 'budget', 'same guest work');
            equal(result.retired, 2000n, 'complete loop');
            equal(result.deliveryAttempts, 0n, 'inhibited requests remain unaccepted');
            equal(result.resources.nativeEntries, 1, 'no extra generated invocations');
            equal(result.resources.dispatches, 0, 'no instruction-by-instruction redispatch');
            equal(result.resources.compilations, queued ? 0 : 1, 'same artifact reused');
            const units = cpu.inspectTranslations();
            equal(units.length, 1, 'one artifact owner');
            check(!units[0]!.boundaryObserved, 'queues alone do not create a boundary observer');
            equal(result.state.registers[0], 1000n, 'arithmetic result');
            same(
              result.state.interrupts,
              { irq: queued ? 0x20 : null, nmiPending: queued, nmiBlocked: true },
              'retained queue',
            );
          }
        });
      },
    },
  ];
}
