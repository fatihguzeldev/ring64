import { createCpu, type ExecutionContextSnapshot } from '../../../host/index.js';
import { usingPaged, PC } from '../paging/fixture.js';
import {
  legacyOptions,
  little,
  word,
  hex,
  initial,
  equal,
  check,
  protectedSnapshot,
  type Scenario,
} from './fixture.js';

function userContext(): ExecutionContextSnapshot {
  const context = protectedSnapshot();
  context.cpl = 3;
  for (const name of ['cs', 'ss', 'ds', 'es', 'fs', 'gs'] as const) {
    context.segments[name].selector = name === 'cs' ? 0x1b : 0x23;
    context.segments[name].dpl = 3;
  }
  context.gdtr = { base: 0x7000n, limit: 0x27 };
  context.idtr = { base: 0x8000n, limit: 0x77 };
  context.tr = { selector: 0x28, valid: true, base: 0xb000n, limit: 0x67, attributes: 0x8b };
  return context;
}
export function legacyEventScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...[false, true].flatMap((pae) =>
      [false, true].map((privateFrame) => ({
        name: `legacy ${pae ? 'PAE' : 'nonPAE'} guest PF repair${privateFrame ? ' after private frame refusal' : ''}`,
        async run() {
          const options = legacyOptions(compiler, pae, '890b');
          const bytes = options.memory!.backings[0]!.bytes;
          const pt = pae ? 0x4000 : 0x2000,
            width = pae ? 8 : 4;
          for (const [index, value] of [
            [4, 0xc003n],
            [6, 0xa005n],
            [7, 0xd003n],
            [8, 0xe003n],
            [10, BigInt(pt) | 3n],
            [11, 0xf003n],
          ] as const)
            bytes.set(little(value, width), pt + index * width);
          bytes.set(
            hex('0000000000000000ffff0000009bcf00ffff00000093cf00ffff000000fbcf00ffff000000f3cf00'),
            0xd000,
          );
          bytes.set(hex('00400800008e0000'), 0xe070);
          bytes.set(little(0x9000n, 4), 0xf004);
          bytes.set(little(0x10n, 2), 0xf008);
          bytes.set(
            hex(
              pae
                ? '0f20d0830d30a00000020f013d0060000083c404cf'
                : '0f20d0830d18a00000020f013d0060000083c404cf',
            ),
            0xc000,
          );
          options.context = userContext();
          const cpu = await createCpu(options);
          const mappings = (writable: boolean) => [
            {
              base: 0n,
              backing: 'ram',
              offset: 0,
              length: 0xe000,
              permissions: { read: true, write: true, execute: true },
            },
            {
              base: 0xe000n,
              backing: 'ram',
              offset: 0xe000,
              length: 0x1000,
              permissions: { read: true, write: writable, execute: true },
            },
            {
              base: 0xf000n,
              backing: 'ram',
              offset: 0xf000,
              length: 0x1000,
              permissions: { read: true, write: true, execute: true },
            },
          ];
          try {
            cpu.setState(initial(0x1000n, { 1: 0x11223344n, 3: 0x6000n, 4: 0xc000n }, 0x202n));
            if (privateFrame) {
              cpu.setMappings(mappings(false));
              const first = await cpu.run({ budget: 10n, eventDelivery: { budget: 1n } });
              equal(first.reason, 'physical-memory-fault', 'private frame refusal');
              equal(first.retired, 0n, 'uncommitted source');
              equal(first.state.event.kind, 'pending', 'frozen PF retained');
              check(
                first.state.event.kind === 'pending' && first.state.event.exception.vector === 14,
                'typed PF pending',
              );
              equal(first.state.event.exception.pageFaultAddress, 0x6000n, 'captured address');
              equal(word(cpu, 0xefe8n), 0n, 'no partial frame');
              equal(word(cpu, 0xeff0n), 0n, 'no partial frame middle');
              equal(word(cpu, 0xeff8n), 0n, 'no partial frame end');
              cpu.setMappings(mappings(true));
            }
            const result = await cpu.run({
              budget: 10n,
              stop: 0x1002n,
              eventDelivery: { budget: 1n },
            });
            equal(result.reason, 'stop', 'resumed after original store');
            equal(result.retired, 6n, 'five handler plus retried store');
            equal(result.remaining, 4n, 'budget');
            equal(result.deliveryAttempts, 1n, 'one entry');
            equal(result.state.rip, 0x1002n, 'user successor');
            equal(result.state.registers[4], 0xc000n, 'old ESP');
            equal(result.state.flags, 0x202n, 'flags restored');
            equal(cpu.readContext().cpl, 3, 'old CPL');
            equal(word(cpu, 0xa000n, 4), 0x11223344n, 'one final payload');
            equal(word(cpu, BigInt(pt + 6 * width), width), 0xa067n, 'repaired leaf AD');
            for (const [i, expected] of [7n, 0x1000n, 0x1bn, 0x10202n, 0xc000n, 0x23n].entries())
              equal(word(cpu, 0xefe8n + BigInt(i * 4), 4), expected, 'literal legacy frame');
          } finally {
            cpu.dispose();
          }
        },
      })),
    ),
    {
      name: 'historic IA32e high canonical PF survives physical legacy restore and legacy entry',
      async run() {
        const high = 0xffff800000006000n;
        let saved: ReturnType<import('../../../host/index.js').Cpu['readState']> | undefined;
        await usingPaged(compiler, { code: '8b03' }, async (cpu) => {
          cpu.setState(initial(PC, { 3: high }));
          const first = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
          equal(first.reason, 'event-budget', 'staged old source');
          saved = first.state;
          check(
            saved.event.kind === 'pending' && saved.event.exception.vector === 14,
            'old captured PF',
          );
          equal(saved.event.exception.pageFaultAddress, high, 'high source');
        });
        check(saved, 'snapshot captured');
        const options = legacyOptions(compiler);
        const bytes = options.memory!.backings[0]!.bytes;
        for (const [index, value] of [
          [4, 0xc003n],
          [7, 0xd003n],
          [8, 0xe003n],
          [9, 0xf003n],
        ] as const)
          bytes.set(little(value, 4), 0x2000 + index * 4);
        bytes.set(hex('0000000000000000ffff0000009bcf00ffff00000093cf00'), 0xe000);
        bytes.set(hex('00400800008e0000'), 0xd070);
        const context = protectedSnapshot();
        context.gdtr = { base: 0x8000n, limit: 0x17 };
        context.idtr = { base: 0x7000n, limit: 0x77 };
        options.context = context;
        const cpu = await createCpu(options);
        try {
          const registers = [...saved.registers];
          registers[4] = 0xa000n;
          cpu.setState({ ...saved, registers });
          const bank = cpu.readPagingState();
          cpu.setPagingState({ ...bank, cr2: 0x7777n });
          const pending = cpu.readState().event;
          check(
            pending.kind === 'pending' && pending.exception.vector === 14,
            'cross-family source retained',
          );
          equal(pending.exception.pageFaultAddress, high, 'source independent of live width/CR2');
          const entered = await cpu.run({
            budget: 1n,
            stop: 0x4000n,
            eventDelivery: { budget: 1n },
          });
          equal(entered.reason, 'stop', 'legacy handler stop');
          equal(entered.retired, 0n, 'entry does not retire');
          equal(entered.deliveryAttempts, 1n, 'legacy entry once');
          equal(cpu.readContext().mode, 'protected', 'legacy family');
          equal(entered.state.registers[4], 0x9ff0n, 'four dword same-CPL error frame');
          for (const [i, expected] of [0n, PC, 8n, 0x10002n].entries())
            equal(word(cpu, 0xfff0n + BigInt(i * 4), 4), expected, 'historical fault legacy frame');
          equal(
            cpu.readPagingState().cr2,
            0x7777n,
            'entry uses repaired live bank without rewriting historical address',
          );
        } finally {
          cpu.dispose();
        }
      },
    },
  ];
}
