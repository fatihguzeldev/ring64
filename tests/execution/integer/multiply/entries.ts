import {
  CODE,
  changed,
  check,
  createFixture,
  equal,
  exit,
  hex,
  memory,
  type Scenario,
} from '../../../support/fixture.js';
import {
  completed,
  dividend,
  input,
  noFault,
  paired,
  patch,
  RAM,
  setup,
  written,
} from './fixture.js';
import { divide, multiply } from './oracle.js';

export function multiplyEntryScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createFixture(core);
  return [
    {
      name: 'retained multiply and divide suffixes read fresh full pairs source banks flags and RAM without predecessors',
      run: async () => {
        const code = 'f948f7f1486b13ff48f7e1';
        await using(
          code,
          async (cpu) => {
            const first = input(CODE, {}, 2n);
            cpu.setState(first);
            const installed = await cpu.run({ budget: 1n });
            exit(installed, 'budget', 1n, 1n, changed(first, 0x1001n, {}, 3n));
            equal(installed.resources.compilations, 1, 'prefix installs the arithmetic suffixes');
            for (const [low, high, divisor] of [
              [7n, 0n, 3n],
              [7n, 0n, 0n],
              [0n, 1n, 2n],
              [0n, 2n, 2n],
              [0xffffffffffffffffn, 0xfffffffffffffffen, 0xffffffffffffffffn],
            ])
              for (const flags of [2n, 0x8d7n]) {
                const before = input(0x1001n, { 0: low!, 2: high!, 1: divisor! }, flags);
                const answer = divide(dividend(before, 64), divisor!, 64, false);
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                if (answer)
                  completed(result, changed(before, 0x1004n, paired(before, 64, answer), 2n), 2n);
                else {
                  exit(result, 'divide-error', 1n, 0n, before);
                  noFault(result);
                }
                equal(
                  result.resources.compilations,
                  0,
                  'current pair and divisor use the retained entry',
                );
                memory(cpu, setup.ramBase, RAM);
              }
            for (const value of [0n, 0x8000000000000000n, 0xfffffffffffffffen, 3n]) {
              const ram = patch(RAM, 16, value, 8);
              cpu.writeMemory(setup.ramBase, hex(ram));
              const before = input(0x1004n, { 0: 0xfedcba9876543210n, 2: 0x8877665544332211n });
              const answer = multiply(value, -1n, 64, true);
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              completed(result, changed(before, 0x1008n, { 2: answer.low }, answer.flags), 0x803n);
              equal(
                result.resources.compilations,
                0,
                'IMUL consumes changed RAM and ignores its old destination',
              );
              memory(cpu, setup.ramBase, ram);
            }
            for (const flags of [2n, 0x8d7n]) {
              const before = input(0x1008n, { 0: 0xffffffffffffffffn, 1: 2n }, flags);
              const answer = multiply(before.registers[0]!, before.registers[1]!, 64, false);
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              completed(
                result,
                changed(before, 0x100bn, paired(before, 64, answer), answer.flags),
                0x803n,
              );
              equal(
                result.resources.compilations,
                0,
                'full product consumes current implicit banks',
              );
            }
            memory(cpu, setup.ramBase, patch(RAM, 16, 3n, 8));
            memory(cpu, CODE, code);
          },
          setup,
        );
      },
    },
    {
      name: 'cached divides execute after the translation allowance is spent while evicted divides retain the resource frontier',
      run: async () => {
        const code = '80030148f7f1';
        const ram = patch(RAM, 16, 0xfn, 1);
        for (const maxCachedArtifacts of [1, 2])
          await using(
            code,
            async (cpu) => {
              const before = input(CODE, { 0: 7n, 1: 0n, 2: 0n });
              const entry = changed(before, 0x1003n);
              cpu.setState(entry);
              const installed = await cpu.run({ budget: 1n });
              exit(installed, 'divide-error', 1n, 0n, entry);
              noFault(installed);
              equal(installed.resources.compilations, 1, 'faulting divide is retained');
              cpu.setState(before);
              const result = await cpu.run({ budget: 3n });
              const after = changed(before, 0x1003n, {}, 0x12n);
              exit(
                result,
                maxCachedArtifacts === 1 ? 'resource-limit' : 'divide-error',
                3n,
                1n,
                after,
              );
              noFault(result);
              equal(
                result.resources.compilations,
                1,
                'only the prefix consumes a translation attempt',
              );
              equal(
                result.resources.nativeEntries,
                maxCachedArtifacts === 1 ? 1 : 2,
                'cached arithmetic needs no additional admission',
              );
              memory(cpu, setup.ramBase, patch(ram, 16, 0x10n, 1));
              const retried = await cpu.run({ budget: 1n });
              exit(retried, 'divide-error', 1n, 0n, after);
              noFault(retried);
              equal(
                retried.resources.compilations,
                maxCachedArtifacts === 1 ? 1 : 0,
                'the next public run resets the admission allowance',
              );
              memory(cpu, setup.ramBase, patch(ram, 16, 0x10n, 1));
              memory(cpu, CODE, code);
            },
            {
              ...setup,
              ram,
              limits: { maxInstructions: 1, maxTranslationsPerRun: 1, maxCachedArtifacts },
            },
          );
      },
    },
    {
      name: 'overlapping divide suffix owners survive eviction and reinstallation with their current entry ordinal',
      run: async () => {
        const code = '48f7f1f6d0c1e020ebf9';
        await using(
          code,
          async (cpu) => {
            const at = async (
              pc: bigint,
              kind: 'divide' | 'error' | 'not' | 'shift' | 'jump',
              compilations: number,
              flags = 0x8d7n,
            ) => {
              const before = input(
                pc,
                { 0: 0xfedcba98765432ffn, 1: kind === 'error' ? 0n : 3n, 2: 0n },
                flags,
              );
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              if (kind === 'divide') {
                const answer = divide(dividend(before, 64), 3n, 64, false)!;
                completed(result, changed(before, 0x1003n, paired(before, 64, answer), 2n), 2n);
              } else if (kind === 'error') {
                exit(result, 'divide-error', 1n, 0n, before);
                noFault(result);
              } else {
                const next = kind === 'not' ? 0x1005n : kind === 'shift' ? 0x1008n : 0x1003n;
                const writes =
                  kind === 'not'
                    ? { 0: written(before.registers[0]!, 0n, 8) }
                    : kind === 'shift'
                      ? { 0: 0x765432ffn }
                      : {};
                exit(result, 'budget', 1n, 1n, changed(before, next, writes));
                noFault(result);
              }
              equal(
                result.resources.compilations,
                compilations,
                'current arithmetic owner compilation count',
              );
              memory(cpu, setup.ramBase, RAM);
            };
            await at(CODE, 'divide', 1);
            await at(0x1008n, 'jump', 1);
            check(
              cpu
                .inspectTranslations()
                .some((unit) => unit.entries[0] === 0x1003n && unit.entries[1] === 0x1008n),
              'backedge gives the shared suffix another ordinal',
            );
            await at(0x1003n, 'not', 0, 2n);
            await at(0x1005n, 'shift', 1);
            check(
              !cpu.inspectTranslations().some((unit) => unit.entries.includes(CODE)),
              'the old divide owner is evicted',
            );
            await at(0x1003n, 'not', 0);
            await at(CODE, 'error', 1, 0x12n);
            await at(0x1003n, 'not', 0, 0x12n);
            memory(cpu, CODE, code);
          },
          { ...setup, limits: { maxInstructions: 2, maxCachedArtifacts: 2 } },
        );
      },
    },
  ];
}
