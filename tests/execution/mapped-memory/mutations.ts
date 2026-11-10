import { type Scenario, changed, equal, exit, hex, memory, throws } from '../../support/fixture.js';
import { BASE, RW, RX, backing, input, mapping, using } from './fixture.js';

export function mutationScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'equivalent split sources retain owners while identical alias stores invalidate them',
      run: async () => {
        const alias = mapping(0x4000n, 'code', 5, RW);
        const joined = mapping(BASE, 'code', 5, RX);
        await using(
          compiler,
          [backing('code', 'b807000000')],
          [joined, alias],
          async (cpu) => {
            const run = async (compilations: number) => {
              const before = input();
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              exit(result, 'budget', 1n, 1n, changed(before, BASE + 5n, { 0: 7n }));
              equal(result.resources.compilations, compilations, 'source identity compilation');
              equal(
                result.resources.cacheHits,
                compilations === 0 ? 1 : 0,
                'source identity reuse',
              );
            };
            await run(1);
            for (let split = 1; split < 5; split++) {
              cpu.setMappings([
                alias,
                mapping(BASE + BigInt(split), 'code', 5 - split, RX, split),
                mapping(BASE, 'code', split, RX),
              ]);
              await run(0);
              cpu.setMappings([{ ...joined, permissions: { ...RX, read: false } }, alias]);
              await run(0);
            }
            cpu.writeMemory(0x4001n, Uint8Array.of(7));
            equal(cpu.inspectTranslations().length, 0, 'identical alias store retires source');
            await run(1);
          },
          { maxInstructions: 1 },
        );
      },
    },
    {
      name: 'host patches and map replacement invalidate only affected code owners',
      run: async () => {
        const bytes = new Uint8Array(32).fill(0xa5);
        bytes.set(hex('b801000000'));
        bytes[5] = 0x82;
        bytes.set(hex('b802000000'), 16);
        bytes[21] = 0x82;
        const maps = [mapping(BASE, 'code', 32, RX), mapping(0x4000n, 'code', 32, RW)];
        await using(compiler, [{ id: 'code', bytes }], maps, async (cpu) => {
          const run = async (pc: bigint, expected: bigint, compilations: number) => {
            const before = input({}, pc);
            cpu.setState(before);
            const result = await cpu.run({ budget: 1n });
            exit(result, 'budget', 1n, 1n, changed(before, pc + 5n, { 0: expected }));
            equal(result.resources.compilations, compilations, 'owner reuse');
          };
          await run(BASE, 1n, 1);
          await run(BASE + 16n, 2n, 1);
          equal(cpu.inspectTranslations().length, 2, 'two disjoint owners');
          cpu.writeMemory(0x4001n, Uint8Array.of(9));
          equal(cpu.inspectTranslations().length, 1, 'only affected owner removed');
          await run(BASE + 16n, 2n, 0);
          await run(BASE, 9n, 1);
          cpu.addBacking(backing('data', 'a5a5'));
          cpu.setMappings([...maps, mapping(0x8000n, 'data', 2, RW)]);
          cpu.setMappings([mapping(0x8000n, 'data', 2, RW), ...maps.slice().reverse()]);
          await run(BASE, 9n, 0);
          await run(BASE + 16n, 2n, 0);
          cpu.writeMemory(0x401fn, Uint8Array.of(0x90));
          await run(BASE, 9n, 0);
          await run(BASE + 16n, 2n, 0);
          cpu.writeMemory(0xffffffffffffffffn, new Uint8Array());
          await run(BASE, 9n, 0);
          throws(() => cpu.removeBacking('code'), 'mapped backing removal');
          throws(() => cpu.writeMemory(BASE, Uint8Array.of(0xbb)), 'host write into RX');
          equal(cpu.inspectTranslations().length, 2, 'rejected host mutations retain owners');
          const noExecute = [
            mapping(BASE, 'code', 32, { ...RX, execute: false }),
            mapping(0x4000n, 'code', 32, RW),
          ];
          cpu.setMappings(noExecute);
          equal(cpu.inspectTranslations().length, 0, 'execute revocation removes entries');
          const before = input();
          cpu.setState(before);
          exit(await cpu.run({ budget: 1n }), 'fetch-fault', 1n, 0n, before);
          cpu.setMappings(maps);
          await run(BASE, 9n, 1);
          cpu.setMappings([]);
          equal(cpu.inspectTranslations().length, 0, 'unmap removes entries');
          cpu.removeBacking('code');
          cpu.addBacking(backing('code', 'b807000000'));
          cpu.setMappings([mapping(BASE, 'code', 5, RX)]);
          await run(BASE, 7n, 1);
          memory(cpu, BASE, 'b807000000');
        });
      },
    },
    {
      name: 'guest writes retire other cached owners without leaving unaffected native code',
      run: async () => {
        await using(
          compiler,
          [backing('writer', 'c603bb4883e90175f7'), backing('target', 'b801000000')],
          [
            mapping(BASE, 'writer', 9, RX),
            mapping(0x2000n, 'target', 5, RX),
            mapping(0x4000n, 'target', 5, RW),
          ],
          async (cpu) => {
            const target = input({}, 0x2000n);
            cpu.setState(target);
            exit(
              await cpu.run({ budget: 1n }),
              'budget',
              1n,
              1n,
              changed(target, 0x2005n, { 0: 1n }),
            );
            const writer = input({ 3: 0x4000n, 1: 100n });
            cpu.setState(writer);
            const result = await cpu.run({ budget: 300n });
            exit(result, 'budget', 300n, 300n, changed(writer, BASE + 9n, { 1: 0n }, 0x46n));
            equal(result.resources.nativeEntries, 1, 'unaffected current owner stays native');
            equal(result.resources.dispatches, 0, 'other-owner writes need no dispatch');
            equal(result.resources.cachedArtifacts, 1, 'other stale owner pruned before result');
            cpu.setState(target);
            exit(
              await cpu.run({ budget: 1n }),
              'budget',
              1n,
              1n,
              changed(target, 0x2005n, { 3: 1n }),
            );
          },
        );
      },
    },
  ];
}
