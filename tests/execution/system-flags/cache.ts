import {
  using,
  snapshot,
  initial,
  outcome,
  equal,
  check,
  preserveNumeric,
  type Scenario,
} from './fixture.js';

export function cacheScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'system CLI STI loops retain both boundary profiles without compilation growth or resource refusal',
      async run() {
        await using(compiler, 'fafbe2fc', snapshot(), async (cpu) => {
          const numeric = preserveNumeric(cpu);
          cpu.setState(initial(0x1000n, { 1: 3n }));
          const first = await cpu.run({ budget: 9n });
          outcome(first, 'budget', 9n, 9n);
          check(
            first.resources.compilations <= 6,
            'initial profile variants bounded by three entries',
          );
          const profiles = new Set(cpu.inspectTranslations().map((unit) => unit.boundaryObserved));
          check(profiles.has(false) && profiles.has(true), 'both profile owners coexist');
          cpu.setState(initial(0x1000n, { 1: 20n }));
          const repeated = await cpu.run({ budget: 60n });
          outcome(repeated, 'budget', 60n, 60n);
          equal(repeated.resources.compilations, 0, 'longer run uses retained variants');
          check(repeated.resources.cacheHits > 0, 'retained profile cache hits');
          equal(repeated.state.registers[1], 0n, 'all loop iterations complete');
          equal(repeated.state.rip, 0x1004n, 'loop terminates');
          equal(repeated.state.flags, 0x202n, 'STI state survives LOOP');
          equal(repeated.state.interruptibility.sti, false, 'LOOP consumes last interval');
          numeric();
        });
      },
    },
  ];
}
