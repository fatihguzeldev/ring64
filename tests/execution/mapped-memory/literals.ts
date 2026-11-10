import {
  type Scenario,
  changed,
  check,
  equal,
  exit,
  fault,
  hex,
  memory,
  throws,
} from '../../support/fixture.js';
import { BASE, RW, RWX, RX, X, backing, input, mapping, using } from './fixture.js';

export function literalScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'mapped fetch supports execute-only bytes and split instruction backings',
      run: async () => {
        for (const split of [false, true]) {
          const banks = split
            ? [backing('a', 'b878'), backing('b', '563412')]
            : [backing('a', 'b878563412')];
          const maps = split
            ? [mapping(BASE, 'a', 2, X), mapping(BASE + 2n, 'b', 3, X)]
            : [mapping(BASE, 'a', 5, X)];
          await using(compiler, banks, maps, async (cpu) => {
            const before = input();
            cpu.setState(before);
            throws(() => cpu.readMemory(BASE, 1), 'X-only host read');
            exit(
              await cpu.run({ budget: 1n }),
              'budget',
              1n,
              1n,
              changed(before, 0x1005n, { 0: 0x12345678n }),
            );
          });
        }
        await using(
          compiler,
          [backing('a', 'b878'), backing('b', '563412')],
          [mapping(BASE, 'a', 2, X), mapping(BASE + 2n, 'b', 3, { ...X, execute: false })],
          async (cpu) => {
            const before = input();
            cpu.setState(before);
            const result = await cpu.run({ budget: 1n });
            exit(result, 'fetch-fault', 1n, 0n, before);
            fault(result, {
              instructionPc: BASE,
              address: BASE + 2n,
              failingAddress: BASE + 2n,
              width: 1,
              access: 'execute',
              cause: 'permission',
            });
          },
        );
      },
    },
    {
      name: 'mapped stores commit alias collisions in increasing guest-byte order',
      run: async () => {
        await using(
          compiler,
          [backing('code', '8903'), backing('data', 'a5a5')],
          [
            mapping(BASE, 'code', 2, RX),
            mapping(0x4000n, 'data', 2, RW),
            mapping(0x4002n, 'data', 2, RW),
          ],
          async (cpu) => {
            const before = input({ 0: 0x44332211n, 3: 0x4000n });
            cpu.setState(before);
            exit(await cpu.run({ budget: 1n }), 'budget', 1n, 1n, changed(before, BASE + 2n));
            memory(cpu, 0x4000n, '33443344');
          },
        );
      },
    },
    {
      name: 'equal mapped source bytes retain each guest PC relative meaning',
      run: async () => {
        await using(
          compiler,
          [backing('code', '488d0500000000')],
          [mapping(BASE, 'code', 7, RX), mapping(0x2000n, 'code', 7, RX)],
          async (cpu) => {
            for (const pc of [BASE, 0x2000n, BASE, 0x2000n]) {
              const before = input({}, pc);
              cpu.setState(before);
              exit(
                await cpu.run({ budget: 1n }),
                'budget',
                1n,
                1n,
                changed(before, pc + 7n, { 0: pc + 7n }),
              );
            }
          },
        );
      },
    },
    {
      name: 'unrelated data in executable backing keeps the active hot artifact running',
      run: async () => {
        const bytes = new Uint8Array(64).fill(0xa5);
        bytes.set(hex('fe034883e90175f8'));
        bytes[8] = 0x82;
        bytes[32] = 0;
        await using(
          compiler,
          [{ id: 'shared', bytes }],
          [mapping(BASE, 'shared', 64, RX), mapping(0x4000n, 'shared', 1, RW, 32)],
          async (cpu) => {
            const before = input({ 3: 0x4000n, 1: 1000n });
            for (let repeat = 0; repeat < 2; repeat++) {
              cpu.writeMemory(0x4000n, Uint8Array.of(0));
              cpu.setState(before);
              const result = await cpu.run({ budget: 3000n });
              exit(result, 'budget', 3000n, 3000n, changed(before, BASE + 8n, { 1: 0n }, 0x46n));
              memory(cpu, 0x4000n, 'e8');
              equal(result.resources.nativeEntries, 1, 'one native entry');
              equal(result.resources.dispatches, 0, 'no data-store dispatch');
              equal(result.resources.compilations, repeat === 0 ? 1 : 0, 'retained source reuse');
            }
          },
        );
      },
    },
    {
      name: 'guest code writes finish MOV INC and CALL before stale native routes are used',
      run: async () => {
        const cases = [
          {
            code: 'c60500000000bbb801000000',
            registers: {},
            next: 0x1007n,
            end: 0x100cn,
            after: { 3: 1n },
            flags: 0x8d7n,
            patched: 'c60500000000bbbb01000000',
          },
          {
            code: 'c603bbb801000000',
            registers: { 3: 0x4003n },
            alias: true,
            next: 0x1003n,
            end: 0x1008n,
            after: { 3: 1n },
            flags: 0x8d7n,
            patched: 'c603bbbb01000000',
          },
          {
            code: 'fe03b801000000',
            registers: { 3: 0x1002n },
            next: 0x1002n,
            end: 0x1007n,
            after: { 1: 1n },
            flags: 0x83n,
            patched: 'fe03b901000000',
          },
          {
            code: 'e803000000a5a5a5b901000000' + 'a5'.repeat(19),
            registers: { 4: 0x1010n },
            next: 0x1008n,
            end: 0x100dn,
            after: { 0: 0x55667798n, 4: 0x1008n },
            flags: 2n,
            call: true,
            patched: 'e803000000a5a5a50510000000000000' + 'a5'.repeat(16),
          },
        ];
        for (const item of cases) {
          for (const mode of ['budget', 'stop', 'complete', 'resource'] as const) {
            const maps = [mapping(BASE, 'code', item.code.length / 2, item.alias ? RX : RWX)];
            if (item.alias) maps.push(mapping(0x4000n, 'code', item.code.length / 2, RW));
            await using(
              compiler,
              [backing('code', item.code)],
              maps,
              async (cpu) => {
                const before = input(item.registers);
                cpu.setState(before);
                const result = await cpu.run({
                  budget: mode === 'budget' ? 1n : 2n,
                  ...(mode === 'stop' ? { stop: item.next } : {}),
                });
                const first = changed(
                  before,
                  item.next,
                  item.call ? { 4: 0x1008n } : {},
                  item.call ? 0x8d7n : item.flags,
                );
                if (mode === 'complete')
                  exit(result, 'budget', 2n, 2n, changed(before, item.end, item.after, item.flags));
                else
                  exit(
                    result,
                    mode === 'resource' ? 'resource-limit' : mode,
                    mode === 'budget' ? 1n : 2n,
                    1n,
                    first,
                  );
                memory(cpu, item.alias ? 0x4000n : BASE, item.patched);
                if (mode === 'budget' || mode === 'stop')
                  equal(
                    result.resources.cachedArtifacts,
                    0,
                    'stale sole owner removed before observation',
                  );
                if (mode === 'resource')
                  equal(result.resources.compilations, 1, 'one translation attempt');
                check(result.fault === undefined, 'completed code write retains no access fault');
              },
              mode === 'resource' ? { maxTranslationsPerRun: 1 } : {},
            );
          }
        }
        await using(
          compiler,
          [backing('code', cases[3]!.code)],
          [mapping(BASE, 'code', 32, RWX)],
          async (cpu) => {
            const before = input({ 4: 0x1010n });
            cpu.setState(before);
            const result = await cpu.run({ budget: 3n });
            exit(
              result,
              'data-fault',
              3n,
              2n,
              changed(before, 0x100dn, { 0: 0x55667798n, 4: 0x1008n }, 2n),
            );
            fault(result, {
              instructionPc: 0x100dn,
              address: 0x55667798n,
              failingAddress: 0x55667798n,
              width: 1,
              access: 'write',
              cause: 'unmapped',
            });
          },
        );
      },
    },
  ];
}
