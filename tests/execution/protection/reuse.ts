import { createCpu } from '../../../host/index.js';
import { equal, check, initial, snapshot, using, hex, LIMITS, type Scenario } from './fixture.js';

export function reuseScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'protection A byte code alias and cache replacement aggregate one completed redispatch',
      async run() {
        const cpu = await createCpu({
          compiler,
          context: snapshot(),
          entry: 0x1000n,
          limits: LIMITS,
          memoryLimits: { maxBackings: 1, maxMappings: 4, maxBackingBytes: 13 },
          memory: {
            backings: [{ id: 'shared', bytes: hex('ffff000000928ee0b907000000') }],
            mappings: [
              {
                base: 0x1000n,
                backing: 'shared',
                offset: 5,
                length: 8,
                permissions: { read: true, write: false, execute: true },
              },
              {
                base: 0x4008n,
                backing: 'shared',
                offset: 0,
                length: 5,
                permissions: { read: true, write: false, execute: false },
              },
              {
                base: 0x400dn,
                backing: 'shared',
                offset: 5,
                length: 1,
                permissions: { read: true, write: true, execute: false },
              },
              {
                base: 0x400en,
                backing: 'shared',
                offset: 6,
                length: 2,
                permissions: { read: true, write: false, execute: false },
              },
            ],
          },
        });
        try {
          cpu.setState(initial(0x1000n, { 0: 0x12345678n, 2: 8n }));
          const result = await cpu.run({ budget: 3n });
          equal(result.reason, 'budget', 'completed code alias');
          equal(result.retired, 3n, 'each instruction once');
          equal(result.state.rip, 0x1008n, 'successor PC');
          equal(result.state.registers[0], 8n, 'dirty selector source');
          equal(result.state.registers[2], 0x12345678n, 'dirty predecessor');
          equal(result.state.registers[1], 7n, 'successor');
          equal(result.resources.dispatches, 1, 'combined redispatch');
          equal(result.resources.nativeEntries, 2, 'old then new context');
          equal(cpu.readMemory(0x1000n, 1)[0], 0x93, 'accessed byte code alias');
          const fs = cpu.readContext().segments.fs;
          equal(fs.base, 0xe0000000n, 'captured descriptor base');
          equal(fs.limit, 0xefffffff, 'captured descriptor limit');
          check(fs.accessed, 'published accessed cache');
          check(
            !cpu.inspectTranslations().some((unit) => unit.entries.includes(0x1000n)),
            'aliased old entry retired',
          );
        } finally {
          cpu.dispose();
        }
      },
    },
    ...[undefined, 0x1003n].map((stop) => ({
      name: `protection FS replacement uses old explicit source then new successor base ${stop === undefined ? 'dispatch' : 'stop'}`,
      async run() {
        const execution = snapshot();
        execution.segments.fs.base = 0x5000n;
        await using(
          compiler,
          '648e2364488b03',
          execution,
          async (cpu) => {
            cpu.setState(initial(0x1000n, { 3: 0n }));
            const result = await cpu.run({ budget: 2n, ...(stop === undefined ? {} : { stop }) });
            equal(result.reason, stop === undefined ? 'budget' : 'stop', 'completed boundary');
            equal(result.retired, stop === undefined ? 2n : 1n, 'retirement');
            equal(result.state.rip, stop ?? 0x1007n, 'successor PC');
            equal(cpu.readContext().segments.fs.base, 0x6000n, 'new FS base');
            equal(cpu.readContext().segments.fs.selector, 8, 'new selector');
            if (stop === undefined) {
              equal(result.state.registers[0], 0x8877665544332211n, 'new FS source');
              equal(result.resources.dispatches, 1, 'one completed redispatch');
            } else {
              const resumed = await cpu.run({ budget: 1n });
              equal(resumed.state.registers[0], 0x8877665544332211n, 'resumed new FS source');
            }
          },
          {
            data: [
              { base: 0x4008n, bytes: 'ffff00600093cf00', write: false },
              { base: 0x5000n, bytes: '0800', write: false },
              { base: 0x6000n, bytes: '1122334455667788', write: false },
            ],
          },
        );
      },
    })),
    {
      name: 'protection loaded FS survives table edit until same selector explicit reload',
      async run() {
        await using(
          compiler,
          '8ee264488b03',
          snapshot(),
          async (cpu) => {
            cpu.setState(initial(0x1000n, { 2: 8n, 3: 0n }));
            const first = await cpu.run({ budget: 2n });
            equal(first.state.registers[0], 0x11n, 'first base');
            cpu.writeMemory(0x400an, Uint8Array.from([0, 0x60]));
            cpu.setState(initial(0x1002n, { 2: 8n, 3: 0n }));
            const stale = await cpu.run({ budget: 1n });
            equal(stale.state.registers[0], 0x11n, 'loaded cache retained');
            equal(stale.resources.compilations, 0, 'middle entry reused');
            cpu.setState(initial(0x1000n, { 2: 8n, 3: 0n }));
            const reloaded = await cpu.run({ budget: 2n });
            equal(reloaded.state.registers[0], 0x22n, 'same selector fetched again');
            equal(cpu.readContext().segments.fs.base, 0x6000n, 'new cache published');
            equal(reloaded.resources.dispatches, 1, 'new base invalidation');
            check(
              cpu.inspectTranslations().some((unit) => unit.entries.includes(0x1000n)),
              'old-context unit remains dormant',
            );
          },
          {
            data: [
              { base: 0x4008n, bytes: 'ffff00500093cf00' },
              { base: 0x5000n, bytes: '1100000000000000', write: false },
              { base: 0x6000n, bytes: '2200000000000000', write: false },
            ],
          },
        );
      },
    },
  ];
}
