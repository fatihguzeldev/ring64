import { createCpu, type Cpu, type Options } from '../../../host/index.js';
import { Core } from '../../../host/core.js';
import { longSnapshot } from '../../support/context.js';
import { LIMITS, check, initial, exit } from '../../support/fixture.js';
import { using as usingProfile, type Profile } from '../identity-time/oracle.js';
import { PC, expected, same, equal, hex, bytes, type Scenario } from './compound-fixture.js';

export function compoundLifecycleScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'compound payload invalidates retained source owners before successor execution even when a later probe faults',
      async run() {
        for (const faultProbe of [false, true]) {
          const a = longSnapshot(),
            b = longSnapshot(0x20000n);
          const prefix = faultProbe ? 'c8001000' : 'c8000000';
          const code = hex(prefix + 'b80100000082' + '90'.repeat(6));
          const mappings = [
            {
              base: PC,
              backing: 'code',
              offset: 0,
              length: code.length,
              permissions: { read: true, write: false, execute: true },
            },
            {
              base: 0x4ff8n,
              backing: 'code',
              offset: 4,
              length: 8,
              permissions: { read: true, write: true, execute: false },
            },
          ];
          const cpu = await createCpu({
            compiler,
            context: a,
            entry: PC,
            limits: LIMITS,
            memory: { backings: [{ id: 'code', bytes: code }], mappings },
            memoryLimits: { maxBackings: 3, maxMappings: 4, maxBackingBytes: 64 },
          });
          try {
            for (const context of [a, b]) {
              cpu.setContext(context);
              cpu.setState(initial(PC + 4n, {}, 2n));
              equal(
                (await cpu.run({ budget: 1n })).state.registers[0],
                1n,
                'warm literal old successor',
              );
            }
            const owners = cpu
              .inspectTranslations()
              .filter((unit) => unit.entries.includes(PC + 4n))
              .map((unit) => unit.owner);
            check(owners.length > 0, 'retained source owners exist');
            cpu.setContext(a);
            const before = initial(PC, { 4: 0x5000n, 5: 0x90908200000009b8n }, 2n);
            cpu.setState(before);
            cpu.setTimeState({ tsc: 100n, tscAux: 0x89abcdef });
            const first = await cpu.run({ budget: 2n, repeatBudget: 0n });
            exit(
              first,
              faultProbe ? 'data-fault' : 'budget',
              2n,
              faultProbe ? 0n : 2n,
              faultProbe ? before : expected(before, PC + 9n, { 0: 9n, 4: 0x4ff8n, 5: 0x4ff8n }),
            );
            for (const owner of owners)
              check(
                !cpu.inspectTranslations().some((unit) => unit.owner === owner),
                'all aliased retained owners retired even at retired0',
              );
            same(
              cpu.readMemory(PC, 16),
              hex(prefix + 'b809000000829090' + '90909090'),
              'exact code payload and guards',
            );
            if (faultProbe) {
              cpu.addBacking({ id: 'endpoint', bytes: hex('a5') });
              cpu.setMappings([
                ...mappings,
                {
                  base: 0x3ff8n,
                  backing: 'endpoint',
                  offset: 0,
                  length: 1,
                  permissions: { read: false, write: true, execute: false },
                },
              ]);
              const retry = await cpu.run({ budget: 2n, repeatBudget: 0n });
              exit(
                retry,
                'budget',
                2n,
                2n,
                expected(before, PC + 9n, { 0: 9n, 4: 0x3ff8n, 5: 0x4ff8n }),
              );
            }
            same(
              cpu.readTimeState(),
              { tsc: 102n, tscAux: 0x89abcdef },
              'no replayed or faulted instruction counted',
            );
          } finally {
            cpu.dispose();
          }
        }
      },
    },
    {
      name: 'compound pending browser compilation rejects stale immediate bytes before any payload executes',
      async run() {
        const create = Core.create,
          compile = WebAssembly.compile;
        let core: Core | undefined;
        let cpu: Cpu | undefined;
        Core.create = async (...args) => {
          core = await create(...args);
          return core;
        };
        try {
          cpu = await createCpu({
            compiler,
            context: longSnapshot(),
            entry: PC,
            limits: LIMITS,
            memory: {
              backings: [
                { id: 'code', bytes: hex('c8000000') },
                { id: 'stack', bytes: new Uint8Array(256).fill(0xa5) },
              ],
              mappings: [
                {
                  base: PC,
                  backing: 'code',
                  offset: 0,
                  length: 4,
                  permissions: { read: true, write: false, execute: true },
                },
                {
                  base: 0x2000n,
                  backing: 'code',
                  offset: 0,
                  length: 4,
                  permissions: { read: true, write: true, execute: false },
                },
                {
                  base: 0x4f00n,
                  backing: 'stack',
                  offset: 0,
                  length: 256,
                  permissions: { read: true, write: true, execute: false },
                },
              ],
            },
            memoryLimits: { maxBackings: 2, maxMappings: 3, maxBackingBytes: 260 },
          });
          check(core, 'captured actual Core');
          let changed = false;
          WebAssembly.compile = async (buffer) => {
            if (!changed) {
              changed = true;
              core!.writeOwnedMemory(0x2001n, Uint8Array.of(0x20));
            }
            return compile(buffer);
          };
          const before = initial(PC, { 4: 0x5000n, 5: 0x6000n }, 2n);
          cpu.setState(before);
          cpu.setTimeState({ tsc: 100n, tscAux: 0x89abcdef });
          const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
          exit(result, 'budget', 1n, 1n, expected(before, PC + 4n, { 4: 0x4fd8n, 5: 0x4ff8n }));
          equal(result.resources.compilations, 2, 'stale attempt plus current source');
          equal(result.resources.nativeEntries, 1, 'stale compiled candidate never runs');
          same(cpu.readMemory(PC, 4), hex('c8200000'), 'current required immediate');
          const wanted = new Uint8Array(256).fill(0xa5);
          wanted.set(hex(bytes(0x6000n, 8)), 248);
          same(cpu.readMemory(0x4f00n, 256), wanted, 'one current payload only');
          same(
            cpu.readTimeState(),
            { tsc: 101n, tscAux: 0x89abcdef },
            'unpublished candidate has no tick',
          );
        } finally {
          WebAssembly.compile = compile;
          Core.create = create;
          cpu?.dispose();
        }
      },
    },
    {
      name: 'compound checkpoint fresh CPU resumes LEAVE while physical reset retains completed frame RAM and releases owners',
      async run() {
        const profile: Profile = { mode: 'protected', bits: 32, stack: 32, family: 'pg0' };
        await usingProfile({ createCpu, compiler }, 'c8000002c9', profile, async (cpu) => {
          cpu.writePhysicalMemory(0x5ffcn, hex('44332211'));
          const before = initial(PC, { 4: 0x5000n, 5: 0x6000n }, 2n);
          cpu.setState(before);
          cpu.setTimeState({ tsc: 100n, tscAux: 0x89abcdef });
          const first = await cpu.run({ budget: 1n, repeatBudget: 0n });
          exit(first, 'budget', 1n, 1n, expected(before, PC + 4n, { 4: 0x4ff4n, 5: 0x4ffcn }));
          const checkpoint = {
            state: cpu.readState(),
            context: cpu.readContext(),
            paging: cpu.readPagingState(),
            time: cpu.readTimeState(),
            bytes: cpu.readPhysicalMemory(0n, 0x50000),
            xmm: cpu.readXmmState(),
            mxcsr: cpu.readMxcsr(),
            x87: cpu.readX87State(),
            debug: cpu.readDebugState(),
            fast: cpu.readFastSystemState(),
          };
          const options: Options = {
            compiler,
            context: checkpoint.context,
            paging: checkpoint.paging,
            memoryModel: 'physical',
            entry: checkpoint.state.rip,
            limits: LIMITS,
            memory: {
              backings: [{ id: 'ram', bytes: checkpoint.bytes }],
              mappings: [
                {
                  base: 0n,
                  backing: 'ram',
                  offset: 0,
                  length: checkpoint.bytes.length,
                  permissions: { read: true, write: true, execute: true },
                },
              ],
            },
            memoryLimits: {
              maxBackings: 1,
              maxMappings: 1,
              maxBackingBytes: checkpoint.bytes.length,
            },
          };
          const restored = await createCpu(options);
          try {
            restored.setXmmState(checkpoint.xmm);
            restored.setMxcsr(checkpoint.mxcsr);
            restored.setX87State(checkpoint.x87);
            restored.setDebugState(checkpoint.debug);
            restored.setFastSystemState(checkpoint.fast);
            restored.setState(checkpoint.state);
            restored.setTimeState(checkpoint.time);
            for (const current of [cpu, restored]) {
              const result = await current.run({ budget: 1n, repeatBudget: 0n });
              exit(result, 'budget', 1n, 1n, expected(before, PC + 5n));
              same(
                current.readTimeState(),
                { tsc: 102n, tscAux: 0x89abcdef },
                'checkpoint LEAVE ledger',
              );
              same(
                current.readPhysicalMemory(0n, checkpoint.bytes.length),
                checkpoint.bytes,
                'LEAVE reads without changing frame',
              );
            }
          } finally {
            restored.dispose();
          }
          check(cpu.inspectTranslations().length > 0, 'compound source owners installed');
          cpu.reset();
          equal(cpu.inspectTranslations().length, 0, 'reset releases compound owners');
          equal(cpu.readContext().mode, 'real', 'physical reset context');
          equal(cpu.readPagingState().cr0, 0x60000010n, 'physical reset controls');
          same(cpu.readTimeState(), { tsc: 0n, tscAux: 0 }, 'physical reset retirement clock');
          same(
            cpu.readPhysicalMemory(0n, checkpoint.bytes.length),
            checkpoint.bytes,
            'reset preserves completed compound payload',
          );
        });
      },
    },
  ];
}
