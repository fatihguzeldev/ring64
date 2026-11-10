import {
  createFixture,
  type Scenario,
  CODE,
  DATA,
  FRAME,
  check,
  equal,
  hex,
  memory,
  initial,
  changed,
  exit,
} from '../support/fixture.js';

export function translationsScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createFixture(core);
  return [
    {
      name: 'overlapping instruction entries do not reuse incompatible decoding',
      run: async () => {
        await using('b8b903000000', async (cpu) => {
          const first = initial();
          cpu.setState(first);
          exit(
            await cpu.run({ budget: 1n }),
            'budget',
            1n,
            1n,
            changed(first, CODE + 5n, { 0: 0x3b9n }),
          );
          const middle = initial(CODE + 1n);
          cpu.setState(middle);
          exit(
            await cpu.run({ budget: 1n }),
            'budget',
            1n,
            1n,
            changed(middle, CODE + 6n, { 1: 3n }),
          );
          cpu.setState(first);
          const reused = await cpu.run({ budget: 1n });
          exit(reused, 'budget', 1n, 1n, changed(first, CODE + 5n, { 0: 0x3b9n }));
          equal(reused.resources.compilations, 0, 'first entry remains reusable');
        });
      },
    },
    {
      name: 'artifact reuse observes changed registers, RAM, flags, budgets and stops',
      run: async () => {
        await using('488b03488913', async (cpu) => {
          const first = initial(CODE, { 2: 0x0102030405060708n }, 0x8d7n);
          cpu.setState(first);
          const compiled = await cpu.run({ budget: 3n, stop: CODE + 6n });
          exit(compiled, 'stop', 3n, 2n, changed(first, CODE + 6n, { 0: 0x1122334455667788n }));
          memory(cpu, DATA - 8n, '10111213141516170807060504030201f0f1f2f3f4f5f6f7');
          check(compiled.resources.compilations > 0, 'initial code was not compiled');
          cpu.writeMemory(DATA + 8n, hex('1112131415161718'));
          const second = initial(CODE, { 2: 0x2122232425262728n, 3: DATA + 8n }, 2n);
          cpu.setState(second);
          const cut = await cpu.run({ budget: 2n, stop: CODE + 3n });
          exit(cut, 'stop', 2n, 1n, changed(second, CODE + 3n, { 0: 0x1817161514131211n }));
          equal(cut.resources.compilations, 0, 'reused input-dependent load');
          memory(cpu, DATA - 8n, '101112131415161708070605040302011112131415161718');
          const resumed = await cpu.run({ budget: 1n, stop: CODE + 3n });
          exit(resumed, 'stop', 1n, 0n, changed(second, CODE + 3n, { 0: 0x1817161514131211n }));
          const stored = await cpu.run({ budget: 1n });
          exit(stored, 'budget', 1n, 1n, changed(second, CODE + 6n, { 0: 0x1817161514131211n }));
          equal(stored.resources.compilations, 0, 'reused store entry');
          memory(cpu, DATA - 8n, '101112131415161708070605040302012827262524232221');
        });
      },
    },
    {
      name: 'identical guest entry addresses in different images remain independent',
      run: async () => {
        for (const [code, value] of [
          ['b801000000', 1n],
          ['b802000000', 2n],
        ] as const)
          await using(code, async (cpu) => {
            const input = initial();
            cpu.setState(input);
            exit(
              await cpu.run({ budget: 1n }),
              'budget',
              1n,
              1n,
              changed(input, CODE + 5n, { 0: value }),
            );
          });
      },
    },
    {
      name: 'finite limits refuse oversized units and bound translations per run',
      run: async () => {
        for (const limits of [
          { maxSourceBytes: 1 },
          { maxArtifactBytes: 1 },
          { maxCachedBytes: 1 },
        ]) {
          await using(
            'b801000000',
            async (cpu) => {
              const input = initial();
              cpu.setState(input);
              exit(await cpu.run({ budget: 1n }), 'resource-limit', 1n, 0n, input);
            },
            { limits },
          );
        }
        await using(
          'b8010000004883c001',
          async (cpu) => {
            const input = initial();
            cpu.setState(input);
            exit(
              await cpu.run({ budget: 3n, stop: CODE + 9n }),
              'resource-limit',
              3n,
              1n,
              changed(input, CODE + 5n, { 0: 1n }),
            );
            exit(
              await cpu.run({ budget: 2n, stop: CODE + 9n }),
              'stop',
              2n,
              1n,
              changed(input, CODE + 9n, { 0: 2n }),
            );
          },
          { limits: { maxInstructions: 1, maxTranslationsPerRun: 1 } },
        );
        for (const suffix of ['82', '48b8'])
          await using(
            `b801000000${suffix}`,
            async (cpu) => {
              const input = initial();
              cpu.setState(input);
              exit(
                await cpu.run({ budget: 3n }),
                suffix === '82' ? 'unsupported' : 'fetch-fault',
                3n,
                1n,
                changed(input, CODE + 5n, { 0: 1n }),
              );
            },
            { limits: { maxInstructions: 1, maxTranslationsPerRun: 1 } },
          );
      },
    },
    {
      name: 'overlapping-entry eviction removes only the evicted artifact ownership',
      run: async () => {
        await using(
          'b8b903000000',
          async (cpu) => {
            const input = initial();
            cpu.setState(input);
            exit(
              await cpu.run({ budget: 1n }),
              'budget',
              1n,
              1n,
              changed(input, CODE + 5n, { 0: 0x3b9n }),
            );
            const middle = initial(CODE + 1n);
            cpu.setState(middle);
            const second = await cpu.run({ budget: 1n });
            exit(second, 'budget', 1n, 1n, changed(middle, CODE + 6n, { 1: 3n }));
            equal(cpu.inspectTranslations().length, 1, 'one cached artifact');
            check(
              cpu.inspectTranslations()[0]!.entries.includes(CODE + 1n),
              'new entry ownership missing',
            );
            cpu.setState(input);
            const again = await cpu.run({ budget: 1n });
            exit(again, 'budget', 1n, 1n, changed(input, CODE + 5n, { 0: 0x3b9n }));
            equal(again.resources.compilations, 1, 'evicted entry recompiles');
          },
          { limits: { maxCachedArtifacts: 1 } },
        );
        // The second artifact redecodes an interior entry and takes ownership of
        // the first entry too. Evicting the older owner must preserve that mapping.
        await using(
          'b8b903000000ebf8b807000000',
          async (cpu) => {
            const first = initial();
            cpu.setState(first);
            exit(
              await cpu.run({ budget: 1n }),
              'budget',
              1n,
              1n,
              changed(first, CODE + 5n, { 0: 0x3b9n }),
            );
            const middle = initial(CODE + 1n);
            cpu.setState(middle);
            exit(
              await cpu.run({ budget: 1n }),
              'budget',
              1n,
              1n,
              changed(middle, CODE + 6n, { 1: 3n }),
            );
            check(
              cpu
                .inspectTranslations()
                .some((unit) => unit.entries.includes(CODE) && unit.entries.includes(CODE + 1n)),
              'new artifact did not acquire the shared entry',
            );
            const third = initial(CODE + 8n);
            cpu.setState(third);
            exit(
              await cpu.run({ budget: 1n }),
              'budget',
              1n,
              1n,
              changed(third, CODE + 13n, { 0: 7n }),
            );
            cpu.setState(first);
            const reused = await cpu.run({ budget: 1n });
            exit(reused, 'budget', 1n, 1n, changed(first, CODE + 5n, { 0: 0x3b9n }));
            equal(
              reused.resources.compilations,
              0,
              'eviction preserved the newer owner of the first entry',
            );
          },
          { limits: { maxCachedArtifacts: 2 } },
        );
      },
    },
    {
      name: 'entry indexes follow their owner through overlap, eviction and recompilation',
      run: async () => {
        await using(
          'b801000000b902000000ebf9ba03000000',
          async (cpu) => {
            const first = initial();
            cpu.setState(first);
            const a = await cpu.run({ budget: 1n });
            exit(a, 'budget', 1n, 1n, changed(first, CODE + 5n, { 0: 1n }));
            equal(a.resources.compilations, 1, 'first owner compiled');

            const backward = initial(CODE + 10n);
            cpu.setState(backward);
            const b = await cpu.run({ budget: 1n });
            exit(b, 'budget', 1n, 1n, changed(backward, CODE + 5n));
            equal(
              b.resources.compilations,
              1,
              'higher requested PC compiled with a lower admitted entry',
            );
            const owners = cpu.inspectTranslations();
            check(
              owners.some(
                (unit) =>
                  unit.entries.length === 2 &&
                  unit.entries[0] === CODE &&
                  unit.entries[1] === CODE + 5n,
              ),
              'first owner entries',
            );
            check(
              owners.some(
                (unit) =>
                  unit.entries.length === 2 &&
                  unit.entries[0] === CODE + 5n &&
                  unit.entries[1] === CODE + 10n,
              ),
              'replacement owner has a different index at the shared PC',
            );

            const shared = initial(CODE + 5n, {}, 0x8d7n);
            const useShared = async (): Promise<void> => {
              cpu.setState(shared);
              const result = await cpu.run({ budget: 1n });
              exit(result, 'budget', 1n, 1n, changed(shared, CODE + 10n, { 1: 2n }));
              equal(result.resources.compilations, 0, 'shared entry retains its current owner');
              equal(
                result.resources.nativeEntries,
                1,
                'shared entry does not dispatch to another index',
              );
            };
            await useShared();

            const third = initial(CODE + 12n);
            cpu.setState(third);
            const c = await cpu.run({ budget: 1n });
            exit(c, 'budget', 1n, 1n, changed(third, CODE + 17n, { 2: 3n }));
            equal(c.resources.compilations, 1, 'third owner compiled');
            check(
              !cpu.inspectTranslations().some((unit) => unit.entries.includes(CODE)),
              'old owner was evicted',
            );
            await useShared();

            cpu.setState(first);
            const recompiled = await cpu.run({ budget: 1n });
            exit(recompiled, 'budget', 1n, 1n, changed(first, CODE + 5n, { 0: 1n }));
            equal(recompiled.resources.compilations, 1, 'evicted owner recompiled');
            await useShared();

            cpu.setState(backward);
            const retained = await cpu.run({ budget: 1n });
            exit(retained, 'budget', 1n, 1n, changed(backward, CODE + 5n));
            equal(
              retained.resources.compilations,
              0,
              'the other entry of the overlapping owner survives',
            );
            memory(cpu, DATA - 8n, FRAME);
          },
          { limits: { maxInstructions: 2, maxCachedArtifacts: 2 } },
        );
      },
    },
  ];
}
