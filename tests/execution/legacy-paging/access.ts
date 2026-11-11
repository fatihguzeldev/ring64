import { createCpu } from '../../../host/index.js';
import {
  legacyOptions,
  legacyCpu,
  little,
  word,
  initial,
  equal,
  check,
  protectedSnapshot,
  type Scenario,
} from './fixture.js';

export function legacyAccessScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'legacy dword dependencies and D writes never admit adjacent four bytes',
      async run() {
        const tables = new Uint8Array(12);
        tables.set(little(0x2007n, 4));
        tables.set(little(0x8007n, 4), 4);
        tables.set(little(0xa007n, 4), 8);
        const cpu = await createCpu({
          compiler,
          memoryModel: 'physical',
          context: protectedSnapshot(),
          paging: { cr0: 0x80000033n, cr2: 0n, cr3: 0x1000n, cr4: 0x608n, efer: 0n },
          entry: 0x1000n,
          limits: legacyOptions(compiler).limits,
          memoryLimits: { maxBackings: 3, maxBackingBytes: 128, maxMappings: 8 },
          memory: {
            backings: [
              { id: 'tables', bytes: tables },
              { id: 'code', bytes: Uint8Array.of(0x89, 0x03) },
              { id: 'data', bytes: new Uint8Array(4) },
            ],
            mappings: [
              ...[0x1000, 0x2004, 0x2018].map((base, i) => ({
                base: BigInt(base),
                backing: 'tables',
                offset: i * 4,
                length: 4,
                permissions: { read: true, write: true, execute: false },
              })),
              {
                base: 0x8000n,
                backing: 'code',
                offset: 0,
                length: 2,
                permissions: { read: true, write: false, execute: true },
              },
              {
                base: 0xa000n,
                backing: 'data',
                offset: 0,
                length: 4,
                permissions: { read: false, write: true, execute: false },
              },
              {
                base: 0xb000n,
                backing: 'data',
                offset: 0,
                length: 4,
                permissions: { read: true, write: false, execute: false },
              },
            ],
          },
        });
        try {
          cpu.setState(initial(0x1000n, { 0: 0x11223344n, 3: 0x6000n }));
          const result = await cpu.run({ budget: 1n });
          equal(result.reason, 'budget', 'exact-width generated store');
          equal(word(cpu, 0xb000n, 4), 0x11223344n, 'W-only payload');
          equal(word(cpu, 0x2018n, 4), 0xa067n, 'four-byte AD');
          check(
            cpu.inspectTranslations().length > 0,
            'source registered across guarded table words',
          );
        } finally {
          cpu.dispose();
        }
      },
    },
    ...[false, true].map((pae) => ({
      name: `legacy ${pae ? 'PAE 2MiB' : 'PSE36 4MiB'} sparse large-page generated store`,
      async run() {
        const cpu = await legacyCpu(compiler, pae, '8903');
        const physical = pae ? 0x000a000000234567n : 0xab00634567n,
          linear = pae ? 0x41234567n : 0x81234567n;
        try {
          cpu.addBacking({ id: 'large', bytes: new Uint8Array(4) });
          cpu.setMappings([
            {
              base: 0n,
              backing: 'ram',
              offset: 0,
              length: 0x10000,
              permissions: { read: true, write: true, execute: true },
            },
            {
              base: physical,
              backing: 'large',
              offset: 0,
              length: 4,
              permissions: { read: true, write: true, execute: false },
            },
          ]);
          const bank = cpu.readPagingState();
          if (pae) {
            bank.pdpte![1] = 0x3001n;
            cpu.writePhysicalMemory(0x3048n, little(0x000a000000201087n));
          } else {
            bank.cr4 = 0x618n;
            cpu.writePhysicalMemory(0x1810n, little(0x00557087n, 4));
          }
          cpu.setPagingState(bank);
          cpu.setState(initial(0x1000n, { 0: 0x89abcdefn, 3: linear }));
          const result = await cpu.run({ budget: 1n });
          equal(result.retired, 1n, 'large store once');
          equal(word(cpu, physical, 4), 0x89abcdefn, 'large translated payload');
          equal(
            word(cpu, pae ? 0x3048n : 0x1810n, pae ? 8 : 4),
            pae ? 0x000a0000002010e7n : 0x005570e7n,
            'large leaf AD',
          );
        } finally {
          cpu.dispose();
        }
      },
    })),
    ...[false, true].map((pae) => ({
      name: `legacy ${pae ? 'PAE' : 'nonPAE'} prepared payload wins over own leaf D update`,
      async run() {
        const cpu = await legacyCpu(compiler, pae, 'c70300000000');
        const pt = pae ? 0x4000n : 0x2000n,
          offset = pae ? 0x30n : 0x18n;
        try {
          cpu.writePhysicalMemory(pt + offset, little(pt | 7n, pae ? 8 : 4));
          cpu.setState(initial(0x1000n, { 3: 0x6000n + offset }));
          const result = await cpu.run({ budget: 1n });
          equal(result.reason, 'budget', 'completed self-PTE store');
          equal(result.retired, 1n, 'no rewalk after payload');
          equal(word(cpu, pt + offset, pae ? 8 : 4), 0n, 'payload clears P and planned D');
        } finally {
          cpu.dispose();
        }
      },
    })),
    ...[false, true].map((pae) => ({
      name: `legacy ${pae ? 'PAE' : 'nonPAE'} code alias completes writer before changed successor`,
      async run() {
        const cpu = await legacyCpu(compiler, pae, '8903f5');
        try {
          cpu.writePhysicalMemory(pae ? 0x4030n : 0x2018n, little(0x8007n, pae ? 8 : 4));
          cpu.setState(initial(0x1000n, { 0: 0x90909090n, 3: 0x6000n }));
          const result = await cpu.run({ budget: 2n });
          equal(result.reason, 'budget', 'changed source completion');
          equal(result.retired, 2n, 'store and rewritten NOP');
          equal(result.state.rip, 0x1003n, 'new bytes at successor');
          equal(word(cpu, 0x8000n, 4), 0x90909090n, 'alias payload');
        } finally {
          cpu.dispose();
        }
      },
    })),
  ];
}
