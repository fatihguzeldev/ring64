import {
  CODE,
  changed,
  check,
  createFixture,
  equal,
  exit,
  fault,
  hex,
  memory,
  type Scenario,
} from '../../../support/fixture.js';
import { completed, input, noFault, patch, RAM, setup, written } from './fixture.js';
import { carry, scan, shift } from './oracle.js';

export function arithmeticObservationScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createFixture(core);
  return [
    {
      name: 'carry inputs survive partial writers and reach later arithmetic before another flag producer',
      run: async () => {
        const code = 'f9fec4f6d0c0d40910d84811c84819d00f92c1';
        await using(
          code,
          async (cpu) => {
            const before = input();
            cpu.setState(before);
            const result = await cpu.run({ budget: 8n });
            exit(
              result,
              'budget',
              8n,
              8n,
              changed(
                before,
                0x1013n,
                {
                  0: 0x1122334455667887n,
                  1: 0x1122334400000000n,
                },
                6n,
              ),
            );
            noFault(result);
            equal(result.resources.nativeEntries, 1, 'carry chain stays within one native entry');
            equal(result.resources.dispatches, 0, 'partial flag writers require no host dispatch');
            memory(cpu, setup.ramBase, RAM);
            memory(cpu, CODE, code);
          },
          setup,
        );
      },
    },
    {
      name: 'live carry survives mixed partial writers and status images before CMOV and branch consumers',
      run: async () => {
        const code = '10c866ffc266ffca41f6d3d0d4d0dc4f9ff84f9e4d0f42c17202fe03';
        const end = CODE + BigInt(code.length / 2);
        const ram = patch(RAM, 16, 0xfn, 1);
        await using(
          code,
          async (cpu) => {
            for (const carry of [0n, 1n]) {
              const before = input(
                CODE,
                { 0: 0x11223344556677ffn, 1: 0x1122334400000000n, 2: 0x112233440000ffffn },
                0x8d6n | carry,
              );
              cpu.writeMemory(setup.ramBase, hex(ram));
              cpu.setState(before);
              const result = await cpu.run({ budget: 13n, stop: end });
              exit(
                result,
                'stop',
                13n,
                carry ? 11n : 12n,
                changed(
                  before,
                  end,
                  {
                    0: carry ? 0x1122334455669700n : 0x11223344556696ffn,
                    8: before.registers[carry ? 9 : 8]!,
                    11: 0x11223344000000f4n,
                  },
                  carry ? 0x897n : 0x12n,
                ),
              );
              noFault(result);
              equal(result.resources.nativeEntries, 1, 'live consumers share their producer entry');
              equal(result.resources.compilations, carry ? 0 : 1, 'changed carry reuses the chain');
              memory(cpu, setup.ramBase, carry ? ram : patch(ram, 16, 0x10n, 1));
              memory(cpu, CODE, code);
            }
          },
          { ...setup, ram },
        );
      },
    },
    {
      name: 'concrete undefined shift flags survive preserving instructions zero counts and a failed bit scan',
      run: async () => {
        const code = 'c0e002f6d0480fcac1e020f90f92c1480fbc06';
        await using(
          code,
          async (cpu) => {
            const before = input(CODE, { 0: 0x1122334455667780n, 6: 0x7000n });
            cpu.setState(before);
            const produced = await cpu.run({ budget: 1n });
            completed(produced, changed(before, 0x1003n, { 0: 0x1122334455667700n }, 0x46n), 0xc7n);
            const atFault = changed(
              produced.state,
              0x100fn,
              {
                0: 0x556677ffn,
                2: 0x0200000044332211n,
              },
              produced.state.flags | 1n,
            );
            const failed = await cpu.run({ budget: 7n });
            exit(failed, 'data-fault', 7n, 5n, atFault);
            fault(failed, {
              instructionPc: 0x100fn,
              address: 0x7000n,
              width: 8,
              access: 'read',
              cause: 'unmapped',
              failingAddress: 0x7000n,
            });
            equal(failed.resources.compilations, 0, 'failed suffix retains its producer artifact');
            memory(cpu, setup.ramBase, RAM);
            const repaired = changed(atFault, atFault.rip, { 6: 0x4010n });
            cpu.setState(repaired);
            const resumed = await cpu.run({ budget: 1n });
            exit(resumed, 'budget', 1n, 1n, changed(repaired, 0x1013n, { 0: 0n }, 6n));
            noFault(resumed);
            equal(resumed.resources.compilations, 0, 'repair uses the retained bit scan');
            const imported = input(0x100fn, { 0: 0xfedcba9876543210n, 6: 0x7000n }, 0x8d7n);
            cpu.setState(imported);
            const importedFailure = await cpu.run({ budget: 1n });
            exit(importedFailure, 'data-fault', 1n, 0n, imported);
            fault(importedFailure, {
              instructionPc: 0x100fn,
              address: 0x7000n,
              width: 8,
              access: 'read',
              cause: 'unmapped',
              failingAddress: 0x7000n,
            });
            equal(importedFailure.resources.compilations, 0, 'fault consumes fresh imported flags');
            memory(cpu, setup.ramBase, RAM);
            memory(cpu, CODE, code);
          },
          setup,
        );
      },
    },
    {
      name: 'zero-count fault repair and stop boundaries never replay a completed non-idempotent memory prefix',
      run: async () => {
        const code = '80030166d326';
        const ram = patch(RAM, 16, 0n, 1);
        const after = patch(ram, 16, 1n, 1);
        await using(
          code,
          async (cpu) => {
            const before = input(CODE, { 1: 0n, 6: 0x7000n });
            const atFault = changed(before, 0x1003n, {}, 2n);
            cpu.setState(before);
            const failed = await cpu.run({ budget: 3n });
            exit(failed, 'data-fault', 3n, 1n, atFault);
            fault(failed, {
              instructionPc: 0x1003n,
              address: 0x7000n,
              width: 2,
              access: 'write',
              cause: 'unmapped',
              failingAddress: 0x7000n,
            });
            memory(cpu, setup.ramBase, after);
            const repaired = changed(atFault, atFault.rip, { 6: 0x4014n });
            cpu.setState(repaired);
            const resumed = await cpu.run({ budget: 1n });
            exit(resumed, 'budget', 1n, 1n, changed(repaired, 0x1006n));
            noFault(resumed);
            equal(resumed.resources.compilations, 0, 'repair reuses count-zero entry');
            memory(cpu, setup.ramBase, after);
            for (const stop of [false, true]) {
              cpu.writeMemory(setup.ramBase, hex(ram));
              cpu.setState(before);
              const result = await cpu.run(stop ? { budget: 3n, stop: 0x1003n } : { budget: 1n });
              exit(result, stop ? 'stop' : 'budget', stop ? 3n : 1n, 1n, atFault);
              noFault(result);
              equal(result.resources.compilations, 0, 'reached gate retains compiled entries');
              memory(cpu, setup.ramBase, after);
            }
            memory(cpu, CODE, code);
          },
          { ...setup, ram },
        );
      },
    },
    {
      name: 'unary and aliasing modifying-bit repairs retain an AF-setting non-idempotent prefix exactly once',
      run: async () => {
        const ramBase = 0x100004000n;
        const ram = patch(RAM, 16, 0xfn, 1);
        const after = patch(ram, 16, 0x10n, 1);
        for (const bit of [false, true]) {
          const operation = bit ? '660fbb09' : '66f716';
          const code = '800301' + operation + 'f6d2';
          const indexBank = bit ? 1 : 6;
          const failedAddress = bit ? 0x100007e00n : 0x100007000n;
          await using(
            code,
            async (cpu) => {
              const before = input(CODE, { 3: ramBase + 16n, [indexBank]: 0x100007000n });
              const atFault = changed(before, 0x1003n, {}, 0x12n);
              cpu.setState(before);
              const failed = await cpu.run({ budget: 3n });
              exit(failed, 'data-fault', 3n, 1n, atFault);
              fault(failed, {
                instructionPc: 0x1003n,
                address: failedAddress,
                width: 2,
                access: 'write',
                cause: 'unmapped',
                failingAddress: failedAddress,
              });
              memory(cpu, ramBase, after);
              const repaired = changed(atFault, atFault.rip, {
                [indexBank]: bit ? 0x1000038f6n : ramBase + 20n,
              });
              cpu.setState(repaired);
              const resumed = await cpu.run({ budget: 1n });
              completed(
                resumed,
                changed(repaired, 0x1003n + BigInt(operation.length / 2), {}, bit ? 2n : 0x12n),
                bit ? 0x43n : 0x8d7n,
              );
              equal(resumed.resources.compilations, 0, 'repair reuses its failed writer entry');
              const expectedRam = patch(after, 20, bit ? 0xa5e5n : 0x5a5an, 2);
              memory(cpu, ramBase, expectedRam);
              const preserved = await cpu.run({ budget: 1n });
              exit(
                preserved,
                'budget',
                1n,
                1n,
                changed(resumed.state, CODE + BigInt(code.length / 2), { 2: 0x11223344000000fdn }),
              );
              noFault(preserved);
              equal(preserved.resources.compilations, 0, 'preserver uses the retained suffix');
              memory(cpu, ramBase, expectedRam);
              memory(cpu, CODE, code);
            },
            { ...setup, ramBase, ram },
          );
        }
      },
    },
    {
      name: 'retained middle entries consume current carry counts bit indices scan values and RAM without predecessors',
      run: async () => {
        const code = 'f9d2d0660fa30b0fbcc2';
        await using(
          code,
          async (cpu) => {
            const first = input();
            cpu.setState(first);
            const installed = await cpu.run({ budget: 1n });
            exit(installed, 'budget', 1n, 1n, changed(first, 0x1001n));
            equal(installed.resources.compilations, 1, 'first entry installs all valid suffixes');
            for (const count of [0, 1, 9, 10, 32, 255])
              for (const flags of [2n, 0x8d7n]) {
                const before = input(0x1001n, { 0: 0xfedcba9876543288n, 1: BigInt(count) }, flags);
                const expected = shift('RCL', before.registers[0]!, 8, count, flags);
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                completed(
                  result,
                  changed(
                    before,
                    0x1003n,
                    {
                      0: written(before.registers[0]!, expected.result, 8),
                    },
                    expected.flags,
                  ),
                  expected.mask,
                );
                equal(
                  result.resources.compilations,
                  0,
                  'fresh count/carry consumes retained entry',
                );
              }
            for (const index of [-1n, 0n, 16n]) {
              const offset = index < 0n ? 14 : index === 16n ? 18 : 16;
              const ram = patch(RAM, offset, index < 0n ? 0x8000n : 1n, 2);
              cpu.writeMemory(setup.ramBase, hex(ram));
              for (const flags of [2n, 0x8d7n]) {
                const before = input(0x1003n, { 1: BigInt.asUintN(64, index) }, flags);
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                completed(result, changed(before, 0x1007n, {}, (flags & 0x42n) | 1n), 0x43n);
                equal(
                  result.resources.compilations,
                  0,
                  'fresh signed bit index consumes retained entry',
                );
                memory(cpu, setup.ramBase, ram);
              }
            }
            cpu.writeMemory(setup.ramBase, hex(RAM));
            for (const value of [0n, 0x100n, 0x180n]) {
              const before = input(0x1007n, { 0: 0xfedcba9876543210n, 2: value }, 0x8d7n);
              const answer = scan(false, value, 32);
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              exit(
                result,
                'budget',
                1n,
                1n,
                changed(before, 0x100an, value ? { 0: answer.result } : {}, answer.flags),
              );
              noFault(result);
              equal(result.resources.compilations, 0, 'zero/nonzero scan consumes current source');
            }
            memory(cpu, setup.ramBase, RAM);
            memory(cpu, CODE, code);
          },
          setup,
        );
      },
    },
    {
      name: 'overlapping arithmetic entry owners keep current ordinals and fresh inputs across eviction',
      run: async () => {
        const code = '10c8f6d0c1e020ebf9';
        await using(
          code,
          async (cpu) => {
            const at = async (
              pc: bigint,
              kind: 'adc' | 'not' | 'shift' | 'jump',
              compilations: number,
              flags = 0x8d7n,
            ) => {
              const before = input(pc, { 0: 0xfedcba98765432ffn, 1: 0x8877665544332200n }, flags);
              let next = 0x1002n,
                registers: Record<number, bigint> = {},
                outputFlags = flags;
              if (kind === 'adc') {
                const answer = carry(before.registers[0]!, before.registers[1]!, 8, flags);
                registers = { 0: written(before.registers[0]!, answer.result, 8) };
                outputFlags = answer.flags;
              } else if (kind === 'not') {
                next = 0x1004n;
                registers = { 0: 0xfedcba9876543200n };
              } else if (kind === 'shift') {
                next = 0x1007n;
                registers = { 0: 0x765432ffn };
              }
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              exit(result, 'budget', 1n, 1n, changed(before, next, registers, outputFlags));
              noFault(result);
              equal(
                result.resources.compilations,
                compilations,
                'arithmetic entry owner compilation count',
              );
              memory(cpu, setup.ramBase, RAM);
            };
            await at(0x1000n, 'adc', 1);
            await at(0x1007n, 'jump', 1);
            check(
              cpu
                .inspectTranslations()
                .some((unit) => unit.entries[0] === 0x1002n && unit.entries[1] === 0x1007n),
              'backedge installs a different ordinal for shared arithmetic entry',
            );
            await at(0x1002n, 'not', 0, 2n);
            await at(0x1004n, 'shift', 1);
            check(
              !cpu.inspectTranslations().some((unit) => unit.entries.includes(0x1000n)),
              'old arithmetic owner is evicted',
            );
            await at(0x1002n, 'not', 0);
            await at(0x1000n, 'adc', 1, 2n);
            await at(0x1002n, 'not', 0, 2n);
            memory(cpu, CODE, code);
          },
          { ...setup, limits: { maxInstructions: 2, maxCachedArtifacts: 2 } },
        );
      },
    },
    {
      name: 'integer frontiers retain reached decode priority and resume a failed carry writer without replay',
      run: async () => {
        const code = 'b07f481103';
        await using(
          code,
          async (cpu) => {
            const before = input(CODE, { 3: 0x7000n });
            const after = changed(before, 0x1002n, { 0: 0x112233445566777fn });
            cpu.setState(before);
            const frontier = await cpu.run({ budget: 3n });
            exit(frontier, 'resource-limit', 3n, 1n, after);
            noFault(frontier);
            const failed = await cpu.run({ budget: 1n });
            exit(failed, 'data-fault', 1n, 0n, after);
            fault(failed, {
              instructionPc: 0x1002n,
              address: 0x7000n,
              width: 8,
              access: 'write',
              cause: 'unmapped',
              failingAddress: 0x7000n,
            });
            const repaired = changed(after, after.rip, { 3: 0x4010n });
            const ram = patch(RAM, 16, 0xffffffffffffffffn, 8);
            cpu.writeMemory(setup.ramBase, hex(ram));
            cpu.setState(repaired);
            const resumed = await cpu.run({ budget: 1n });
            exit(resumed, 'budget', 1n, 1n, changed(repaired, 0x1005n, {}, 0x13n));
            noFault(resumed);
            equal(resumed.resources.compilations, 0, 'carry repair reuses its admitted frontier');
            memory(cpu, setup.ramBase, patch(ram, 16, repaired.registers[0]!, 8));
            memory(cpu, CODE, code);
          },
          { ...setup, limits: { maxInstructions: 1, maxTranslationsPerRun: 1 } },
        );
        for (const [tail, reason] of [
          ['f724', 'unsupported'],
          ['c183ff', 'fetch-fault'],
          ['c12300', 'resource-limit'],
        ] as const) {
          const code = 'f9' + tail;
          await using(
            code,
            async (cpu) => {
              const before = input(CODE, { 3: 0x800000000000n }, 2n);
              cpu.setState(before);
              const result = await cpu.run({ budget: 3n });
              exit(result, reason, 3n, 1n, changed(before, 0x1001n, {}, 3n));
              equal(result.resources.compilations, 1, 'only the reached prefix is compiled');
              if (reason === 'fetch-fault')
                fault(result, {
                  instructionPc: 0x1001n,
                  address: 0x1004n,
                  width: 1,
                  access: 'execute',
                  cause: 'unmapped',
                  failingAddress: 0x1004n,
                });
              else noFault(result);
              memory(cpu, setup.ramBase, RAM);
              memory(cpu, CODE, code);
            },
            { ...setup, limits: { maxInstructions: 1, maxTranslationsPerRun: 1 } },
          );
        }
      },
    },
  ];
}
