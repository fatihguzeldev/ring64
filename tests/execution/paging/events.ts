import { type Cpu, type EventState } from '../../../host/index.js';
import { longSnapshot } from '../../support/context.js';
import { gate } from '../software-events/fixture.js';
import { preserveNumeric } from '../far-control/fixture.js';
import {
  BANK,
  PC,
  equal,
  hex,
  initial,
  little,
  same,
  usingPaged,
  word,
  type PagedSetup,
  type Scenario,
} from './fixture.js';

const HANDLER = 0x401000n;
const TOP = 0x405000n;
const FRAME = 0xdfd0n;

function setup(
  options: { code?: string; handler?: string; missingStack?: boolean; doubleStack?: boolean } = {},
): PagedSetup {
  const context = longSnapshot();
  context.gdtr = { base: 0x402000n, limit: 0x3f };
  context.idtr = { base: 0x403000n, limit: 0xfff };
  context.tr = { selector: 0x28, valid: true, base: 0x409000n, limit: 0x67, attributes: 0x8b };
  const gdt = new Uint8Array(0x1000);
  gdt.set(little([0x00af9b000000ffffn, 0x00cf93000000ffffn]), 8);
  const idt = new Uint8Array(0x1000);
  for (const vector of [1, 2, 6, 8, 13, 14, 0x30])
    idt.set(
      hex(
        gate(
          64,
          8,
          vector === 8 && options.doubleStack ? 0x407000n : HANDLER,
          3,
          false,
          vector === 8 && options.doubleStack ? 1 : 0,
        ),
      ),
      vector * 16,
    );
  const tss = new Uint8Array(0x1000);
  tss.set(little([0x407000n]), 36);
  const handler = new Uint8Array(0x1000).fill(0x82);
  handler.set(hex(options.handler ?? 'f4'));
  return {
    code: options.code ?? '488b0390',
    context,
    bank: { ...BANK, cr0: 0x80010033n, efer: 0xd00n },
    words: [
      [0x4008n, 0xa007n],
      [0x4010n, 0xb007n],
      [0x4018n, 0xc007n],
      [0x4020n, options.missingStack ? 0n : 0xd007n],
      [0x4028n, 0x4007n],
      [0x4030n, options.doubleStack ? 0n : 0xf007n],
      [0x4038n, 0x10007n],
      [0x4048n, 0x12007n],
    ],
    spans: [
      { physical: 0xa000n, bytes: handler, execute: true },
      { physical: 0xb000n, bytes: gdt },
      { physical: 0xc000n, bytes: idt },
      { physical: 0xd000n, bytes: new Uint8Array(0x1000).fill(0xa5) },
      { physical: 0xe000n, bytes: little([0x8877665544332211n]) },
      { physical: 0xf000n, bytes: new Uint8Array(0x1000).fill(0xa5) },
      { physical: 0x10000n, bytes: hex('f4'), execute: true },
      { physical: 0x12000n, bytes: tss },
    ],
  };
}

function pending(address = 0x501000n, errorCode = 6): EventState {
  return {
    kind: 'pending',
    exception: {
      vector: 14,
      instructionPc: PC - 0x10n,
      returnPc: PC,
      savedFlags: 0x10202n,
      errorCode,
      pageFaultAddress: address,
    },
  };
}

function selected(cpu: Cpu, event = pending()): void {
  cpu.setState({ ...initial(PC, { 4: TOP, 3: 0x500000n }, 0x202n), event });
}

export function pagingEventScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'paging guest PF handler reads CR2 repairs a PTE invalidates and IRET retries the source once',
      async run() {
        // CR2->R10; PTE[256]=e007 through VA405800; INVLPG[RBX]; discard error; IRETQ.
        const handler = '410f20d248b807e000000000000048b900584000000000004889010f013b4883c40848cf';
        await usingPaged(compiler, setup({ handler }), async (cpu) => {
          const before = initial(PC, { 3: 0x500000n, 4: TOP }, 0x202n);
          cpu.setState(before);
          const numeric = preserveNumeric(cpu);
          cpu.setDebugState({
            addresses: [PC, 0x500000n, 0x404fd8n, 0n],
            dr6: 0x6000n,
            dr7: 0x400n,
          });
          const debug = cpu.readDebugState();
          const first = await cpu.run({
            budget: 20n,
            stop: HANDLER,
            eventDelivery: { budget: 1n },
          });
          equal(first.reason, 'stop', 'handler boundary');
          equal(first.retired, 0n, 'faulting MOV did not retire');
          equal(first.deliveryAttempts, 1n, 'one PF entry');
          equal(first.state.registers[4], 0x404fd0n, 'one qword error frame');
          equal(cpu.readPagingState().cr2, 0x500000n, 'data linear address');
          same(
            cpu.readPhysicalMemory(FRAME, 48),
            little([0n, PC, 8n, 0x10202n, TOP, 16n]),
            'literal error RIP CS FLAGS RSP SS',
          );
          same(
            cpu.readPhysicalMemory(FRAME - 16n, 16),
            new Uint8Array(16).fill(0xa5),
            'lower frame guard',
          );
          const result = await cpu.run({
            budget: 20n,
            stop: PC + 3n,
            eventDelivery: { budget: 0n },
          });
          equal(result.reason, 'stop', 'source successor');
          equal(result.retired, 8n, 'seven handler instructions plus one successful source MOV');
          equal(result.deliveryAttempts, 0n, 'no second fault or entry');
          equal(result.state.registers[0], 0x8877665544332211n, 'retried data read');
          equal(result.state.registers[10], 0x500000n, 'guest CR2 read');
          equal(result.state.registers[4], TOP, 'IRET restores stack');
          equal(result.state.flags, 0x202n, 'retry consumes saved RF');
          equal(word(cpu, 0x4800n), 0xe027n, 'repaired data PTE acquired A without D');
          same(result.state.event, { kind: 'ready' }, 'no residual pending source');
          numeric();
          same(cpu.readDebugState(), debug, 'debug bank preserved');
        });
      },
    },
    {
      name: 'paging frozen PF import survives bank repair option omission and entry without reconstructing CR2',
      async run() {
        await usingPaged(compiler, setup(), async (cpu) => {
          const event = pending();
          selected(cpu, event);
          cpu.setPagingState({ ...cpu.readPagingState(), cr2: 0xffffffffffffffffn, efer: 0x500n });
          cpu.setState(cpu.readState());
          const limited = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
          equal(limited.reason, 'event-budget', 'frozen source waits for allowance');
          same(limited.state.event, event, 'original captured address and code');
          equal(limited.deliveryAttempts, 0n, 'no entry attempted');
          const omitted = await cpu.run({ budget: 1n });
          equal(omitted.reason, 'pending-exception', 'omitted delivery policy reports pending');
          same(omitted.state.event, event, 'omission retains source');
          const entered = await cpu.run({
            budget: 1n,
            stop: HANDLER,
            eventDelivery: { budget: 1n },
          });
          equal(entered.reason, 'stop', 'repaired current bank admits handler');
          equal(entered.retired, 0n, 'entry does not retire');
          equal(
            cpu.readPagingState().cr2,
            0xffffffffffffffffn,
            'retry does not overwrite repaired CR2',
          );
          equal(word(cpu, FRAME), 6n, 'frozen user-write error remains six at current CPL0');
          equal(word(cpu, FRAME + 8n), PC, 'frozen return boundary');
        });
      },
    },
    {
      name: 'paging source PF and contributory sources fold asymmetrically when the handler frame page is absent',
      async run() {
        for (const [source, expected] of [
          ['pf', 8],
          ['gp', 14],
          ['ud', 14],
        ] as const)
          await usingPaged(
            compiler,
            setup({ missingStack: true, code: source === 'ud' ? '0f0b' : '488b03' }),
            async (cpu) => {
              cpu.setState(
                initial(PC, { 3: source === 'gp' ? 0x800000000000n : 0x500000n, 4: TOP }, 0x202n),
              );
              const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 1n } });
              equal(result.reason, 'event-budget', `${source} secondary waits`);
              equal(result.retired, 0n, 'no source or handler instruction completed');
              equal(result.deliveryAttempts, 1n, 'one failed entry');
              equal(cpu.readPagingState().cr2, 0x404ff8n, 'secondary frame fault overwrites CR2');
              equal(result.state.event.kind, 'pending', 'secondary selected');
              if (result.state.event.kind !== 'pending')
                throw new Error('missing secondary source');
              equal(result.state.event.exception.vector, expected, `${source} class result`);
              equal(
                result.state.event.exception.errorCode,
                expected === 8 ? 0 : 2,
                'DF0 versus supervisor write PF2',
              );
              if (result.state.event.exception.vector === 14)
                equal(
                  result.state.event.exception.pageFaultAddress,
                  0x404ff8n,
                  'frozen secondary linear address',
                );
              same(
                cpu.readPhysicalMemory(0xdfd0n, 48),
                new Uint8Array(48).fill(0xa5),
                'no partial frame',
              );
            },
          );
      },
    },
    {
      name: 'paging nested PF updates CR2 again during DF entry and reaches bounded shutdown',
      async run() {
        await usingPaged(
          compiler,
          setup({ missingStack: true, doubleStack: true }),
          async (cpu) => {
            cpu.setState(initial(PC, { 3: 0x500000n, 4: TOP }, 0x202n));
            const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 2n } });
            equal(result.reason, 'shutdown', 'DF frame PF shuts down');
            equal(result.deliveryAttempts, 2n, 'PF and DF attempts only');
            equal(result.retired, 0n, 'no instruction or frame completed');
            equal(
              cpu.readPagingState().cr2,
              0x406ff8n,
              'DF IST failure replaces the previous 404ff8 address',
            );
            same(result.state.event, { kind: 'shutdown' }, 'obsolete PF metadata dropped');
            same(
              cpu.readPhysicalMemory(0xffd0n, 48),
              new Uint8Array(48).fill(0xa5),
              'DF frame guard',
            );
          },
        );
      },
    },
    {
      name: 'paging IRQ14 and NMI remain benign sources while frame PF retains accepted NMI blocking',
      async run() {
        for (const nmi of [false, true])
          await usingPaged(compiler, setup({ missingStack: true }), async (cpu) => {
            cpu.setState(initial(PC, { 4: TOP }, 0x202n));
            if (nmi) cpu.requestNmi();
            else equal(cpu.requestInterrupt(14), true, 'IRQ accepted into queue');
            const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 1n } });
            equal(result.reason, 'event-budget', 'secondary PF waits');
            equal(result.retired, 0n, 'external entry precedes source code');
            equal(result.deliveryAttempts, 1n, 'one external entry attempt');
            equal(result.state.event.kind, 'pending', 'processor PF selected');
            if (result.state.event.kind !== 'pending') throw new Error('missing PF');
            equal(
              result.state.event.exception.vector,
              14,
              'IRQ vector14 is not an original processor PF',
            );
            equal(
              result.state.event.exception.errorCode,
              2,
              'supervisor write has no EXT pollution',
            );
            equal(
              result.state.interrupts.nmiBlocked,
              nmi,
              'accepted NMI block survives entry fault',
            );
            equal(result.state.interrupts.nmiPending, false, 'accepted external source consumed');
            equal(word(cpu, 0x4000n), 0x9007n, 'no actual code fetch before external admission');
          });
      },
    },
    {
      name: 'paging IRET required-code PF preserves NMI block while frame PF early-unblocks before synchronous reporting',
      async run() {
        for (const frame of [false, true]) {
          const fixture = setup({
            code: frame ? '48cf' : '82'.repeat(4095) + '48',
            missingStack: frame,
          });
          if (!frame) fixture.words = [...fixture.words!, [0x4008n, 0n]];
          await usingPaged(compiler, fixture, async (cpu) => {
            const pc = frame ? PC : PC + 4095n;
            cpu.setState({
              ...initial(pc, { 4: 0x404fc0n }, 0x10202n),
              interrupts: { irq: null, nmiPending: true, nmiBlocked: true },
            });
            const result = await cpu.run({ budget: 1n });
            equal(result.reason, 'page-fault', 'required code/frame source');
            equal(result.retired, 0n, 'IRET has not completed');
            equal(result.state.rip, pc, 'restart at IRET or its prefix');
            equal(
              result.pageFault?.address,
              frame ? 0x404fc0n : 0x401000n,
              'precise missing linear page',
            );
            equal(result.pageFault?.errorCode, frame ? 0 : 16, 'read versus NXE-enabled fetch');
            equal(result.state.interrupts.nmiBlocked, !frame, 'only begun IRET unblocks');
            equal(
              result.state.interrupts.nmiPending,
              true,
              'newly eligible NMI cannot replace synchronous PF',
            );
            equal(result.state.flags, frame ? 0x202n : 0x10202n, 'pre/post begin RF');
          });
        }
      },
    },
    {
      name: 'paging completed PF entry is not replayed when private handler artifact admission refuses repeatedly',
      async run() {
        await usingPaged(
          compiler,
          { ...setup({ handler: '90' }), limits: { maxArtifactBytes: 1 } },
          async (cpu) => {
            selected(cpu);
            for (const attempt of [0, 1]) {
              const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 1n } });
              equal(result.reason, 'resource-limit', 'private handler admission');
              equal(result.retired, 0n, 'handler has not executed');
              equal(result.deliveryAttempts, attempt === 0 ? 1n : 0n, 'entry completes once');
              equal(result.state.rip, HANDLER, 'published handler continuation');
              equal(result.state.registers[4], 0x404fd0n, 'no second frame');
              same(result.state.event, { kind: 'ready' }, 'source already consumed');
              same(
                cpu.readPhysicalMemory(FRAME, 48),
                little([6n, PC, 8n, 0x10202n, TOP, 16n]),
                'same committed error frame',
              );
            }
          },
        );
      },
    },
    {
      name: 'paging ring3 PF entry uses supervisor metadata and target CPL0 stack then IRET restores the user',
      async run() {
        const fixture = setup({ handler: '4883c40848cf' });
        const context = longSnapshot();
        context.cpl = 3;
        for (const segment of ['cs', 'ss', 'ds', 'es', 'fs', 'gs'] as const) {
          context.segments[segment].selector = segment === 'cs' ? 0x1b : 0x23;
          context.segments[segment].dpl = 3;
        }
        context.gdtr = { base: 0x402000n, limit: 0x3f };
        context.idtr = { base: 0x403000n, limit: 0xfff };
        context.tr = {
          selector: 0x28,
          valid: true,
          base: 0x409000n,
          limit: 0x67,
          attributes: 0x8b,
        };
        fixture.context = context;
        fixture.words = [
          ...fixture.words!,
          [0x4010n, 0xb003n],
          [0x4018n, 0xc003n],
          [0x4020n, 0xd003n],
          [0x4048n, 0x12003n],
        ];
        fixture.spans = fixture.spans!.map((span) => {
          if (span.physical === 0xb000n)
            span.bytes.set(little([0x00affb000000ffffn, 0x00cff3000000ffffn]), 24);
          if (span.physical === 0x12000n) span.bytes.set(little([TOP]), 4);
          return span;
        });
        await usingPaged(compiler, fixture, async (cpu) => {
          cpu.setState(initial(PC, { 3: 0x500000n, 4: 0x501000n }, 0x202n));
          const entered = await cpu.run({
            budget: 3n,
            stop: HANDLER,
            eventDelivery: { budget: 1n },
          });
          equal(entered.reason, 'stop', 'supervisor metadata and new stack admitted');
          equal(entered.retired, 0n, 'user source faults');
          equal(cpu.readContext().cpl, 0, 'kernel handler privilege');
          equal(cpu.readPagingState().cr2, 0x500000n, 'original user fault remains CR2');
          same(
            cpu.readPhysicalMemory(FRAME, 48),
            little([4n, PC, 0x1bn, 0x10202n, 0x501000n, 0x23n]),
            'user read PF4 and original user frame',
          );
          const returned = await cpu.run({ budget: 3n, stop: PC, eventDelivery: { budget: 0n } });
          equal(returned.reason, 'stop', 'return boundary before uncorrected user retry');
          equal(returned.retired, 2n, 'error discard and IRET only');
          equal(cpu.readContext().cpl, 3, 'returned user privilege');
          equal(returned.state.registers[4], 0x501000n, 'old user stack restored');
          equal(returned.state.flags, 0x10202n, 'saved user RF/IF restored before begin');
          same(returned.state.event, { kind: 'ready' }, 'no spurious supervisor fault');
        });
      },
    },
    {
      name: 'paging all frame dirty admissions finish before any stack or aliased page-table payload publishes',
      async run() {
        const fixture = setup();
        fixture.words = [
          ...fixture.words!,
          [0x4000n, 0x9027n],
          [0x4008n, 0xa027n],
          [0x4010n, 0xb027n],
          [0x4018n, 0xc027n],
          [0x4020n, 0xd027n],
          [0x4028n, 0x4027n],
        ];
        fixture.tableWindows = [
          { physical: 0x1000n, offset: 0, length: 0x3020, write: true },
          { physical: 0x4020n, offset: 0x3020, length: 8, write: false },
          { physical: 0x4028n, offset: 0x3028, length: 0xfd8, write: true },
        ];
        await usingPaged(compiler, fixture, async (cpu) => {
          selected(cpu);
          cpu.setState({
            ...cpu.readState(),
            registers: cpu
              .readState()
              .registers.map((value, index) => (index === 4 ? 0x405010n : value)),
          });
          const table = cpu.readPhysicalMemory(0x4000n, 0x30);
          const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 1n } });
          equal(result.reason, 'physical-memory-fault', 'late leaf D is private refusal');
          equal(result.physicalMemoryFault?.phase, 'dirty-write', 'required D update');
          equal(result.retired, 0n, 'entry never completes');
          equal(cpu.readPagingState().cr2, 0n, 'private D refusal does not update CR2');
          equal(result.state.registers[4], 0x405010n, 'old stack pointer');
          same(result.state.event, pending(), 'original frozen PF survives');
          same(
            cpu.readPhysicalMemory(0x4000n, 0x30),
            table,
            'early page-table stack alias never publishes or dirties',
          );
          same(
            cpu.readPhysicalMemory(0xdfe0n, 32),
            new Uint8Array(32).fill(0xa5),
            'later frame page unchanged',
          );
        });
      },
    },
  ];
}
