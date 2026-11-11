import { Core } from '../../../host/core.js';
import { LIMITS } from '../../support/fixture.js';
import { mapping, RX, RW } from '../mapped-memory/fixture.js';
import {
  changed,
  check,
  equal,
  hex,
  initial,
  longSnapshot,
  same,
  throws,
  type Factory,
  type Scenario,
} from './fixture.js';

export function lifecycleScenarios(compiler: WebAssembly.Module, make: Factory): Scenario[] {
  return [
    {
      name: 'context reuse rejects pending context ABA source and profile changes without killing compatible installed owners',
      async run() {
        for (const change of ['aba', 'source', 'profile'] as const) {
          const create = Core.create,
            translate = Core.prototype.compile,
            compile = WebAssembly.compile;
          let core: Core | undefined;
          const owners: bigint[] = [];
          Core.create = async (...args) => {
            core = await create(...args);
            return core;
          };
          Core.prototype.compile = function (...args) {
            const unit = translate.apply(this, args);
            if (unit) owners.push(unit.metadata.owner);
            return unit;
          };
          const a = longSnapshot(),
            b = longSnapshot(0x4000n);
          const cpu = await make({
            compiler,
            context: a,
            entry: 0x1000n,
            memory: {
              backings: [{ id: 'code', bytes: hex('b80700000082') }],
              mappings: [mapping(0x1000n, 'code', 6, RX), mapping(0x4000n, 'code', 6, RW)],
            },
            memoryLimits: { maxBackings: 1, maxMappings: 2, maxBackingBytes: 6 },
            limits: LIMITS,
          });
          try {
            const input = initial(0x1000n);
            cpu.setState(input);
            await cpu.run({ budget: 1n });
            check(core, 'captured actual Core test hook');
            const installed = owners[0]!;
            cpu.setContext(b);
            cpu.setState(input);
            let changedOnce = false;
            WebAssembly.compile = async (bytes) => {
              if (!changedOnce) {
                changedOnce = true;
                throws(() => cpu.setContext(a), 'public active-run context write is refused');
                throws(() => cpu.setState(input), 'public active-run scalar write is refused');
                throws(() => cpu.dispose(), 'public active-run disposal is refused');
                if (change === 'aba') {
                  core!.setContext(a);
                  core!.setContext(b);
                } else if (change === 'source') core!.writeOwnedMemory(0x4001n, Uint8Array.of(9));
                else
                  core!.setDebugState({
                    ...core!.readDebugState(),
                    addresses: [0x2000n, 0n, 0n, 0n],
                    dr7: 0x401n,
                  });
              }
              return compile(bytes);
            };
            const result = await cpu.run({ budget: 1n });
            equal(result.reason, 'budget', 'current pending retry completes');
            equal(
              result.resources.compilations,
              2,
              'one rejected pending unit and one current unit',
            );
            equal(result.resources.nativeEntries, 1, 'rejected pending unit never executes');
            same(
              result.state,
              changed(input, 0x1005n, { 0: change === 'source' ? 9n : 7n }),
              'literal current bytes and context',
            );
            check(!core.valid(owners[1]!), 'unpublished old assumption owner is released');
            check(core.valid(owners[2]!), 'only new pending attempt is published');
            equal(
              core.valid(installed),
              change !== 'source',
              'ABA/profile changes preserve old installed A; source edit retires it',
            );
            same(cpu.readContext(), b, 'final B context is not overwritten by install');
          } finally {
            WebAssembly.compile = compile;
            Core.prototype.compile = translate;
            Core.create = create;
            cpu.dispose();
          }
        }
      },
    },
    {
      name: 'context reuse releases real unpublished source owners on browser compilation and instantiation failures',
      async run() {
        for (const stage of ['compile', 'instantiate'] as const) {
          const create = Core.create,
            translate = Core.prototype.compile,
            compile = WebAssembly.compile,
            Instance = WebAssembly.Instance;
          let core: Core | undefined, owner: bigint | undefined;
          Core.create = async (...args) => {
            core = await create(...args);
            return core;
          };
          Core.prototype.compile = function (...args) {
            const unit = translate.apply(this, args);
            owner = unit?.metadata.owner;
            return unit;
          };
          const cpu = await make({
            compiler,
            context: longSnapshot(),
            code: { base: 0x1000n, bytes: hex('9082') },
            ram: { base: 0x4000n, bytes: new Uint8Array(8) },
            limits: LIMITS,
          });
          try {
            if (stage === 'compile')
              WebAssembly.compile = async () => {
                throw new Error('literal compile refusal');
              };
            else
              WebAssembly.Instance = class extends Instance {
                constructor(module: WebAssembly.Module, imports?: WebAssembly.Imports) {
                  super(module, imports);
                  throw new Error('literal instantiate refusal');
                }
              };
            let rejected = false;
            try {
              await cpu.run({ budget: 1n });
            } catch (error) {
              rejected = String(error).includes('cpu engine failed');
            }
            check(rejected, 'browser refusal follows existing engine-failure lifecycle');
            check(
              core && owner !== undefined,
              'real source owner allocated before browser refusal',
            );
            equal(
              core.valid(owner),
              false,
              'failed browser operation releases unpublished Rust owner',
            );
          } finally {
            WebAssembly.compile = compile;
            WebAssembly.Instance = Instance;
            Core.prototype.compile = translate;
            Core.create = create;
            cpu.dispose();
          }
        }
      },
    },
    {
      name: 'context reuse captures run-option context changes and still rejects a nested outer run',
      async run() {
        const a = longSnapshot(0x4000n),
          b = longSnapshot(0x5000n),
          bytes = new Uint8Array(0x2000);
        bytes[0] = 0x11;
        bytes[0x1000] = 0x22;
        const cpu = await make({
          compiler,
          context: a,
          code: { base: 0x1000n, bytes: hex('648a0382') },
          ram: { base: 0x4000n, bytes },
          limits: LIMITS,
        });
        try {
          const input = initial(0x1000n, { 3: 0n });
          for (const context of [a, b]) {
            cpu.setContext(context);
            cpu.setState(input);
            await cpu.run({ budget: 1n });
          }
          cpu.setContext(a);
          cpu.setState(input);
          let reads = 0;
          const selected = await cpu.run({
            get budget() {
              reads++;
              cpu.setContext(b);
              return 1n;
            },
          });
          equal(reads, 1, 'budget getter captured once');
          equal(selected.resources.compilations, 0, 'post-getter B artifact is warm');
          same(
            selected.state,
            changed(input, 0x1003n, { 0: 0x1122334400000022n }),
            'outer run uses B after capture',
          );
          cpu.setState(input);
          let nested: Promise<unknown> | undefined,
            refused = false;
          try {
            await cpu.run({
              get budget() {
                nested = cpu.run({ budget: 1n });
                return 1n;
              },
            });
          } catch {
            refused = true;
          }
          await nested;
          check(refused, 'nested run started by getter rejects outer run');
          same(
            cpu.readState(),
            changed(input, 0x1003n, { 0: 0x1122334400000022n }),
            'only nested run executes',
          );
        } finally {
          cpu.dispose();
        }
      },
    },
  ];
}
