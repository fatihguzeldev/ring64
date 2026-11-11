import {
  LONG,
  input,
  changed,
  outcome,
  stack,
  slot,
  clone,
  environment,
  seed,
  other,
  x87,
  noFault,
  using,
  equal,
  type Scenario,
} from './fixture.js';

export function specialImageScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'x87 partial remainder survives actual legacy and FX save init restore instructions',
      async run() {
        for (const fx of [false, true]) {
          const code = fx ? 'd9f8480fae03dbe3480fae0bd9f8' : 'd9f8dd33dd23d9f8';
          await using(
            compiler,
            code,
            LONG,
            async (cpu) => {
              const before = input(0x1000n, { 3: 0x6000n });
              const state = stack({ 0: 0x403f8000000000000002n, 1: 0x3fffc000000000000000n });
              const partial = clone(state);
              slot(partial, 0, 0x401f8000000200000000n);
              partial.statusWord = 0x400;
              cpu.setState(before);
              seed(cpu, state);
              const first = await cpu.run({ budget: 1n });
              outcome(first, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1002n));
              x87(cpu, environment(partial));
              const save = await cpu.run({ budget: fx ? 2n : 1n });
              equal(save.reason, 'budget', 'actual save and init complete');
              equal(cpu.readX87State().tagWord, 0xffff, 'save/init empties active stack');
              const restored = await cpu.run({ budget: 1n });
              equal(restored.reason, 'budget', 'restore complete');
              const saved = environment(partial);
              if (!fx) saved.dataPointer = 0x33334444n;
              x87(cpu, saved);
              const expected = clone(saved);
              slot(expected, 0, 0x3ffe8000000000000000n);
              expected.statusWord = 0x300;
              const final = await cpu.run({ budget: 1n });
              equal(final.reason, 'budget', 'resumed reduction completes');
              x87(cpu, environment(expected, fx ? 0x100cn : 0x1006n));
              other(cpu);
              noFault(final);
            },
            { data: [{ base: 0x6000n, bytes: 'a5'.repeat(fx ? 512 : 108) }] },
          );
        }
      },
    },
  ];
}
