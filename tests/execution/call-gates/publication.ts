import { createCpu } from '../../../host/index.js';
import { contextFor, initial, equal, same, put, hex, type Scenario } from './fixture.js';
import { LIMITS } from '../../support/fixture.js';

export function gatePublicationScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'call gate dirty refusal retains captured frame identity when eager A remaps an aliased descriptor address',
      async run() {
        const ram = new Uint8Array(0x20000).fill(0xa5);
        // PTE1's A byte aliases PDE byte1: 53->73 redirects PT55000 to PT57000.
        for (const [address, value] of [
          [0x4000, 0x55327n],
          [0x5000, 0xb063n],
          [0x5004, 0xa053n],
          [0x5008, 0xc063n],
          [0x500c, 0xd063n],
          [0x5010, 0xf067n],
          [0x7000, 0xe023n],
          [0x7004, 0xa063n],
          [0x7010, 0xf067n],
          [0xc004, 0x1009n],
        ] as const)
          put(ram, address, value, 4);
        put(ram, 0xc008, 0x3000n, 2);
        ram.set(hex('ffff0000009acf00'), 0xbff8);
        ram.set(hex('0020080000ec0000'), 0xcff0);
        ram.set(hex('ffff00000092cf00'), 0xdff0);
        ram.set(hex('9affffffff0320'), 0xf000);
        const execution = contextFor();
        execution.gdtr = { base: 0xff0n, limit: 0x3fff };
        execution.tr = {
          selector: 0x28,
          valid: true,
          base: 0x2000n,
          limit: 0x67,
          attributes: 0x8b,
        };
        const map = (base: bigint, offset: number, length: number, write = true) => ({
          base,
          offset,
          length,
          backing: 'ram',
          permissions: { read: true, write, execute: true },
        });
        const cpu = await createCpu({
          compiler,
          entry: 0x4000n,
          context: execution,
          memoryModel: 'physical',
          paging: { cr0: 0x80010033n, cr2: 0xdeadn, cr3: 0x4000n, cr4: 0x608n, efer: 0n },
          memory: {
            backings: [{ id: 'ram', bytes: ram }],
            mappings: [
              map(0n, 0, ram.length),
              map(0x55000n, 0x5000, 4),
              map(0x55004n, 0x4001, 1),
              map(0x55005n, 0x5005, 0xffb),
              map(0x57000n, 0x7000, 0x1000, false),
            ],
          },
          memoryLimits: { maxBackings: 1, maxMappings: 5, maxBackingBytes: ram.length },
          limits: LIMITS,
        });
        try {
          const before = initial(0x4000n, { 4: 0x4000n }, 0x10202n);
          cpu.setState(before);
          const oldContext = cpu.readContext();
          const beforeLateFrame = cpu.readPhysicalMemory(0xeff9n, 10);
          const beforeEarlyFrame = cpu.readPhysicalMemory(0xa000n, 9);
          const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
          equal(result.reason, 'physical-memory-fault', 'private D preflight refusal');
          same(
            result.physicalMemoryFault,
            {
              instructionPc: 0x4000n,
              address: 0xffdn,
              access: 'write',
              physicalAddress: 0x57000n,
              width: 4,
              failingPhysicalAddress: 0x57000n,
              physicalAccess: 'write',
              cause: 'permission',
              phase: 'dirty-write',
              segment: 'ss',
            },
            'captured frame D refusal is not an earlier descriptor accessed write',
          );
          equal(result.retired, 0n, 'failed gate never retires');
          equal(result.remaining, 1n, 'failed gate retains instruction allowance');
          same(result.state.registers, before.registers, 'no partial frame pointer publication');
          equal(result.state.rip, 0x4000n, 'captured instruction remains current');
          equal(result.state.flags, 0x202n, 'only begun-instruction RF clear');
          same(cpu.readContext(), oldContext, 'no partial CS SS CPL publication');
          equal(cpu.readPagingState().cr2, 0xdeadn, 'private D refusal is not PF');
          const word = (address: bigint) => {
            const bytes = cpu.readPhysicalMemory(address, 4);
            return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
          };
          equal(word(0x4000n), 0x57327, 'eager A really replaced page-table authority');
          equal(word(0x55004n), 0xa073, 'required earlier A remains committed');
          equal(word(0x57000n), 0xe023, 'refused D remains clear');
          equal(cpu.readPhysicalMemory(0xbffdn, 1)[0], 0x9a, 'target A payload not published');
          equal(cpu.readPhysicalMemory(0xdff5n, 1)[0], 0x92, 'new SS A payload not published');
          same(
            cpu.readPhysicalMemory(0xeff9n, 10),
            beforeLateFrame,
            'late frame payload unchanged',
          );
          same(
            cpu.readPhysicalMemory(0xa000n, 9),
            beforeEarlyFrame,
            'earlier admitted frame payload unchanged',
          );
        } finally {
          cpu.dispose();
        }
      },
    },
  ];
}
