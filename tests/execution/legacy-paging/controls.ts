import { legacyCpu, little, word, equal, check, initial, type Scenario } from './fixture.js';

export function legacyControlScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'legacy captured quartet A/B/A cannot reuse stale immediate or middle entries',
      async run() {
        const cpu = await legacyCpu(compiler, true, '90b801000000');
        try {
          cpu.writePhysicalMemory(0x6008n, little(0x9007n));
          cpu.writePhysicalMemory(0x9000n, Uint8Array.of(0x90, 0xb8, 2, 0, 0, 0));
          cpu.setState(initial(0x1000n, { 0: 0n }));
          equal((await cpu.run({ budget: 2n })).state.registers[0], 1n, 'warm A');
          const a = cpu.readPagingState();
          const b = { ...a, pdpte: [0x5001n, 0n, 0n, 0n] as [bigint, bigint, bigint, bigint] };
          cpu.setPagingState(b);
          cpu.setState(initial(0x1001n, { 0: 0n }));
          equal(
            (await cpu.run({ budget: 1n })).state.registers[0],
            2n,
            'B middle entry cannot retain A immediate',
          );
          cpu.setPagingState(a);
          cpu.setState(initial(0x1001n, { 0: 0n }));
          equal((await cpu.run({ budget: 1n })).state.registers[0], 1n, 'A/B/A fresh source');
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'legacy PAE same-value CR3 reload uses four captured roots and commits once',
      async run() {
        const cpu = await legacyCpu(compiler, true, '8b030f22d98b03');
        try {
          cpu.writePhysicalMemory(0xa000n, little(0x11111111n, 4));
          cpu.writePhysicalMemory(0xb000n, little(0x22222222n, 4));
          cpu.writePhysicalMemory(0x1000n, little(0x5001n));
          cpu.setState(initial(0x1000n, { 0: 0x1122334400000000n, 1: 0x1000n, 3: 0x6000n }));
          const first = await cpu.run({ budget: 1n });
          equal(first.state.registers[0], 0x1122334411111111n, 'old latch read');
          const writer = await cpu.run({ budget: 1n });
          equal(writer.retired, 1n, 'writer one retirement');
          equal(writer.state.rip, 0x1005n, 'committed successor');
          equal(cpu.readPagingState().pdpte![0], 0x5001n, 'new latch');
          const last = await cpu.run({ budget: 1n });
          equal(last.state.registers[0], 0x1122334422222222n, 'new latch read');
          equal(last.state.rip, 0x1007n, 'new-root successor');
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'legacy PAE all-four private capture precedes reserved validation without partial bank',
      async run() {
        const cpu = await legacyCpu(compiler, true, '0f22d8');
        const mapping = (base: number, length: number) => ({
          base: BigInt(base),
          backing: 'ram',
          offset: base,
          length,
          permissions: { read: true, write: true, execute: true },
        });
        try {
          cpu.writePhysicalMemory(0x1000n, little(0x3003n));
          cpu.setMappings([mapping(0, 0x1018), mapping(0x1020, 0xefe0)]);
          cpu.setState(initial(0x1000n, { 0: 0x1000n }));
          const before = cpu.readPagingState();
          const hole = await cpu.run({ budget: 1n });
          equal(hole.reason, 'physical-memory-fault', 'late slot refusal');
          equal(hole.retired, 0n, 'failed writer');
          const fault = hole.physicalMemoryFault;
          check(fault?.phase === 'pdpte-load', 'typed control-load fault');
          equal(fault.slot, 3, 'failing quadrant');
          equal(fault.control, 'cr3', 'control source');
          equal(fault.physicalAddress, 0x1018n, 'slot address');
          equal(fault.width, 8, 'exact slot width');
          check(!('address' in fault) && !('access' in fault), 'no fabricated linear provenance');
          equal(cpu.readPagingState().pdpte![0], before.pdpte![0], 'old quartet');
          cpu.setMappings([mapping(0, 0x10000)]);
          const reserved = await cpu.run({ budget: 1n });
          equal(reserved.reason, 'protection-fault', 'reserved slot validation');
          equal(reserved.protectionFault?.errorCode, 0, 'writer GP0');
          check(!reserved.physicalMemoryFault, 'stale private record cleared');
          cpu.writePhysicalMemory(0x1000n, little(0x5001n));
          const repaired = await cpu.run({ budget: 1n });
          equal(repaired.retired, 1n, 'repaired writer once');
          equal(repaired.state.rip, 0x1003n, 'repaired next');
          equal(cpu.readPagingState().pdpte![0], 0x5001n, 'all roots published');
        } finally {
          cpu.dispose();
        }
      },
    },
    ...[false, true].map((change) => ({
      name: `legacy PAE ${change ? 'changed' : 'unchanged'} PSE ${change ? 'reloads' : 'retains'} latch`,
      async run() {
        const cpu = await legacyCpu(compiler, true, '0f22e08b03');
        try {
          cpu.writePhysicalMemory(0x1000n, little(0x5001n));
          cpu.writePhysicalMemory(0xa000n, little(0x11111111n, 4));
          cpu.writePhysicalMemory(0xb000n, little(0x22222222n, 4));
          cpu.setState(initial(0x1000n, { 0: change ? 0x638n : 0x628n, 3: 0x6000n }));
          const result = await cpu.run({ budget: 2n });
          equal(result.retired, 2n, 'control and consumer');
          equal(
            result.state.registers[0],
            change ? 0x22222222n : 0x11111111n,
            'selected root data',
          );
          equal(cpu.readPagingState().pdpte![0], change ? 0x5001n : 0x3001n, 'load trigger');
          equal(word(cpu, 0x1000n), 0x5001n, 'PDPT no AD');
        } finally {
          cpu.dispose();
        }
      },
    })),
  ];
}
