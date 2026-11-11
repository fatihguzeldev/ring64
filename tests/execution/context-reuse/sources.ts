import { LIMITS } from '../../support/fixture.js';
import { mapping, RX, RW } from '../mapped-memory/fixture.js';
import {
  changed,
  check,
  equal,
  hex,
  initial,
  little,
  longSnapshot,
  preserveNumeric,
  same,
  type Factory,
  type Scenario,
} from './fixture.js';
import { fastSetup, FAST_FORMS, KERNEL, USER } from './warm.js';

export function sourceScenarios(compiler: WebAssembly.Module, make: Factory): Scenario[] {
  return [
    ...(['host', 'guest'] as const).map((writer): Scenario => ({
      name: `context reuse invalidates dormant code through a ${writer} backing alias and never revives restored bytes`,
      async run() {
        const a = longSnapshot(),
          b = longSnapshot(0x5000n);
        const bytes = hex('b80100000082'),
          maps = [
            mapping(0x1000n, 'a', bytes.length, RX),
            mapping(0x4000n, 'a', bytes.length, RW),
            mapping(0x2000n, 'b', 5, RX),
          ];
        const cpu = await make({
          compiler,
          context: a,
          entry: 0x1000n,
          memory: {
            backings: [
              { id: 'a', bytes },
              { id: 'b', bytes: hex('90c6030982') },
            ],
            mappings: maps,
          },
          memoryLimits: { maxBackings: 2, maxMappings: 3, maxBackingBytes: 16 },
          limits: LIMITS,
        });
        try {
          const numeric = preserveNumeric(cpu),
            input = initial(0x1000n);
          cpu.setState(input);
          await cpu.run({ budget: 1n });
          const owner = cpu.inspectTranslations()[0]!.owner;
          cpu.setContext(b);
          cpu.setState(initial(0x2000n));
          await cpu.run({ budget: 1n });
          check(
            cpu.inspectTranslations().some((unit) => unit.owner === owner),
            'A remains live while B executes',
          );
          if (writer === 'host') cpu.writeMemory(0x4001n, Uint8Array.of(9));
          else {
            cpu.setState(initial(0x2001n, { 3: 0x4001n }));
            equal((await cpu.run({ budget: 1n })).retired, 1n, 'guest alias write completes');
          }
          check(
            !cpu.inspectTranslations().some((unit) => unit.owner === owner),
            'dormant owner invalidated by alias write',
          );
          cpu.writeMemory(0x4001n, Uint8Array.of(1));
          check(
            !cpu.inspectTranslations().some((unit) => unit.owner === owner),
            'same bytes do not revive an owner',
          );
          cpu.setContext(a);
          cpu.setState(input);
          const result = await cpu.run({ budget: 1n });
          equal(result.resources.compilations, 1, 'restored bytes require a fresh owner');
          same(result.state, changed(input, 0x1005n, { 0: 1n }), 'literal fresh scalar result');
          same(cpu.readMemory(0x1000n, bytes.length), bytes, 'code guard restored');
          numeric();
        } finally {
          cpu.dispose();
        }
      },
    })),
    {
      name: 'context reuse does not resurrect dormant owners after execute revocation or backing reincarnation',
      async run() {
        const a = longSnapshot(),
          b = longSnapshot(0x5000n),
          bytes = hex('b80700000082');
        const code = mapping(0x1000n, 'code', bytes.length, RX),
          other = mapping(0x2000n, 'other', 2, RX);
        const cpu = await make({
          compiler,
          context: a,
          entry: 0x1000n,
          memory: {
            backings: [
              { id: 'code', bytes },
              { id: 'other', bytes: hex('9082') },
            ],
            mappings: [code, other],
          },
          memoryLimits: { maxBackings: 2, maxMappings: 2, maxBackingBytes: 16 },
          limits: LIMITS,
        });
        try {
          const input = initial(0x1000n),
            numeric = preserveNumeric(cpu);
          for (const mutation of ['execute', 'incarnation'] as const) {
            cpu.setContext(a);
            cpu.setState(input);
            await cpu.run({ budget: 1n });
            const owner = cpu
              .inspectTranslations()
              .find((unit) => unit.entries.includes(0x1000n))!.owner;
            cpu.setContext(b);
            cpu.setState(initial(0x2000n));
            await cpu.run({ budget: 1n });
            check(
              cpu.inspectTranslations().some((unit) => unit.owner === owner),
              'source owner dormant before destructive mutation',
            );
            if (mutation === 'execute')
              cpu.setMappings([{ ...code, permissions: { ...RX, execute: false } }, other]);
            else {
              cpu.setMappings([other]);
              cpu.removeBacking('code');
              cpu.addBacking({ id: 'code', bytes });
            }
            cpu.setMappings([code, other]);
            check(
              !cpu.inspectTranslations().some((unit) => unit.owner === owner),
              'permission restoration or reused public id cannot revive source',
            );
            cpu.setContext(a);
            cpu.setState(input);
            const result = await cpu.run({ budget: 1n });
            equal(result.resources.compilations, 1, 'replacement source gets one fresh module');
            same(result.state, changed(input, 0x1005n, { 0: 7n }), 'replacement source result');
          }
          numeric();
        } finally {
          cpu.dispose();
        }
      },
    },
    ...(['host', 'guest'] as const).map((writer): Scenario => ({
      name: `context reuse keeps dormant executable PTE watches live through a ${writer} table alias`,
      async run() {
        const setup = fastSetup(compiler, FAST_FORMS[0]);
        setup.ram.set(hex('b80700000082'), 0x9000);
        setup.ram.set(hex('48890382'), 0xa000);
        setup.ram[0xa100] = 0x90;
        setup.ram.set(little(0x4063n), 0x4028); // VA405000 aliases physical leaf table4000.
        const a = setup.kernel,
          b = { ...a, segments: { ...a.segments, fs: { ...a.segments.fs, base: 0x403000n } } };
        const cpu = await make({ ...setup.options, context: a });
        try {
          const input = initial(USER),
            numeric = preserveNumeric(cpu);
          cpu.setState(input);
          await cpu.run({ budget: 1n });
          const owner = cpu.inspectTranslations()[0]!.owner;
          cpu.setContext(b);
          cpu.setState(initial(KERNEL + 0x100n));
          await cpu.run({ budget: 1n });
          check(
            cpu.inspectTranslations().some((unit) => unit.owner === owner),
            'executable PTE dependency remains registered while dormant',
          );
          if (writer === 'host') cpu.writePhysicalMemory(0x4000n, little(0x9067n));
          else {
            cpu.setState(initial(KERNEL, { 0: 0x9067n, 3: 0x405000n }));
            equal((await cpu.run({ budget: 1n })).retired, 1n, 'guest PTE alias writer retires');
          }
          check(
            !cpu.inspectTranslations().some((unit) => unit.owner === owner),
            'even identity PTE publication invalidates dormant executable dependency',
          );
          cpu.setContext(a);
          cpu.setState(input);
          const result = await cpu.run({ budget: 1n });
          equal(result.resources.compilations, 1, 'A uses freshly registered page dependency');
          same(
            result.state,
            changed(input, USER + 5n, { 0: 7n }),
            'literal code after PTE mutation',
          );
          same(
            cpu.readPhysicalMemory(0x4000n, 8),
            little(0x9067n),
            'leaf payload remains the literal mapping',
          );
          numeric();
        } finally {
          cpu.dispose();
        }
      },
    })),
  ];
}
