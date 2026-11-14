import { createCpu, type ExecutionContextSnapshot } from '../../../host/index.js';
import { exit, initial } from '../../support/fixture.js';
import { fixture, using, memory as physicalMemory, put } from '../supervisor-access/fixture.js';
import { gate } from '../software-events/fixture.js';
import {
  PC,
  RAM_BASE,
  RAM_SIZE,
  compoundProfiles,
  input,
  expected,
  linear,
  memory,
  same,
  equal,
  hex,
  type Scenario,
} from './compound-fixture.js';

export function compoundEventScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'compound one completed boundary combines actual data watchpoint with TF and suppresses both on later failure',
      async run() {
        const profile = compoundProfiles.at(-1)!;
        for (const fail of [false, true]) {
          const ram = new Uint8Array(RAM_SIZE).fill(0xa5),
            wanted = ram.slice();
          for (const [at, value] of [
            [0xff8, 0x6000n],
            [0xff0, 0xa5a5a5a5a5a5a5a5n],
            [0xfe8, 0xa5a5a5a5a5a5a5a5n],
            [0xfe0, 0x4ff8n],
          ] as const)
            put(wanted, at, value, 8);
          await linear(
            compiler,
            fail ? 'c8001003' : 'c8000003',
            profile,
            async (cpu) => {
              const before = input(profile, {}, 0x102n);
              cpu.setState(before);
              cpu.setTimeState({ tsc: 100n, tscAux: 0x89abcdef });
              cpu.setDebugState({ addresses: [0x4ff8n, 0n, 0n, 0n], dr6: 0n, dr7: 0x10401n });
              const debug = cpu.readDebugState(),
                result = await cpu.run({ budget: 1n, repeatBudget: 0n });
              exit(
                result,
                fail ? 'data-fault' : 'debug-exception',
                1n,
                fail ? 0n : 1n,
                fail ? before : expected(before, PC + 4n, { 4: 0x4fe0n, 5: 0x4ff8n }),
              );
              same(
                result.debugException,
                fail
                  ? undefined
                  : {
                      vector: 1,
                      class: 'trap',
                      cause: 'combined',
                      breakpoints: 1,
                      singleStep: true,
                      instructionPc: PC,
                      resumePc: PC + 4n,
                      instructionCompleted: true,
                      resumeFlags: 0x102n,
                    },
                'exact qualified compound debug source',
              );
              same(
                cpu.readDebugState(),
                { ...debug, dr6: fail ? debug.dr6 : debug.dr6 | 0x4001n },
                'no failed-instruction debug causes',
              );
              same(
                cpu.readTimeState(),
                { tsc: fail ? 100n : 101n, tscAux: 0x89abcdef },
                'one compound completion tick',
              );
              memory(
                cpu,
                RAM_BASE,
                wanted,
                'watchpoint sees completed payload even when final probe fails',
              );
            },
            { ram },
          );
        }
      },
    },
    {
      name: 'compound completion expires inherited SS STI suppression before last-budget IRQ or NMI capture',
      async run() {
        const profile = compoundProfiles.at(-1)!;
        for (const source of ['ss-nmi', 'ss-irq', 'sti-irq'] as const) {
          await linear(compiler, 'c8000003', profile, async (cpu) => {
            const before = input(profile, {}, 0x202n);
            before.interruptibility = { ss: source !== 'sti-irq', sti: source === 'sti-irq' };
            cpu.setState(before);
            cpu.setTimeState({ tsc: 100n, tscAux: 0x89abcdef });
            cpu.requestInterrupt(0x40);
            if (source === 'ss-nmi') cpu.requestNmi();
            const result = await cpu.run({
              budget: 1n,
              repeatBudget: 0n,
              eventDelivery: { budget: 0n },
            });
            equal(result.reason, 'event-budget', 'completion arbitration precedes final budget');
            equal(result.retired, 1n, 'one full compound instruction completed');
            equal(result.deliveryAttempts, 0n, 'capture is not an entry attempt');
            const nmi = source === 'ss-nmi';
            same(
              result.state,
              {
                ...expected(before, PC + 4n, { 4: 0x4fe0n, 5: 0x4ff8n }),
                interruptibility: { ss: false, sti: false },
                event: {
                  kind: 'pending-interrupt',
                  interrupt: {
                    source: nmi ? { kind: 'nmi' } : { kind: 'irq', vector: 0x40 },
                    returnPc: PC + 4n,
                    savedFlags: 0x202n,
                  },
                },
                interrupts: { irq: nmi ? 0x40 : null, nmiPending: false, nmiBlocked: nmi },
              },
              'external source observes final compound state',
            );
            same(
              cpu.readTimeState(),
              { tsc: 101n, tscAux: 0x89abcdef },
              'external capture adds no virtual instruction',
            );
            const wanted = new Uint8Array(RAM_SIZE).fill(0xa5);
            for (const [at, value] of [
              [0xff8, 0x6000n],
              [0xff0, 0xa5a5a5a5a5a5a5a5n],
              [0xfe8, 0xa5a5a5a5a5a5a5a5n],
              [0xfe0, 0x4ff8n],
            ] as const)
              put(wanted, at, value, 8);
            memory(cpu, RAM_BASE, wanted, 'no event enters between display slots');
          });
        }
      },
    },
    {
      name: 'compound guest PF handler repairs endpoint PTE invalidates IRETs and retries ENTER once',
      async run() {
        for (const family of ['non-pae', 'pae'] as const) {
          const side = { createCpu, compiler },
            f = fixture(side, family, 'c8003000', { bits: 32 });
          f.leaf(0x3000, 0n);
          f.leaf(0x5000, BigInt(f.pt) | 0x63n);
          const slot = 0x5000 + 3 * f.width;
          const handler =
            'c705' +
            [slot & 255, slot >> 8, 0, 0].map((v) => v.toString(16).padStart(2, '0')).join('') +
            '07300100' +
            '0f013b83c404cf';
          f.bytes.set(hex(handler), 0x9000);
          f.bytes.set(hex(gate(32, 8, 0x4000n, 0)), 0xc000 + 14 * 8);
          const context = f.options.context as ExecutionContextSnapshot;
          context.idtr = { base: 0x8000n, limit: 0x7ff };
          await using(side, f, async (cpu) => {
            const before = initial(PC, { 3: 0x3ffcn, 4: 0x7000n, 5: 0x8000n }, 0x202n);
            cpu.setState(before);
            cpu.setTimeState({ tsc: 100n, tscAux: 0x89abcdef });
            const entered = await cpu.run({
              budget: 10n,
              stop: 0x4000n,
              repeatBudget: 0n,
              eventDelivery: { budget: 1n },
            });
            equal(entered.reason, 'stop', 'actual PF handler reached');
            equal(entered.retired, 0n, 'failed ENTER and automatic entry do not retire');
            equal(entered.deliveryAttempts, 1n, 'one PF entry');
            equal(cpu.readPagingState().cr2, 0x3ffcn, 'endpoint CR2');
            same(
              entered.state,
              { ...expected(before, 0x4000n, { 4: 0x6ff0n }), flags: 2n },
              'fault GPR rollback feeds handler frame',
            );
            same(
              cpu.readPhysicalMemory(0xaff0n, 16),
              hex('02000000001000000800000002020100'),
              'PF frame literal error IP CS RF',
            );
            const result = await cpu.run({
              budget: 10n,
              stop: PC + 4n,
              repeatBudget: 0n,
              eventDelivery: { budget: 1n },
            });
            equal(result.reason, 'stop', 'IRETD retries source then reaches next PC');
            equal(result.retired, 5n, 'four handler instructions and successful ENTER');
            equal(result.deliveryAttempts, 0n, 'no replayed entry');
            same(
              result.state,
              expected(before, PC + 4n, { 4: 0x3ffcn, 5: 0x6ffcn }),
              'literal repaired complete bank',
            );
            same(
              cpu.readTimeState(),
              { tsc: 105n, tscAux: 0x89abcdef },
              'handler and retried instruction ledger',
            );
            const wanted = f.bytes.slice();
            put(wanted, f.pt + 3 * f.width, 0x13027n, f.width);
            for (const [at, value] of [
              [0xaff0, 2n],
              [0xaff4, PC],
              [0xaff8, 8n],
              [0xaffc, 0x8000n],
            ] as const)
              put(wanted, at, value, 4);
            physicalMemory(cpu, wanted, 'handler PTE and exact retained overwritten frame');
          });
        }
      },
    },
  ];
}
