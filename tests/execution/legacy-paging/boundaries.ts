import { createCpu } from '../../../host/index.js';
import { legacyOptions, little, hex, initial, equal, check, type Scenario } from './fixture.js';

export function legacyBoundaryScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'legacy PAE cold probe never loads an unretired control quartet before quota',
      async run() {
        const options = legacyOptions(compiler, true, 'ffe0');
        options.limits = { ...options.limits, maxInstructions: 1, maxTranslationsPerRun: 1 };
        options.memory!.backings[0]!.bytes.set(little(0x9007n), 0x4010);
        options.memory!.backings[0]!.bytes.set(hex('0f22d9'), 0x9000);
        options.memory!.mappings = [
          {
            base: 0n,
            backing: 'ram',
            offset: 0,
            length: 0x1018,
            permissions: { read: true, write: true, execute: true },
          },
          {
            base: 0x1020n,
            backing: 'ram',
            offset: 0x1020,
            length: 0xefe0,
            permissions: { read: true, write: true, execute: true },
          },
        ];
        const cpu = await createCpu(options);
        try {
          cpu.setState(initial(0x1000n, { 0: 0x2000n, 1: 0x1000n }));
          const cold = await cpu.run({ budget: 2n });
          equal(cold.reason, 'resource-limit', 'cold quota');
          equal(cold.retired, 1n, 'jump only');
          equal(cold.state.rip, 0x2000n, 'unretired writer');
          check(!cold.physicalMemoryFault, 'probe did not load quartet');
          const actual = await cpu.run({ budget: 1n });
          equal(actual.reason, 'physical-memory-fault', 'reached writer actual load');
          equal(actual.physicalMemoryFault?.phase, 'pdpte-load', 'typed load');
          equal(actual.retired, 0n, 'failed writer not retired');
        } finally {
          cpu.dispose();
        }
      },
    },
    ...[1n, 2n].map((budget) => ({
      name: `legacy PAE writer publication survives ${budget === 1n ? 'last-budget boundary' : 'next fetch ahead of compile quota'}`,
      async run() {
        const options = legacyOptions(compiler, true, '0f22d990');
        options.limits = { ...options.limits, maxTranslationsPerRun: 1 };
        const bytes = options.memory!.backings[0]!.bytes;
        bytes.set(little(0x5001n), 0x1000);
        bytes.set(little(0n), 0x6008);
        const cpu = await createCpu(options);
        try {
          cpu.setState(initial(0x1000n, { 1: 0x1000n }));
          let result = await cpu.run({ budget });
          equal(result.retired, 1n, 'writer once');
          equal(result.state.rip, 0x1003n, 'committed next PC');
          equal(cpu.readPagingState().pdpte![0], 0x5001n, 'destination quartet');
          if (budget === 1n) {
            equal(result.reason, 'budget', 'budget before target fetch');
            result = await cpu.run({ budget: 1n });
            equal(result.retired, 0n, 'resume fault no writer');
          }
          equal(result.reason, 'page-fault', 'new-root target PF');
          equal(result.pageFault?.address, 0x1003n, 'successor address');
          cpu.writePhysicalMemory(0x6008n, little(0x8007n));
          cpu.writePhysicalMemory(0x1000n, little(0x3003n));
          const resumed = await cpu.run({ budget: 1n });
          equal(resumed.reason, 'budget', 'repaired target');
          equal(resumed.retired, 1n, 'NOP only');
          equal(resumed.state.rip, 0x1004n, 'no writer replay or fresh PDPT load');
        } finally {
          cpu.dispose();
        }
      },
    })),
    {
      name: 'legacy user control privilege fault precedes inaccessible PDPT',
      async run() {
        const options = legacyOptions(compiler, true, '0f22d8', false);
        const context = options.context!;
        check('cpl' in context, 'full context');
        context.cpl = 3;
        for (const name of ['cs', 'ss', 'ds', 'es', 'fs', 'gs'] as const) {
          context.segments[name].selector |= 3;
          context.segments[name].dpl = 3;
        }
        const cpu = await createCpu(options);
        try {
          cpu.setState(initial(0x1000n, { 0: 0x1000n }));
          const result = await cpu.run({ budget: 1n });
          equal(result.reason, 'protection-fault', 'CPL denial');
          equal(result.protectionFault?.phase, 'privilege', 'preload privilege');
          check(!result.physicalMemoryFault, 'no PDPT access');
          equal(result.retired, 0n, 'no control retirement');
        } finally {
          cpu.dispose();
        }
      },
    },
  ];
}
