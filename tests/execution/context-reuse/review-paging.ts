import { Core } from '../../../host/core.js';
import {
  changed,
  check,
  equal,
  hex,
  initial,
  little,
  preserveNumeric,
  same,
  type Factory,
  type Scenario,
} from './fixture.js';
import { fastSetup, FAST_FORMS, KERNEL, USER } from './warm.js';

export function reviewPagingScenarios(compiler: WebAssembly.Module, make: Factory): Scenario[] {
  return [
    {
      name: 'context reuse rejects pending browser compilation across paging root ABA and permanently retires installed owners',
      async run() {
        const create = Core.create,
          translate = Core.prototype.compile,
          release = Core.prototype.release,
          dispose = Core.prototype.dispose,
          compile = WebAssembly.compile;
        let core: Core | undefined;
        let disposals = 0;
        const owners: bigint[] = [],
          releases: bigint[] = [];
        Core.create = async (...args) => {
          core = await create(...args);
          return core;
        };
        Core.prototype.compile = function (...args) {
          const unit = translate.apply(this, args);
          if (this === core && unit) owners.push(unit.metadata.owner);
          return unit;
        };
        Core.prototype.release = function (owner) {
          if (this === core) releases.push(owner);
          release.call(this, owner);
        };
        Core.prototype.dispose = function () {
          if (this === core) disposals++;
          dispose.call(this);
        };
        const setup = fastSetup(compiler, FAST_FORMS[0]);
        setup.ram.set(hex('b80700000082'), 0x9000);
        setup.ram.set(hex('b80b00000082'), 0xa000);
        setup.ram.fill(0, 0x6000, 0x7000);
        setup.ram.set(little(0x2027n), 0x6000); // Root B shares A's already-accessed tables.
        let cpu: Awaited<ReturnType<Factory>> | undefined;
        try {
          cpu = await make({
            ...setup.options,
            context: setup.kernel,
            limits: { ...setup.options.limits, maxTranslationsPerRun: 4 },
          });
          check(core, 'captured actual paged Core');
          const numeric = preserveNumeric(cpu),
            userInput = initial(USER),
            kernelInput = initial(KERNEL);
          cpu.setState(userInput);
          const primed = await cpu.run({ budget: 1n });
          same(primed.state, changed(userInput, USER + 5n, { 0: 7n }), 'literal installed A code');
          const installed = owners[0]!;
          check(core.valid(installed), 'installed source owner is initially alive');
          cpu.setState(kernelInput);
          let crossed = false;
          WebAssembly.compile = async (bytes) => {
            if (!crossed) {
              crossed = true;
              const pending = owners[1]!;
              check(core!.valid(pending), 'pending source exists before browser compilation');
              core!.setPagingState({ ...setup.paging, cr3: 0x6000n });
              check(!core!.valid(installed), 'root B permanently retires installed A owner');
              check(!core!.valid(pending), 'root B retires pending source owner');
              core!.setPagingState(setup.paging);
              for (const owner of [installed, pending]) {
                check(!core!.valid(owner), 'returning root A cannot revive either owner');
                equal(core!.publish(owner), false, 'retired assumptions cannot publish');
                equal(core!.activate(owner), false, 'retired owner cannot enter native code');
              }
            }
            return compile(bytes);
          };
          const result = await cpu.run({ budget: 1n });
          equal(crossed, true, 'actual browser compilation crossed both paging fences');
          equal(result.reason, 'budget', 'fresh current code completes');
          equal(result.retired, 1n, 'rejected pending code performs no guest work');
          equal(result.resources.compilations, 2, 'rejected pending attempt plus fresh attempt');
          equal(result.resources.nativeEntries, 1, 'only fresh code enters');
          equal(result.resources.cacheHits, 0, 'retired source is never a cache hit');
          same(
            result.state,
            changed(kernelInput, KERNEL + 5n, { 0: 11n }),
            'literal fresh kernel code',
          );
          same(
            cpu.readContext(),
            setup.kernel,
            'paging fences preserve complete execution context',
          );
          same(cpu.readPagingState(), setup.paging, 'root A and literal controls are restored');
          same(
            cpu.readPhysicalMemory(0n, setup.ram.length),
            setup.ram,
            'code tables and RAM guards are unchanged',
          );
          for (const owner of [installed, owners[1]!])
            equal(
              releases.filter((value) => value === owner).length,
              1,
              'each retired host owner is released exactly once',
            );
          check(core.valid(owners[2]!), 'fresh pending owner is installed');
          cpu.setState(userInput);
          const returned = await cpu.run({ budget: 1n });
          equal(
            returned.resources.compilations,
            1,
            'old installed A code must be freshly compiled',
          );
          same(
            returned.state,
            changed(userInput, USER + 5n, { 0: 7n }),
            'literal recompiled A code',
          );
          check(
            owners[3] !== installed && core.valid(owners[3]!),
            'return receives a new live identity',
          );
          numeric();
          cpu.dispose();
          cpu = undefined;
          equal(disposals, 1, 'idle disposal drops the remaining core ownership once');
          for (const owner of [installed, owners[1]!])
            equal(
              releases.filter((value) => value === owner).length,
              1,
              'disposal does not repeat cleanup of already retired owners',
            );
        } finally {
          WebAssembly.compile = compile;
          cpu?.dispose();
          Core.prototype.dispose = dispose;
          Core.prototype.release = release;
          Core.prototype.compile = translate;
          Core.create = create;
        }
      },
    },
  ];
}
