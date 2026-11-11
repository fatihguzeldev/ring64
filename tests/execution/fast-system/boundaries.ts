import type { FastSystemState } from '../../../host/index.js';
import { longSnapshot } from '../../support/context.js';
import { preserveNumeric } from '../far-control/fixture.js';
import {
  BANK,
  PC,
  check,
  equal,
  hex,
  initial,
  same,
  usingPaged,
  type Scenario,
} from '../paging/fixture.js';

const TARGET = 0x401000n;
const fast = (): FastSystemState => ({
  star: 0x0020000800000000n,
  lstar: TARGET,
  fmask: 0n,
  sysenterCs: 8n,
  sysenterEip: TARGET,
  sysenterEsp: 0x403ff0n,
  kernelGsBase: 0x402000n,
});
function user() {
  const context = longSnapshot();
  context.cpl = 3;
  for (const [name, segment] of Object.entries(context.segments)) {
    segment.dpl = 3;
    segment.selector = name === 'cs' ? 0x33 : 0x2b;
  }
  return context;
}

export function fastSystemBoundaryScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'fast system SYSCALL and SYSRET sample resulting TF before target fetch and private gates',
      async run() {
        for (const entry of [false, true])
          for (const incoming of [false, true])
            for (const outgoing of [false, true])
              for (const deliver of [false, true]) {
                const context = entry ? user() : longSnapshot();
                await usingPaged(
                  compiler,
                  { code: entry ? '0f05' : '480f07', context, bank: { ...BANK, efer: 0xd01n } },
                  async (cpu) => {
                    cpu.setFastSystemState({ ...fast(), fmask: entry && !outgoing ? 0x100n : 0n });
                    const flags = 0x10202n | (incoming ? 0x100n : 0n);
                    const resultFlags = entry
                      ? flags & ~(0x10000n | (!outgoing ? 0x100n : 0n))
                      : outgoing
                        ? 0x302n
                        : 0x202n;
                    const expectTrap = entry ? incoming && outgoing : outgoing;
                    cpu.setState(
                      initial(
                        PC,
                        { 1: TARGET, 4: 0x800000000000n, 11: outgoing ? 0x10302n : 0x10202n },
                        flags,
                      ),
                    );
                    const numeric = preserveNumeric(cpu);
                    const result = await cpu.run({
                      budget: 1n,
                      ...(deliver ? { eventDelivery: { budget: 0n } } : {}),
                    });
                    equal(
                      result.reason,
                      expectTrap ? (deliver ? 'event-budget' : 'debug-exception') : 'budget',
                      'post-transfer TF rule',
                    );
                    equal(result.retired, 1n, 'transfer retires once');
                    equal(result.state.rip, TARGET, 'committed target without a fetch');
                    equal(result.state.flags, resultFlags, 'result flags');
                    equal(cpu.readContext().cpl, entry ? 0 : 3, 'destination privilege');
                    equal(
                      result.state.registers[4],
                      0x800000000000n,
                      'SYSRET and SYSCALL do not validate unchanged RSP',
                    );
                    equal(
                      cpu.readPagingState().cr2,
                      0n,
                      'unmapped target not fetched under exhausted budget',
                    );
                    if (entry) {
                      equal(result.state.registers[1], PC + 2n, 'literal saved next');
                      equal(
                        result.state.registers[11],
                        flags & ~0x10000n,
                        'R11 saved before masking after RF clear',
                      );
                    }
                    if (expectTrap) {
                      equal(cpu.readDebugState().dr6 & 0x4000n, 0x4000n, 'BS source');
                      if (deliver) {
                        check(result.state.event.kind === 'pending', 'frozen debug source');
                        equal(result.state.event.exception.vector, 1, 'DB vector');
                        equal(
                          result.state.event.exception.returnPc,
                          TARGET,
                          'destination trap boundary',
                        );
                        equal(result.deliveryAttempts, 0n, 'transfer is not delivery');
                      } else {
                        equal(result.debugException?.instructionPc, PC, 'source instruction');
                        equal(
                          result.debugException?.resumePc,
                          TARGET,
                          'trap before destination fetch',
                        );
                      }
                    } else equal(cpu.readDebugState().dr6 & 0x4000n, 0n, 'no incoming-TF leakage');
                    numeric();
                  },
                );
              }
      },
    },
    {
      name: 'fast system ordinary completion exposes NMI and restored-IF IRQ before last-budget gates',
      async run() {
        for (const kind of ['syscall', 'sysenter', 'sysret'] as const) {
          const returning = kind === 'sysret';
          await usingPaged(
            compiler,
            {
              code: kind === 'syscall' ? '0f05' : returning ? '480f07' : '0f34',
              context: returning ? longSnapshot() : user(),
              bank: { ...BANK, efer: 0x501n },
            },
            async (cpu) => {
              cpu.setFastSystemState(fast());
              cpu.setState({
                ...initial(PC, { 1: TARGET, 11: 0x202n }, 2n),
                interruptibility: { sti: false, ss: !returning },
                interrupts: {
                  irq: returning ? 0x20 : null,
                  nmiPending: !returning,
                  nmiBlocked: false,
                },
              });
              const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
              equal(result.reason, 'event-budget', 'accepted event beats exhausted budget');
              equal(result.retired, 1n, 'transfer retired');
              equal(result.deliveryAttempts, 0n, 'no implicit delivery attempt');
              check(result.state.event.kind === 'pending-interrupt', 'frozen external source');
              same(
                result.state.event.interrupt.source,
                returning ? { kind: 'irq', vector: 0x20 } : { kind: 'nmi' },
                'correct eligibility source',
              );
              equal(result.state.event.interrupt.returnPc, TARGET, 'destination source');
              equal(cpu.readContext().cpl, returning ? 3 : 0, 'destination privilege');
              same(
                result.state.interruptibility,
                { sti: false, ss: false },
                'synthetic SS does not create inhibition',
              );
            },
          );
        }
      },
    },
    {
      name: 'fast system completion consumes SS-deferred history and preserves independent NMI blocking',
      async run() {
        for (const code of ['0f05', '0f34', '480f07', '480f35', '0f01f8']) {
          const entering = code === '0f05' || code === '0f34';
          await usingPaged(
            compiler,
            { code, context: entering ? user() : longSnapshot(), bank: { ...BANK, efer: 0x501n } },
            async (cpu) => {
              cpu.setFastSystemState(fast());
              cpu.setState({
                ...initial(PC, { 1: TARGET, 2: TARGET, 11: 2n }, 2n),
                interruptibility: { sti: false, ss: true },
                debugContinuation: { breakpoints: 1, originPc: PC - 0x10n },
                interrupts: { irq: null, nmiPending: true, nmiBlocked: true },
              });
              const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
              equal(result.reason, 'event-budget', 'historical data source precedes budget');
              equal(result.retired, 1n, 'completed instruction');
              check(result.state.event.kind === 'pending', 'selected historical DB');
              equal(result.state.event.exception.vector, 1, 'DB');
              const debug = result.state.event.exception.debug;
              check(debug?.class === 'trap', 'typed data completion');
              equal(debug.breakpoints, 1, 'historical slot survives inactive DR7');
              equal(debug.deferredOriginPc, PC - 0x10n, 'oldest origin');
              equal(
                result.state.event.exception.returnPc,
                code === '0f01f8' ? PC + 3n : TARGET,
                'new boundary',
              );
              equal(result.state.interrupts.nmiBlocked, true, 'no invented NMI unblock');
              equal(result.state.interrupts.nmiPending, true, 'blocked source not consumed');
              equal(cpu.readDebugState().dr6 & 1n, 1n, 'historical cause published');
            },
          );
        }
      },
    },
    {
      name: 'fast system source and destination execute breakpoints are separate from entry retirement',
      async run() {
        for (const source of [false, true]) {
          await usingPaged(
            compiler,
            {
              code: '0f05',
              context: user(),
              bank: { ...BANK, efer: 0x501n },
              words: [[0x4008n, 0xa003n]],
              spans: [{ physical: 0xa000n, bytes: hex('90'), execute: true }],
            },
            async (cpu) => {
              cpu.setFastSystemState(fast());
              cpu.setDebugState({
                addresses: [source ? PC : TARGET, 0n, 0n, 0n],
                dr6: 0n,
                dr7: 0x401n,
              });
              cpu.setState(initial(PC));
              const result = await cpu.run({ budget: 2n });
              equal(result.reason, 'debug-exception', 'execute DB');
              equal(
                result.retired,
                source ? 0n : 1n,
                'entry retirement independent of target execute fault',
              );
              equal(
                result.debugException?.instructionPc,
                source ? PC : TARGET,
                'actual execute boundary',
              );
              equal(cpu.readContext().cpl, source ? 3 : 0, 'CPL before execute');
              equal(
                result.state.registers[1],
                source ? initial().registers[1] : PC + 2n,
                'no replay or premature register save',
              );
            },
          );
        }
      },
    },
  ];
}
