import {
  createCpu,
  snapshot,
  initial,
  outcome,
  debug,
  equal,
  same,
  hex,
  LIMITS,
  preserveNumeric,
  type Scenario,
} from './fixture.js';

export function aliasScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'system TF store invalidates a write-only backing alias before reporting and redecodes continuation',
      async run() {
        const cpu = await createCpu({
          compiler,
          context: snapshot(),
          entry: 0x1000n,
          limits: LIMITS,
          memoryLimits: { maxBackings: 1, maxMappings: 3, maxBackingBytes: 16 },
          memory: {
            backings: [{ id: 'shared', bytes: hex('a5c6039090a5') }],
            mappings: [
              {
                base: 0x1000n,
                backing: 'shared',
                offset: 1,
                length: 4,
                permissions: { read: true, write: false, execute: true },
              },
              {
                base: 0x8000n,
                backing: 'shared',
                offset: 1,
                length: 1,
                permissions: { read: false, write: true, execute: false },
              },
              {
                base: 0x9000n,
                backing: 'shared',
                offset: 0,
                length: 6,
                permissions: { read: true, write: false, execute: false },
              },
            ],
          },
        });
        try {
          const numeric = preserveNumeric(cpu);
          cpu.setState(initial(0x1000n, { 3: 0x8000n }, 0x102n));
          const stored = await cpu.run({ budget: 1n });
          outcome(stored, 'debug-exception', 1n, 1n);
          debug(stored, 0x1000n, 0x1003n, true, 0x102n);
          same(cpu.readMemory(0x9000n, 6), hex('a590039090a5'), 'source alias and guards');
          equal(cpu.inspectTranslations().length, 0, 'old source owner retired');
          const resumed = await cpu.run({ budget: 1n });
          outcome(resumed, 'debug-exception', 1n, 1n);
          debug(resumed, 0x1003n, 0x1004n, true, 0x102n);
          equal(resumed.resources.compilations, 1, 'modified successor decoded');
          numeric();
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'system partial REP trap resumes current executable prefix bytes after backing alias mutation',
      async run() {
        const cpu = await createCpu({
          compiler,
          context: snapshot(),
          entry: 0x1000n,
          limits: LIMITS,
          memoryLimits: { maxBackings: 2, maxMappings: 4, maxBackingBytes: 16 },
          memory: {
            backings: [
              { id: 'shared', bytes: hex('a5f3a4a5') },
              { id: 'data', bytes: hex('90') },
            ],
            mappings: [
              {
                base: 0x1000n,
                backing: 'shared',
                offset: 1,
                length: 2,
                permissions: { read: true, write: false, execute: true },
              },
              {
                base: 0x8000n,
                backing: 'shared',
                offset: 1,
                length: 1,
                permissions: { read: false, write: true, execute: false },
              },
              {
                base: 0x9000n,
                backing: 'shared',
                offset: 0,
                length: 4,
                permissions: { read: true, write: false, execute: false },
              },
              {
                base: 0x6000n,
                backing: 'data',
                offset: 0,
                length: 1,
                permissions: { read: true, write: false, execute: false },
              },
            ],
          },
        });
        try {
          const numeric = preserveNumeric(cpu);
          cpu.setState(initial(0x1000n, { 1: 3n, 6: 0x6000n, 7: 0x8000n }, 0x102n));
          const partial = await cpu.run({ budget: 1n, repeatBudget: 3n });
          outcome(partial, 'debug-exception', 1n, 0n, 3n, 1n);
          debug(partial, 0x1000n, 0x1000n, false, 0x10102n);
          same(cpu.readMemory(0x9000n, 4), hex('a590a4a5'), 'prefix alias and guards');
          equal(partial.state.registers[1], 2n, 'one copied element');
          const resumed = await cpu.run({ budget: 1n, repeatBudget: 3n });
          outcome(resumed, 'debug-exception', 1n, 1n, 3n);
          debug(resumed, 0x1000n, 0x1001n, true, 0x102n);
          same(resumed.state.registers, partial.state.registers, 'new NOP does not replay REP');
          numeric();
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'system PUSHF writes a write-only qword ending at u64 max with no guard or numeric changes',
      async run() {
        const cpu = await createCpu({
          compiler,
          context: snapshot(),
          entry: 0x1000n,
          limits: LIMITS,
          memoryLimits: { maxBackings: 2, maxMappings: 3, maxBackingBytes: 16 },
          memory: {
            backings: [
              { id: 'code', bytes: hex('9c') },
              { id: 'stack', bytes: hex('a5a5a5a5a5a5a5a5a5a5') },
            ],
            mappings: [
              {
                base: 0x1000n,
                backing: 'code',
                offset: 0,
                length: 1,
                permissions: { read: true, write: false, execute: true },
              },
              {
                base: 0xfffffffffffffff8n,
                backing: 'stack',
                offset: 1,
                length: 8,
                permissions: { read: false, write: true, execute: false },
              },
              {
                base: 0x8000n,
                backing: 'stack',
                offset: 0,
                length: 10,
                permissions: { read: true, write: false, execute: false },
              },
            ],
          },
        });
        try {
          const numeric = preserveNumeric(cpu);
          cpu.setState(initial(0x1000n, { 4: 0n }, 0x3d7ed7n));
          const result = await cpu.run({ budget: 1n });
          outcome(result, 'budget', 1n, 1n);
          equal(result.state.flags, 0x3c7ed7n, 'begin clears RF');
          equal(result.state.registers[4], 0xfffffffffffffff8n, 'wrapped pointer start');
          same(
            cpu.readMemory(0x8000n, 10),
            hex('a5d77e3c0000000000a5'),
            'exact whole slot and guards',
          );
          numeric();
        } finally {
          cpu.dispose();
        }
      },
    },
  ];
}
