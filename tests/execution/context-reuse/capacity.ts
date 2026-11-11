import {
  changed,
  check,
  equal,
  initial,
  linear,
  longSnapshot,
  preserveNumeric,
  same,
  type Factory,
  type Scenario,
} from './fixture.js';

export function capacityScenarios(compiler: WebAssembly.Module, make: Factory): Scenario[] {
  return [
    {
      name: 'context reuse counts variants once in one global LRU and rejected candidates do not become hot',
      async run() {
        const contexts = [longSnapshot(), longSnapshot(0x4000n), longSnapshot(0x5000n)];
        await linear(
          compiler,
          make,
          '909082',
          contexts[0]!,
          async (cpu) => {
            const input = initial(0x1000n),
              numeric = preserveNumeric(cpu);
            const visit = async (index: number, compilations: number) => {
              cpu.setContext(contexts[index]!);
              cpu.setState(input);
              const result = await cpu.run({ budget: 1n });
              equal(result.resources.compilations, compilations, 'literal global LRU miss or hit');
              same(result.state, changed(input, 0x1001n), 'eligible context executes one NOP');
              check(
                result.resources.cachedArtifacts <= 2,
                'one artifact limit includes every context and alias',
              );
              equal(
                result.resources.cachedBytes,
                cpu.inspectTranslations().reduce((bytes, unit) => bytes + unit.byteLength, 0),
                'global bytes count owners once',
              );
            };
            await visit(0, 1);
            const a = cpu.inspectTranslations()[0]!.owner;
            await visit(1, 1);
            const b = cpu.inspectTranslations().find((unit) => unit.owner !== a)!.owner;
            await visit(0, 0); // Candidate B is rejected, actual A use promotes only A.
            await visit(2, 1);
            const owners = cpu.inspectTranslations().map((unit) => unit.owner);
            check(
              owners.includes(a) && !owners.includes(b),
              'actual A use preserves A; rejected B is oldest',
            );
            await visit(0, 0);
            cpu.setState(initial(0x1001n));
            const middle = await cpu.run({ budget: 1n });
            equal(
              middle.resources.compilations,
              0,
              'middle entry stays attached to the same retained A',
            );
            equal(middle.resources.cachedArtifacts, 2, 'alias is not an extra artifact');
            await visit(1, 1);
            numeric();
          },
          { limits: { maxCachedArtifacts: 2 } },
        );
      },
    },
    {
      name: 'context reuse low-cap churn remains bounded and makes exactly one admitted instruction per short run',
      async run() {
        const a = longSnapshot(),
          b = longSnapshot(0x4000n);
        await linear(
          compiler,
          make,
          '909082',
          a,
          async (cpu) => {
            const input = initial(0x1000n),
              numeric = preserveNumeric(cpu);
            for (let i = 0; i < 101; i++) {
              cpu.setContext(i % 2 ? b : a);
              cpu.setState(input);
              const result = await cpu.run({ budget: 1n });
              equal(result.reason, 'budget', 'low-cap progress under quota1');
              equal(result.retired, 1n, 'exactly one admitted guest instruction');
              equal(result.resources.compilations, 1, 'only evicted variant is recompiled');
              equal(result.resources.nativeEntries, 1, 'no rejected candidate executes');
              equal(result.resources.cachedArtifacts, 1, 'single global owner retained');
              equal(
                cpu.inspectTranslations().length,
                1,
                'no hidden artifact history survives eviction',
              );
              same(result.state, changed(input, 0x1001n), 'literal churn result');
            }
            numeric();
          },
          { limits: { maxCachedArtifacts: 1, maxTranslationsPerRun: 1 } },
        );
      },
    },
  ];
}
