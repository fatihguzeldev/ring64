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
  image,
  encoded,
  same,
  equal,
  check,
  preserveNumeric,
  type Scenario,
} from '../exception-delivery/fixture.js';
import { TSS } from '../software-events/fixture.js';

const HOLE = 0x800000000000n;

export function boundaryReviewScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'architectural boundary canonical start crossing differs from private u64 endpoint overflow for DS and SS',
      async run() {
        for (const [code, register, vector] of [
          ['488b03', 3, 13],
          ['488b0424', 4, 12],
        ] as const) {
          for (const overflow of [false, true]) {
            await using(compiler, code, snapshot(), async (cpu) => {
              cpu.setState(
                initial(
                  0x1000n,
                  { [register]: overflow ? 0xfffffffffffffffdn : HOLE - 4n },
                  0x10202n,
                ),
              );
              const before = cpu.readState();
              const numeric = preserveNumeric(cpu);
              const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
              equal(
                result.reason,
                overflow ? 'data-fault' : 'event-budget',
                'complete operand span geometry',
              );
              equal(result.retired, 0n, 'no partial operand or destination');
              same(result.state.registers, before.registers, 'all source banks preserved');
              equal(result.state.flags, 0x202n, 'instruction-begin RF clear');
              if (overflow) {
                same(result.state.event, { kind: 'ready' }, 'u64 endpoint stays private');
                equal(result.fault?.cause, 'address-range', 'private widened cause');
                equal(result.fault?.failingAddress, 1n << 64n, 'private first out-of-domain byte');
              } else
                same(
                  result.state.event,
                  {
                    kind: 'pending',
                    exception: {
                      vector,
                      instructionPc: 0x1000n,
                      returnPc: 0x1000n,
                      savedFlags: 0x10202n,
                      errorCode: 0,
                    },
                  },
                  'canonical start span crossing retains effective segment',
                );
              numeric();
            });
          }
        }
      },
    },
    {
      name: 'architectural boundary NMI live TSS fields retain selector EXT while missing and widened addresses stay private',
      async run() {
        for (const kind of ['noncanonical', 'missing', 'overflow'] as const) {
          const context = snapshot();
          context.segments.cs = loadedCode(64);
          context.segments.ss = loadedData(32);
          context.tr = {
            ...TSS,
            base:
              kind === 'noncanonical'
                ? HOLE - 4n
                : kind === 'overflow'
                  ? 0xffffffffffffffe0n
                  : 0x5000n,
          };
          const address = withGate(context, 2);
          await using(
            compiler,
            '90',
            context,
            async (cpu) => {
              cpu.setState(initial(0x1000n, { 4: 0x9000n }, 0x10202n));
              const before = cpu.readState();
              cpu.requestNmi();
              const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 1n } });
              equal(
                result.reason,
                kind === 'noncanonical' ? 'event-budget' : 'system-memory-fault',
                'TSS field priority',
              );
              equal(result.retired, 0n, 'zero-retirement entry');
              equal(result.deliveryAttempts, 1n, 'one debited attempt');
              same(
                result.state.registers,
                before.registers,
                'no frame or source state publication',
              );
              equal(result.state.flags, 0x10202n, 'acceptance has no instruction-begin effect');
              same(
                result.state.interrupts,
                { irq: null, nmiPending: false, nmiBlocked: true },
                'NMI acceptance survives refusal',
              );
              if (kind === 'noncanonical')
                same(
                  result.state.event,
                  {
                    kind: 'pending',
                    exception: {
                      vector: 10,
                      instructionPc: 0x1000n,
                      returnPc: 0x1000n,
                      savedFlags: 0x10202n,
                      errorCode: 0x29,
                    },
                  },
                  'TSS canonicality retains TS(selector|EXT), not generic GP0',
                );
              else {
                equal(
                  result.state.event.kind,
                  'pending-interrupt',
                  'private refusal retains accepted NMI',
                );
                check(result.systemMemoryFault?.table === 'tss', 'exact system table');
                equal(result.systemMemoryFault.selector, 0x28, 'loaded TR identity');
                equal(
                  result.systemMemoryFault?.cause,
                  kind === 'overflow' ? 'address-range' : 'unmapped',
                  'private field cause',
                );
                equal(
                  result.systemMemoryFault?.address,
                  kind === 'overflow' ? (1n << 64n) + 4n : 0x5024n,
                  'exact widened attempted field start',
                );
              }
              same(
                cpu.readMemory(STACK, 256),
                new Uint8Array(256).fill(0xa5),
                'whole guarded stack untouched',
              );
            },
            {
              data: [
                { base: 0x4008n, bytes: CODE64 + DATA32 },
                { base: address, bytes: gate(64, 8, 0x2000n, 0, false, 1) },
                { base: STACK, bytes: FILL },
              ],
            },
          );
        }
      },
    },
    {
      name: 'architectural boundary reached decode faults outrank exhausted translation quota without staging future faults',
      async run() {
        for (const [tail, vector, errorCode] of [
          ['f090', 6, undefined],
          ['66'.repeat(15), 13, 0],
        ] as const) {
          await using(
            compiler,
            '90' + tail,
            snapshot(),
            async (cpu) => {
              cpu.setState(initial(0x1000n, {}, 0x10202n));
              const first = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
              equal(first.reason, 'budget', 'unreached fault cannot consume last instruction gate');
              equal(first.resources.compilations, 1, 'ordinary predecessor compiled');
              same(first.state.event, { kind: 'ready' }, 'future fault not staged');
              cpu.setState(initial(0x1000n, {}, 0x10202n));
              const reached = await cpu.run({ budget: 2n, eventDelivery: { budget: 0n } });
              equal(reached.reason, 'event-budget', 'reached decode selection');
              equal(reached.retired, 1n, 'only predecessor retires');
              equal(reached.resources.compilations, 0, 'retained predecessor reused');
              same(
                reached.state.event,
                {
                  kind: 'pending',
                  exception: {
                    vector,
                    instructionPc: 0x1001n,
                    returnPc: 0x1001n,
                    savedFlags: 0x10202n,
                    ...(errorCode === undefined ? {} : { errorCode }),
                  },
                },
                'literal reached decode source',
              );
            },
            { limits: { maxInstructions: 1, maxTranslationsPerRun: 1 } },
          );
          await using(
            compiler,
            '90' + tail,
            snapshot(),
            async (cpu) => {
              cpu.setState(initial(0x1000n, {}, 0x10202n));
              const result = await cpu.run({ budget: 2n, eventDelivery: { budget: 0n } });
              equal(result.reason, 'event-budget', 'cold reached fault outranks exhausted quota');
              equal(result.resources.compilations, 1, 'quota spent by predecessor');
              equal(result.retired, 1n, 'one completed predecessor');
            },
            { limits: { maxInstructions: 1, maxTranslationsPerRun: 1 } },
          );
        }
      },
    },
    {
      name: 'architectural boundary too-small source admission distinguishes selected decode from valid data instruction begin',
      async run() {
        for (const [code, expected] of [
          ['f090', 'event-budget'],
          ['488b03', 'resource-limit'],
        ] as const) {
          await using(
            compiler,
            code,
            snapshot(),
            async (cpu) => {
              cpu.setState(initial(0x1000n, { 3: HOLE }, 0x10202n));
              const before = cpu.readState();
              const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
              equal(result.reason, expected, 'source-cap frontier');
              equal(result.retired, 0n, 'no admitted instruction');
              equal(result.deliveryAttempts, 0n, 'no entry attempt');
              if (expected === 'resource-limit')
                same(result.state, before, 'before-begin refusal preserves RF and event');
              else {
                equal(result.state.flags, 0x202n, 'selected decode applies begin RF clear');
                check(result.state.event.kind === 'pending', 'selected #UD');
                equal(result.state.event.exception.vector, 6, 'illegal encoding');
              }
            },
            { limits: { maxSourceBytes: 1 } },
          );
        }
      },
    },
    {
      name: 'architectural boundary IRET fault retains selection before queued unblocked NMI and applies handler gates',
      async run() {
        const context = snapshot();
        context.segments.cs = loadedCode(64);
        context.segments.ss = loadedData(32);
        context.tr = TSS;
        const ssGate = withGate(context, 12);
        await using(
          compiler,
          '48cf',
          context,
          async (cpu) => {
            cpu.setState({
              ...initial(0x1000n, { 4: HOLE }, 0x10002n),
              interrupts: { irq: 32, nmiPending: true, nmiBlocked: true },
            });
            const staged = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
            equal(staged.reason, 'event-budget', 'synchronous IRET #SS wins');
            same(
              staged.state.event,
              {
                kind: 'pending',
                exception: {
                  vector: 12,
                  instructionPc: 0x1000n,
                  returnPc: 0x1000n,
                  savedFlags: 0x10002n,
                  errorCode: 0,
                },
              },
              'literal selected source',
            );
            same(
              staged.state.interrupts,
              { irq: 32, nmiPending: true, nmiBlocked: false },
              'early unblock survives fault',
            );
            cpu.setState(staged.state);
            cpu.setMxcsr(0x1f80);
            const gated = await cpu.run({ budget: 0n, eventDelivery: { budget: 1n } });
            equal(gated.reason, 'budget', 'initial gate precedes retained delivery');
            same(gated.state, staged.state, 'checkpoint and numeric repair retain selected source');
            const entered = await cpu.run({
              budget: 1n,
              stop: 0x2000n,
              eventDelivery: { budget: 1n },
            });
            equal(entered.reason, 'stop', 'handler gate precedes new NMI acceptance');
            equal(entered.retired, 0n, 'automatic entry retires no instruction');
            equal(entered.deliveryAttempts, 1n, 'one completed SS frame');
            same(entered.state.event, { kind: 'ready' }, 'selected entry committed');
            same(
              entered.state.interrupts,
              { irq: 32, nmiPending: true, nmiBlocked: false },
              'queued sources retained at handler gate',
            );
            same(
              cpu.readMemory(0x7fd0n, 48),
              image([0n, 0x1000n, 8n, 0x10002n, HOLE, 16n], 8),
              'exact SS0 IST frame',
            );
            same(cpu.readMemory(STACK, 208), new Uint8Array(208).fill(0xa5), 'lower stack guard');
            const nmi = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
            equal(nmi.reason, 'event-budget', 'fresh handler boundary accepts NMI before fetch');
            same(
              nmi.state.event,
              {
                kind: 'pending-interrupt',
                interrupt: {
                  source: { kind: 'nmi' },
                  returnPc: 0x2000n,
                  savedFlags: 2n,
                },
              },
              'NMI captures new handler boundary',
            );
            same(
              nmi.state.interrupts,
              { irq: 32, nmiPending: false, nmiBlocked: true },
              'NMI accepted once',
            );
          },
          {
            data: [
              { base: 0x4008n, bytes: CODE64 + DATA32 },
              { base: ssGate, bytes: gate(64, 8, 0x2000n, 0, false, 1) },
              { base: 0x5024n, bytes: encoded(image([0x8000n], 8)) },
              { base: STACK, bytes: FILL },
            ],
          },
        );
      },
    },
    {
      name: 'architectural boundary noncanonical RET target differs from SS stack refusal and preserves all source publication',
      async run() {
        for (const privateRead of [false, true]) {
          await using(
            compiler,
            'c3',
            snapshot(),
            async (cpu) => {
              cpu.setState(initial(0x1000n, { 4: 0x6000n }, 0x10202n));
              const before = cpu.readState();
              const numeric = preserveNumeric(cpu);
              const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
              equal(
                result.reason,
                privateRead ? 'data-fault' : 'event-budget',
                'RET pointer before target',
              );
              equal(result.retired, 0n, 'RET not retired');
              same(result.state.registers, before.registers, 'RET SP and all banks not committed');
              equal(result.state.flags, 0x202n, 'RET began');
              if (!privateRead)
                same(cpu.readMemory(0x6000n, 8), image([HOLE], 8), 'stack slot unchanged');
              if (privateRead) {
                same(
                  result.state.event,
                  { kind: 'ready' },
                  'private read produces no guessed target event',
                );
                equal(result.fault?.cause, 'permission', 'exact private refusal');
              } else
                same(
                  result.state.event,
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
                  'noncanonical successfully read target is GP',
                );
              numeric();
            },
            { data: [{ base: 0x6000n, bytes: encoded(image([HOLE], 8)), read: !privateRead }] },
          );
        }
      },
    },
    {
      name: 'architectural boundary LDT index-zero descriptor reads preserve TI identity and private endpoint overflow',
      async run() {
        for (const overflow of [false, true]) {
          const context = snapshot();
          context.ldtr = {
            selector: 0x28,
            valid: true,
            base: overflow ? 0xfffffffffffffffen : 0x7ffffffffffcn,
            limit: 0xff,
            attributes: 0x82,
          };
          await using(compiler, '8ed8', context, async (cpu) => {
            cpu.setState(initial(0x1000n, { 0: 4n }, 0x10202n));
            const before = cpu.readContext();
            const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
            equal(result.reason, overflow ? 'system-memory-fault' : 'event-budget', 'LDT geometry');
            equal(result.retired, 0n, 'no selector/cache publication');
            same(cpu.readContext(), before, 'failed LDT read preserves all loaded facts');
            if (overflow) {
              check(result.systemMemoryFault?.table === 'ldt', 'LDT reference');
              equal(result.systemMemoryFault.selector, 4, 'TI1 index0 is not null');
              equal(result.systemMemoryFault?.cause, 'address-range', 'endpoint overflow private');
              equal(
                result.systemMemoryFault?.failingAddress,
                1n << 64n,
                'widened endpoint retained',
              );
              same(result.state.event, { kind: 'ready' }, 'private endpoint no event');
            } else
              same(
                result.state.event,
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
                'in-domain crossing selects GP0',
              );
          });
        }
      },
    },
  ];
}
