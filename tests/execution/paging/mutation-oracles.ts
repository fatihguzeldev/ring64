import { longSnapshot } from '../../support/context.js';
import { gate } from '../software-events/fixture.js';
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
  type Scenario,
} from './fixture.js';

export function pagingMutationOracleScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'paging mutation oracle committed early frame alias cannot retarget captured later stack slots',
      async run() {
        const context = longSnapshot();
        context.cpl = 3;
        for (const name of ['cs', 'ss', 'ds', 'es', 'fs', 'gs'] as const) {
          context.segments[name].selector = name === 'cs' ? 0x1b : 0x23;
          context.segments[name].dpl = 3;
        }
        context.gdtr = { base: 0x402000n, limit: 15 };
        context.idtr = { base: 0x403000n, limit: 0xfff };
        context.tr = {
          selector: 0x28,
          valid: true,
          base: 0x409000n,
          limit: 0x67,
          attributes: 0x8b,
        };
        const gdt = new Uint8Array(0x1000);
        gdt.set(little([0x00af9b000000ffffn]), 8);
        const idt = new Uint8Array(0x1000);
        idt.set(hex(gate(64, 8, 0x401000n)), 14 * 16);
        const tss = new Uint8Array(0x1000);
        tss.set(little([0x405010n]), 4);
        await usingPaged(
          compiler,
          {
            context,
            bank: { ...BANK, cr0: 0x80010033n, efer: 0xd00n },
            words: [
              [0x4000n, 0x9027n],
              [0x4010n, 0xb027n],
              [0x4018n, 0xc027n],
              [0x4020n, 0xd067n],
              [0x4028n, 0x4067n],
              [0x4048n, 0x12027n],
            ],
            tableWindows: [
              { physical: 0x1000n, offset: 0, length: 0x3008, write: true },
              { physical: 0x4008n, offset: 0x3020, length: 8, write: true },
              { physical: 0x4010n, offset: 0x3010, length: 0xff0, write: true },
            ],
            spans: [
              { physical: 0n, bytes: new Uint8Array(0x1000).fill(0x5a) },
              { physical: 0xb000n, bytes: gdt },
              { physical: 0xc000n, bytes: idt },
              { physical: 0xd000n, bytes: new Uint8Array(0x1000).fill(0xa5) },
              { physical: 0x12000n, bytes: tss },
            ],
          },
          async (cpu) => {
            cpu.setState({
              ...initial(PC, { 4: 0x501000n }, 0x202n),
              event: {
                kind: 'pending',
                exception: {
                  vector: 14,
                  instructionPc: PC,
                  returnPc: PC,
                  savedFlags: 0x10202n,
                  errorCode: 4,
                  pageFaultAddress: 0x500000n,
                },
              },
            });
            const result = await cpu.run({
              budget: 1n,
              stop: 0x401000n,
              eventDelivery: { budget: 1n },
            });
            equal(result.reason, 'stop', 'entry completes using captured destinations');
            equal(result.retired, 0n, 'entry itself never retires');
            equal(result.state.registers[4], 0x404fe0n, 'six qword frame');
            equal(
              word(cpu, 0x4020n),
              0x23n,
              'early saved user SS overwrites the lower stack PTE without retroactive D repair',
            );
            same(
              cpu.readPhysicalMemory(0xdfe0n, 32),
              little([4n, PC, 0x1bn, 0x10202n]),
              'later payloads retain the original physical stack',
            );
            same(
              cpu.readPhysicalMemory(0xfe0n, 32),
              new Uint8Array(32).fill(0x5a),
              'newly remapped physical page receives no captured payload',
            );
          },
        );
      },
    },
  ];
}
