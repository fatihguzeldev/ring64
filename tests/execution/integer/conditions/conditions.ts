import {
  createFixture,
  type Scenario,
  CODE,
  changed,
  equal,
  exit,
  fault,
  memory,
} from '../../../support/fixture.js';
import { defaultRam, input, noFault } from './fixture.js';

// Bit cc records the taken conditions for this literal CF/PF/ZF/SF/OF word.
const conditionTable: readonly (readonly [bigint, number])[] = [
  [0x2n, 0xaaaa],
  [0x3n, 0xaa66],
  [0x6n, 0xa6aa],
  [0x7n, 0xa666],
  [0x42n, 0x6a5a],
  [0x43n, 0x6a56],
  [0x46n, 0x665a],
  [0x47n, 0x6656],
  [0x82n, 0x59aa],
  [0x83n, 0x5966],
  [0x86n, 0x55aa],
  [0x87n, 0x5566],
  [0xc2n, 0x595a],
  [0xc3n, 0x5956],
  [0xc6n, 0x555a],
  [0xc7n, 0x5556],
  [0x802n, 0x5aa9],
  [0x803n, 0x5a65],
  [0x806n, 0x56a9],
  [0x807n, 0x5665],
  [0x842n, 0x5a59],
  [0x843n, 0x5a55],
  [0x846n, 0x5659],
  [0x847n, 0x5655],
  [0x882n, 0xa9a9],
  [0x883n, 0xa965],
  [0x886n, 0xa5a9],
  [0x887n, 0xa565],
  [0x8c2n, 0x6959],
  [0x8c3n, 0x6955],
  [0x8c6n, 0x6559],
  [0x8c7n, 0x6555],
];

export function conditionScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createFixture(core);
  return [
    {
      name: 'all short and near conditions reuse artifacts for every admitted flag word',
      run: async () => {
        for (let condition = 0; condition < 16; condition++)
          for (const near of [false, true]) {
            const code = near
              ? `0f${(0x80 + condition).toString(16)}0a000000`
              : `${(0x70 + condition).toString(16)}0e`;
            await using(
              code,
              async (cpu) => {
                let first = true;
                for (const [flags, taken] of conditionTable)
                  for (const auxiliary of [0n, 0x10n]) {
                    const before = input(
                      CODE,
                      { 0: 0x2233445500000000n + flags, 15: 0xfedcba9876543210n },
                      flags | auxiliary,
                    );
                    cpu.setState(before);
                    const result = await cpu.run({ budget: 1n });
                    const target = taken & (1 << condition) ? 0x1010n : near ? 0x1006n : 0x1002n;
                    exit(result, 'budget', 1n, 1n, changed(before, target));
                    noFault(result);
                    equal(result.resources.compilations, first ? 1 : 0, 'condition artifact reuse');
                    equal(
                      result.resources.nativeEntries,
                      1,
                      'one invocation per condition observation',
                    );
                    first = false;
                    memory(cpu, 0x4000n, '00');
                  }
                equal(cpu.inspectTranslations().length, 1, 'one condition artifact retained');
              },
              defaultRam,
            );
          }
      },
    },
    {
      name: 'mixed conditions and CMP distinguish signed from unsigned consumers',
      run: async () => {
        await using(
          '7c027202',
          async (cpu) => {
            const before = input(CODE, {}, 3n);
            cpu.setState(before);
            const result = await cpu.run({ budget: 2n });
            exit(result, 'budget', 2n, 2n, changed(before, 0x1006n));
            noFault(result);
            equal(result.resources.nativeEntries, 1, 'mixed conditions share an invocation');
            memory(cpu, 0x4000n, '00');
          },
          defaultRam,
        );
        for (const item of [
          { code: '39c87c02', target: 0x1006n },
          { code: '39c87202', target: 0x1004n },
          { code: '39c80f8c02000000', target: 0x100an },
          { code: '39c80f8202000000', target: 0x1008n },
        ])
          await using(
            item.code,
            async (cpu) => {
              const before = input(CODE, { 0: 0x1122334480000000n, 1: 1n });
              cpu.setState(before);
              const result = await cpu.run({ budget: 2n });
              exit(result, 'budget', 2n, 2n, changed(before, item.target, {}, 0x816n));
              noFault(result);
              memory(cpu, 0x4000n, '00');
            },
            defaultRam,
          );
      },
    },
    {
      name: 'near composite conditions route internal forward and backward edges with exact stops',
      run: async () => {
        await using(
          '0f8e0a000000b811000000ba22000000b933000000',
          async (cpu) => {
            const takenInput = input(CODE, {}, 0x8d2n);
            cpu.setState(takenInput);
            const taken = await cpu.run({ budget: 2n });
            exit(taken, 'budget', 2n, 2n, changed(takenInput, 0x1015n, { 1: 0x33n }));
            noFault(taken);
            equal(taken.resources.nativeEntries, 1, 'forward target stays inside its artifact');
            memory(cpu, 0x4000n, '00');

            const untakenInput = input(CODE, {}, 0x892n);
            cpu.setState(untakenInput);
            const untaken = await cpu.run({ budget: 4n });
            exit(
              untaken,
              'budget',
              4n,
              4n,
              changed(untakenInput, 0x1015n, { 0: 0x11n, 1: 0x33n, 2: 0x22n }),
            );
            noFault(untaken);
            equal(untaken.resources.nativeEntries, 1, 'fallthrough stays inside its artifact');
            memory(cpu, 0x4000n, '00');

            for (const budget of [1n, 2n]) {
              cpu.setState(takenInput);
              const gated = await cpu.run({ budget, stop: 0x1010n });
              exit(
                gated,
                budget === 1n ? 'budget' : 'stop',
                budget,
                1n,
                changed(takenInput, 0x1010n),
              );
              noFault(gated);
              equal(
                gated.resources.compilations,
                0,
                'stop uses an already admitted forward target',
              );
              memory(cpu, 0x4000n, '00');
            }
            const fresh = input(0x1006n, {}, 0x812n);
            cpu.setState(fresh);
            const middle = await cpu.run({ budget: 3n });
            exit(
              middle,
              'budget',
              3n,
              3n,
              changed(fresh, 0x1015n, { 0: 0x11n, 1: 0x33n, 2: 0x22n }),
            );
            noFault(middle);
            equal(middle.resources.compilations, 0, 'middle entry inherits no branch decision');
            memory(cpu, 0x4000n, '00');
          },
          defaultRam,
        );
        await using(
          'b8110000000f8ff5ffffff',
          async (cpu) => {
            const before = input(CODE, {}, 0x892n);
            cpu.setState(before);
            const result = await cpu.run({ budget: 7n });
            exit(result, 'budget', 7n, 7n, changed(before, 0x1005n, { 0: 0x11n }));
            noFault(result);
            equal(result.resources.nativeEntries, 1, 'backward target stays inside its artifact');
            memory(cpu, 0x4000n, '00');
          },
          defaultRam,
        );
      },
    },
    {
      name: 'new conditional edges sign extend displacements and wrap only completed next PCs',
      run: async () => {
        for (const item of [
          { code: '7c80', pc: CODE, target: 0xf82n },
          { code: '7c7f', pc: CODE, target: 0x1081n },
          { code: '0f8c00000080', pc: CODE, target: 0xffffffff80001006n },
          { code: '0f8cffffff7f', pc: CODE, target: 0x80001005n },
          { code: '7c06', pc: 0xfffffffffffffff8n, target: 0n },
          { code: '0f8c10000000', pc: 0xfffffffffffffffan, target: 0x10n },
          { code: '0f8c00000000', pc: 0xfffffffffffffffan, target: 0n },
        ])
          await using(
            item.code,
            async (cpu) => {
              const before = input(item.pc, {}, 0x812n);
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              exit(result, 'budget', 1n, 1n, changed(before, item.target));
              noFault(result);
              memory(cpu, 0x4000n, '00');
            },
            { ...defaultRam, codeBase: item.pc },
          );
        for (const code of ['7cfe', '0f8cfaffffff'])
          await using(
            code,
            async (cpu) => {
              const before = input(CODE, {}, 0x812n);
              cpu.setState(before);
              const result = await cpu.run({ budget: 7n });
              exit(result, 'budget', 7n, 7n, before);
              noFault(result);
              equal(
                result.resources.nativeEntries,
                1,
                'backedge stays in one generated invocation',
              );
              memory(cpu, 0x4000n, '00');
            },
            defaultRam,
          );
        await using(
          '0f8c010000',
          async (cpu) => {
            const before = input(0xfffffffffffffffbn, {}, 0x812n);
            cpu.setState(before);
            const result = await cpu.run({ budget: 1n });
            exit(result, 'fetch-fault', 1n, 0n, before);
            fault(result, {
              instructionPc: before.rip,
              address: before.rip,
              width: 6,
              access: 'execute',
              cause: 'address-range',
              failingAddress: 1n << 64n,
            });
            memory(cpu, 0x4000n, '00');
          },
          { ...defaultRam, codeBase: 0xfffffffffffffffbn },
        );
      },
    },
    {
      name: 'conditional suffix bytes are required before testing a false condition',
      run: async () => {
        for (const full of ['740e', '0f840a000000'])
          for (let length = 1; length < full.length / 2; length++)
            await using(
              full.slice(0, length * 2),
              async (cpu) => {
                const before = input(CODE, {}, 0x12n);
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                exit(result, 'fetch-fault', 1n, 0n, before);
                fault(result, {
                  instructionPc: CODE,
                  address: CODE + BigInt(length),
                  width: 1,
                  access: 'execute',
                  cause: 'unmapped',
                  failingAddress: CODE + BigInt(length),
                });
                equal(result.resources.compilations, 0, 'reached truncation precedes compilation');
                memory(cpu, 0x4000n, '00');
              },
              defaultRam,
            );
        for (const code of ['407400', '480f8400000000', '667400', '677400'])
          await using(
            code,
            async (cpu) => {
              const before = input();
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              exit(result, 'budget', 1n, 1n, changed(before, CODE + BigInt(code.length / 2)));
              noFault(result);
            },
            defaultRam,
          );
        for (const code of ['0fc1c0', '0fb1c0'])
          await using(
            code,
            async (cpu) => {
              const before = input();
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              exit(result, 'unsupported', 1n, 0n, before);
              noFault(result);
              equal(
                result.resources.compilations,
                0,
                'unsupported condition form precedes compilation',
              );
              memory(cpu, 0x4000n, '00');
            },
            defaultRam,
          );
      },
    },
  ];
}
