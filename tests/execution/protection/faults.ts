import { equal, check, initial, snapshot, using, type Scenario } from './fixture.js';

export function faultScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'protection privilege precedes explicit operand and descriptor probing',
      async run() {
        await using(compiler, '0f0113', snapshot('long64', 3), async (cpu) => {
          cpu.setState(initial(0x1000n, { 3: 0x9000n }, 0xcd7n));
          const result = await cpu.run({ budget: 1n });
          equal(result.reason, 'protection-fault', 'CPL failure');
          equal(result.retired, 0n, 'no retirement');
          equal(result.protectionFault?.phase, 'privilege', 'CPL phase');
          equal(result.protectionFault?.vector, 13, 'GP vector');
          equal(result.protectionFault?.errorCode, 0, 'GP error');
          equal(result.protectionFault?.selector, undefined, 'no invented selector');
          equal(result.fault, undefined, 'no explicit operand probe');
          equal(result.systemMemoryFault, undefined, 'no internal probe');
          equal(result.state.flags, 0xcd7n, 'flags preserved');
        });
      },
    },
    {
      name: 'protection descriptor backing fault is unsegmented and repairs without stale diagnostics',
      async run() {
        await using(compiler, '48ffc28ed890', snapshot(), async (cpu) => {
          cpu.setState(initial(0x1000n, { 0: 8n, 2: 10n }, 0x403n));
          const failed = await cpu.run({ budget: 3n });
          equal(failed.reason, 'system-memory-fault', 'descriptor read');
          equal(failed.retired, 1n, 'dirty predecessor retained');
          equal(failed.state.registers[2], 11n, 'live predecessor');
          equal(failed.state.rip, 0x1003n, 'fault PC');
          equal(failed.systemMemoryFault?.instructionPc, 0x1003n, 'reported PC');
          equal(failed.systemMemoryFault?.address, 0x4008n, 'table address');
          equal(failed.systemMemoryFault?.width, 8, 'low descriptor slice');
          equal(failed.systemMemoryFault?.failingAddress, 0x4008n, 'first absent byte');
          equal(failed.systemMemoryFault?.phase, 'descriptor-read', 'system phase');
          equal(failed.systemMemoryFault?.table, 'gdt', 'table root');
          equal(failed.systemMemoryFault?.selector, 8, 'selected descriptor');
          equal(failed.fault, undefined, 'no invented DS fault');
          equal(failed.protectionFault, undefined, 'exclusive diagnostic');
          cpu.addBacking({
            id: 'descriptor',
            bytes: Uint8Array.from([255, 255, 0, 0, 0, 0x93, 0xcf, 0]),
          });
          cpu.setMappings([
            {
              base: 0x1000n,
              backing: 'code',
              offset: 0,
              length: 6,
              permissions: { read: true, write: false, execute: true },
            },
            {
              base: 0x4008n,
              backing: 'descriptor',
              offset: 0,
              length: 8,
              permissions: { read: true, write: false, execute: false },
            },
          ]);
          const resumed = await cpu.run({ budget: 2n });
          equal(resumed.reason, 'budget', 'repaired run');
          equal(resumed.retired, 2n, 'faulting instruction retires once');
          equal(resumed.systemMemoryFault, undefined, 'cleared system diagnostic');
          equal(resumed.protectionFault, undefined, 'cleared protection diagnostic');
          equal(cpu.readContext().segments.ds.selector, 8, 'published selector');
        });
      },
    },
    ...[0x92, 0x93].map((access) => ({
      name: `protection accessed ${access & 1} checks only a required one byte write`,
      async run() {
        await using(
          compiler,
          '8ee090',
          snapshot(),
          async (cpu) => {
            cpu.setState(initial(0x1000n, { 0: 8n }));
            const before = cpu.readContext();
            const result = await cpu.run({ budget: 1n });
            if (access === 0x92) {
              equal(result.reason, 'system-memory-fault', 'accessed write denied');
              equal(result.retired, 0n, 'no failed retirement');
              equal(result.systemMemoryFault?.address, 0x400dn, 'access byte address');
              equal(result.systemMemoryFault?.width, 1, 'one byte write');
              equal(result.systemMemoryFault?.access, 'write', 'write permission');
              equal(result.systemMemoryFault?.phase, 'descriptor-accessed-write', 'write phase');
              equal(
                cpu.readContext().segments.fs.selector,
                before.segments.fs.selector,
                'no selector publication',
              );
            } else {
              equal(result.reason, 'budget', 'A1 read only success');
              equal(cpu.readContext().segments.fs.selector, 8, 'selector published');
              check(cpu.readContext().segments.fs.accessed, 'A cache');
            }
            equal(result.fault, undefined, 'no DS on internal byte write');
          },
          {
            data: [{ base: 0x4008n, bytes: `ffff000000${access.toString(16)}cf00`, write: false }],
          },
        );
      },
    })),
    {
      name: 'protection explicit selector operand keeps old FS segment diagnostics',
      async run() {
        const execution = snapshot();
        execution.segments.fs.base = 0x5000n;
        await using(compiler, '648e03', execution, async (cpu) => {
          cpu.setState(initial(0x1000n, { 3: 0x20n }));
          const result = await cpu.run({ budget: 1n });
          equal(result.reason, 'data-fault', 'explicit source');
          equal(result.fault?.segment, 'fs', 'old selected segment');
          equal(result.fault?.address, 0x5020n, 'old base used');
          equal(result.fault?.width, 2, 'selector source width');
          equal(result.systemMemoryFault, undefined, 'not internal lookup');
          equal(cpu.readContext().segments.fs.base, 0x5000n, 'no base publication');
        });
      },
    },
  ];
}
