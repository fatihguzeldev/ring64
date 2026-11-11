import { createCpu, type ExecutionContextSnapshot } from '../../../host/index.js';
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

function vmContext(): ExecutionContextSnapshot {
  const context = protectedSnapshot();
  context.mode = 'virtual8086';
  context.cpl = 3;
  for (const name of ['cs', 'ss', 'ds', 'es', 'fs', 'gs'] as const) {
    Object.assign(context.segments[name], {
      selector: 0,
      base: 0n,
      limit: 0xffff,
      default32: false,
      type: 'read-write',
      dpl: 3,
      granularity: false,
    });
  }
  return context;
}
export function legacyModeScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...[false, true].map((pae) => ({
      name: `legacy ${pae ? 'PAE' : 'nonPAE'} protected16 word gate uses four word PF slots`,
      async run() {
        const options = legacyOptions(compiler, pae, '8907');
        const context = protectedSnapshot();
        context.segments.cs.default32 = false;
        context.segments.ss.default32 = false;
        context.gdtr = { base: 0x7000n, limit: 0x17 };
        context.idtr = { base: 0x8000n, limit: 0x77 };
        options.context = context;
        options.paging!.cr0 |= 0x10000n;
        const bytes = options.memory!.backings[0]!.bytes,
          pt = pae ? 0x4000 : 0x2000,
          width = pae ? 8 : 4;
        for (const [index, value] of [
          [4, 0xc003n],
          [6, 0xa001n],
          [7, 0xd003n],
          [8, 0xe003n],
        ] as const)
          bytes.set(little(value, width), pt + index * width);
        bytes.set(hex('0000000000000000ffff0000009b0000ffff000000930000'), 0xd000);
        bytes.set(hex('0040080000860000'), 0xe070);
        const cpu = await createCpu(options);
        try {
          cpu.setState(
            initial(0x1000n, { 0: 0x1122n, 3: 0x6000n, 4: 0x1122334400009000n }, 0x202n),
          );
          const result = await cpu.run({
            budget: 1n,
            stop: 0x4000n,
            eventDelivery: { budget: 1n },
          });
          equal(result.reason, 'stop', 'word gate handler');
          equal(result.retired, 0n, 'source fault not retired');
          equal(result.deliveryAttempts, 1n, 'one word entry');
          equal(result.state.registers[4], 0x1122334400008ff8n, 'SP16 merge');
          for (const [i, value] of [3n, 0x1000n, 8n, 0x202n].entries())
            equal(word(cpu, 0xeff8n + BigInt(i * 2), 2), value, 'word frame slot');
          equal(cpu.readContext().segments.cs.default32, false, 'handler code16');
        } finally {
          cpu.dispose();
        }
      },
    })),
    ...[false, true].flatMap((pae) =>
      [false, true].map((vm) => ({
        name: `legacy ${pae ? 'PAE' : 'nonPAE'} ${vm ? 'VM86' : 'protected16'} operand and address defaults`,
        async run() {
          const options = legacyOptions(compiler, pae, 'b834128907');
          const context = vm ? vmContext() : protectedSnapshot();
          context.segments.cs.default32 = false;
          options.context = context;
          const cpu = await createCpu(options);
          try {
            cpu.setState(initial(0x1000n, { 0: 0x1122334455667788n, 3: 0x6000n }));
            const result = await cpu.run({ budget: 2n });
            equal(result.reason, 'budget', 'completion');
            equal(result.state.rip, 0x1005n, '16-bit encoding PC');
            equal(result.state.registers[0], 0x1122334455661234n, 'AX merge');
            equal(word(cpu, 0xa000n, 2), 0x1234n, 'address16 [BX]');
            equal(cpu.readContext().mode, vm ? 'virtual8086' : 'protected', 'retained mode');
          } finally {
            cpu.dispose();
          }
        },
      })),
    ),
    ...[false, true].flatMap((pae) =>
      [false, true].map((wordGate) => ({
        name: `legacy ${pae ? 'PAE' : 'nonPAE'} VM86 ${wordGate ? 'word gate private frontier' : 'ten dword PF frame'}`,
        async run() {
          const options = legacyOptions(compiler, pae, '8907');
          const context = vmContext();
          context.gdtr = { base: 0x7000n, limit: 0x17 };
          context.idtr = { base: 0x8000n, limit: 0x77 };
          context.tr = {
            selector: 0x28,
            valid: true,
            base: 0xb000n,
            limit: 0x67,
            attributes: 0x8b,
          };
          options.context = context;
          const bytes = options.memory!.backings[0]!.bytes,
            pt = pae ? 0x4000 : 0x2000,
            width = pae ? 8 : 4;
          for (const [index, value] of [
            [4, 0xc003n],
            [6, 0xa005n],
            [7, 0xd003n],
            [8, 0xe003n],
            [11, 0xf003n],
          ] as const)
            bytes.set(little(value, width), pt + index * width);
          bytes.set(hex('0000000000000000ffff0000009bcf00ffff00000093cf00'), 0xd000);
          bytes.set(hex(wordGate ? '0040080000860000' : '00400800008e0000'), 0xe070);
          bytes.set(little(0x9000n, 4), 0xf004);
          bytes.set(little(0x10n, 2), 0xf008);
          if (wordGate) options.memory!.mappings[0]!.length = 0xf000;
          const cpu = await createCpu(options);
          try {
            cpu.setState(initial(0x1000n, { 0: 0x1122n, 3: 0x6000n, 4: 0xc000n }, 0x202n));
            const result = await cpu.run({
              budget: 1n,
              stop: 0x4000n,
              eventDelivery: { budget: 1n },
            });
            equal(result.retired, 0n, 'faulting source not retired');
            equal(result.deliveryAttempts, 1n, 'entry attempt');
            if (wordGate) {
              equal(result.reason, 'unsupported', 'valid16 gate frontier');
              equal(cpu.readContext().mode, 'virtual8086', 'VM context retained');
              check(
                !result.systemMemoryFault && !result.physicalMemoryFault,
                'unselected TSS untouched',
              );
            } else {
              equal(result.reason, 'stop', 'legacy handler before fetch');
              equal(cpu.readContext().mode, 'protected', 'VM exit');
              equal(result.state.registers[4], 0x8fd8n, 'ten dwords');
              for (const [i, expected] of [
                7n,
                0x1000n,
                0n,
                0x30202n,
                0xc000n,
                0n,
                0n,
                0n,
                0n,
                0n,
              ].entries())
                equal(word(cpu, 0xefd8n + BigInt(i * 4), 4), expected, 'ten slot frame');
            }
          } finally {
            cpu.dispose();
          }
        },
      })),
    ),
  ];
}
