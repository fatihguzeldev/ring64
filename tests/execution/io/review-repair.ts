import { createCpu, type MemoryMapping } from '../../../host/index.js';
import { LIMITS, check, equal, hex, initial, type Scenario } from '../../support/fixture.js';
import { snapshot, same } from '../far-control/fixture.js';

export function ioRepairReviewScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'protected user REP INS guest repairs its late PF and IRETD consumes a fresh input without replaying entry',
      async run() {
        for (const blockedHandler of [false, true]) {
          const context = snapshot('protected', 3);
          context.segments.cs.selector = 0x1b;
          for (const name of ['ss', 'ds', 'es', 'fs', 'gs'] as const)
            context.segments[name].selector = 0x23;
          context.gdtr = { base: 0x8000n, limit: 0x37 };
          context.idtr = { base: 0xb000n, limit: 0x77 };
          context.tr = {
            selector: 0x28,
            valid: true,
            base: 0xc000n,
            limit: 0x67,
            attributes: 0x8b,
          };
          const ram = new Uint8Array(0x72000),
            view = new DataView(ram.buffer);
          const dword = (offset: number, value: number) => view.setUint32(offset, value, true);
          dword(0x10000, 0x11007);
          for (const [index, entry] of [
            [1, 0x20007],
            [4, 0x40007],
            [5, 0x41006],
            [8, 0x30003],
            [10, 0x11003],
            [11, 0x60003],
            [12, 0x70003],
          ])
            dword(0x11000 + index! * 4, entry!);
          ram.set(hex('f36c'), 0x20000);
          ram.set(hex('830d14a00000010f013d0050000083c404cf'), 0x40000);
          for (const [index, entry] of [
            [1, 0x00cf9b000000ffffn],
            [2, 0x00cf93000000ffffn],
            [3, 0x00cffb000000ffffn],
            [4, 0x00cff3000000ffffn],
          ] as const)
            view.setBigUint64(0x30000 + index * 8, entry, true);
          ram.set(hex('00400800008e0000'), 0x60000 + 14 * 8);
          dword(0x70004, 0x9000);
          view.setUint16(0x70008, 0x10, true);
          const all: MemoryMapping = {
            base: 0n,
            backing: 'ram',
            offset: 0,
            length: ram.length,
            permissions: { read: true, write: true, execute: true },
          };
          const mappings: MemoryMapping[] = blockedHandler
            ? [
                { ...all, length: 0x40000 },
                {
                  ...all,
                  base: 0x40000n,
                  offset: 0x40000,
                  length: 0x100,
                  permissions: { read: true, write: true, execute: false },
                },
                { ...all, base: 0x40100n, offset: 0x40100, length: ram.length - 0x40100 },
              ]
            : [all];
          const values = [0x11, 0x22, 0x33, 0x44];
          let calls = 0;
          const cpu = await createCpu({
            compiler,
            limits: LIMITS,
            memoryModel: 'physical',
            context,
            paging: { cr0: 0x80000033n, cr2: 0n, cr3: 0x10000n, cr4: 0x608n, efer: 0n },
            entry: 0x1000n,
            memoryLimits: { maxBackingBytes: ram.length, maxBackings: 1, maxMappings: 3 },
            memory: { backings: [{ id: 'ram', bytes: ram }], mappings },
            io: {
              read(port, width) {
                equal(port, 0x80, 'fixed DX');
                equal(width, 8, 'byte input');
                return values[calls++]!;
              },
              write() {
                throw Error('no output');
              },
            },
          });
          try {
            cpu.setState(initial(0x1000n, { 1: 3n, 2: 0x80n, 4: 0xe000n, 7: 0x4ffen }, 0x3202n));
            let result = await cpu.run({
              budget: 10n,
              repeatBudget: 3n,
              eventDelivery: { budget: 1n },
              stop: 0x1002n,
            });
            if (blockedHandler) {
              equal(
                result.reason,
                'physical-memory-fault',
                'accepted handler fetch has private refusal',
              );
              equal(result.physicalMemoryFault?.phase, 'final-access', 'handler physical phase');
              equal(
                result.physicalMemoryFault?.physicalAddress,
                0x40000n,
                'handler source physical address',
              );
              equal(result.state.rip, 0x4000n, 'accepted handler PC');
              equal(result.state.registers[4], 0x8fe8n, 'one accepted frame');
              equal(result.state.registers[1], 1n, 'failed element count');
              equal(result.state.registers[7], 0x5000n, 'failed element index');
              equal(result.repeatIterations, 2n, 'completed prior inputs');
              equal(result.deliveryAttempts, 1n, 'exactly one entry');
              equal(calls, 3, 'failed third input consumed once');
              cpu.setMappings([all]);
              result = await cpu.run({
                budget: 10n,
                repeatBudget: 1n,
                eventDelivery: { budget: 1n },
                stop: 0x1002n,
              });
              equal(result.deliveryAttempts, 0n, 'handler fetch repair does not replay frame');
              equal(result.repeatIterations, 1n, 'only final element after repair');
            } else {
              equal(result.deliveryAttempts, 1n, 'one PF entry');
              equal(result.repeatIterations, 3n, 'three completed elements');
            }
            equal(result.reason, 'stop', 'guest repair completes source');
            equal(result.retired, 5n, 'four handler instructions plus REP');
            equal(result.remaining, 5n, 'exact instruction work');
            equal(calls, 4, 'consumed failed input is not latched');
            equal(result.state.rip, 0x1002n, 'source successor');
            equal(result.state.registers[7], 0x5001n, 'final destination');
            equal(result.state.registers[1], 0n, 'count exhausted');
            equal(result.state.registers[4], 0xe000n, 'outer user stack restored');
            equal(result.state.flags, 0x3202n, 'IOPL and IF restored, retried RF cleared');
            equal(cpu.readContext().cpl, 3, 'returned to user');
            equal(cpu.readPagingState().cr2, 0x5000n, 'original late write PF');
            same(
              Array.from(cpu.readPhysicalMemory(0x40ffen, 2)),
              [0x11, 0x22],
              'prior input bytes preserved',
            );
            equal(cpu.readPhysicalMemory(0x41000n, 1)[0], 0x44, 'fresh fourth input');
            const frame = cpu.readPhysicalMemory(0x30fe8n, 24),
              frameView = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
            same(
              Array.from({ length: 6 }, (_, i) => frameView.getUint32(i * 4, true)),
              [6, 0x1000, 0x1b, 0x13202, 0xe000, 0x23],
              'literal six-dword error frame',
            );
            check(
              (new DataView(cpu.readPhysicalMemory(0x11014n, 4).buffer).getUint32(0, true) &
                0x67) ===
                0x67,
              'handler present repair and retried A/D',
            );
          } finally {
            cpu.dispose();
          }
        }
      },
    },
  ];
}
