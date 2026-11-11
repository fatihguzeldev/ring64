import { createCpu } from '../../../host/index.js';
import { LIMITS, equal, hex, initial, type Scenario } from '../../support/fixture.js';
import { little, word } from '../paging/fixture.js';

export function ioSourcePteScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'completed INS invalidates executable translation dependencies before another input',
      async run() {
        const tables = new Uint8Array(0x4000);
        for (const [address, value] of [
          [0x10000, 0x11003n],
          [0x11000, 0x12003n],
          [0x12000, 0x13003n],
          [0x13008, 0x20003n],
          [0x13030, 0x13003n],
        ] as const)
          tables.set(little([value]), address - 0x10000);
        const inputs = [0x22, 0];
        let calls = 0;
        const cpu = await createCpu({
          compiler,
          limits: LIMITS,
          memoryModel: 'ia32e-paged',
          entry: 0x1000n,
          paging: { cr0: 0x80000033n, cr2: 0n, cr3: 0x10000n, cr4: 0x628n, efer: 0xd00n },
          memoryLimits: { maxBackingBytes: 0x5000, maxBackings: 2, maxMappings: 2 },
          memory: {
            backings: [
              { id: 'tables', bytes: tables },
              { id: 'code', bytes: hex('f36c') },
            ],
            mappings: [
              {
                base: 0x10000n,
                backing: 'tables',
                offset: 0,
                length: tables.length,
                permissions: { read: true, write: true, execute: false },
              },
              {
                base: 0x20000n,
                backing: 'code',
                offset: 0,
                length: 2,
                permissions: { read: true, write: false, execute: true },
              },
            ],
          },
          io: {
            read() {
              return inputs[calls++]!;
            },
            write() {},
          },
        });
        try {
          cpu.setState(initial(0x1000n, { 1: 2n, 2: 0x80n, 7: 0x6008n }));
          const first = await cpu.run({ budget: 1n, repeatBudget: 2n });
          equal(first.reason, 'page-fault', 'refetch sees cleared code PTE.P');
          equal(first.pageFault?.address, 0x1000n, 'source fetch fault');
          equal(first.pageFault?.errorCode, 0x10, 'NXE instruction fetch error bit');
          equal(word(cpu, 0x13008n), 0x20022n, 'input changed source PTE after fetch A');
          equal(calls, 1, 'no stale second input');
          equal(first.repeatIterations, 1n, 'first element committed');
          equal(first.retired, 0n, 'unfinished REP');
          equal(first.state.registers[7], 0x6009n, 'committed index');
          equal(first.state.registers[1], 1n, 'committed count');
          cpu.writePhysicalMemory(0x13008n, little([0x20023n]));
          const last = await cpu.run({ budget: 1n, repeatBudget: 1n });
          equal(last.reason, 'budget', 'source repair resumes remaining element');
          equal(calls, 2, 'only remaining input');
          equal(last.state.rip, 0x1002n, 'completed REP');
          equal(last.state.registers[7], 0x600an, 'final index');
          equal(last.state.registers[1], 0n, 'final count');
        } finally {
          cpu.dispose();
        }
      },
    },
  ];
}
