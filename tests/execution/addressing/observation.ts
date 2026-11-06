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
  changed,
  exit,
  fault,
} from '../../support/fixture.js';
import { input, noFault, defaultRam } from './fixture.js';

export function addressingObservationScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createFixture(core);
  return [
    {
      name: 'cached middle addressing entries ignore unexecuted predecessor facts',
      run: async () => {
        await using(
          'bb00400000488d348b488d1500000000',
          async (cpu) => {
            const first = input();
            cpu.setState(first);
            const compiled = await cpu.run({ budget: 1n });
            exit(compiled, 'budget', 1n, 1n, changed(first, CODE + 5n, { 3: 0x4000n }));
            noFault(compiled);
            equal(cpu.inspectTranslations()[0]!.entries.length, 3, 'all composed entries admitted');
            const fresh = input(CODE + 5n, { 3: 0x100005000n, 1: 2n }, 0x42n);
            cpu.setState(fresh);
            const reused = await cpu.run({ budget: 2n });
            exit(
              reused,
              'budget',
              2n,
              2n,
              changed(fresh, CODE + 16n, { 6: 0x100005008n, 2: 0x1010n }),
            );
            equal(reused.resources.compilations, 0, 'middle addressing suffix reuses its owner');
            noFault(reused);
            memory(cpu, 0x4000n, '00');
          },
          defaultRam,
        );
      },
    },
    {
      name: 'SIB reuse observes changed base index RAM flags and stop boundaries',
      run: async () => {
        await using('488b048b4889148b', async (cpu) => {
          const first = input(CODE, { 3: DATA - 8n, 1: 2n, 2: 0x0102030405060708n });
          cpu.setState(first);
          const compiled = await cpu.run({ budget: 3n, stop: CODE + 8n });
          exit(compiled, 'stop', 3n, 2n, changed(first, CODE + 8n, { 0: 0x1122334455667788n }));
          noFault(compiled);
          memory(cpu, DATA - 8n, '10111213141516170807060504030201f0f1f2f3f4f5f6f7');
          cpu.writeMemory(DATA + 8n, hex('1112131415161718'));
          const fresh = input(CODE, { 3: DATA + 4n, 1: 1n, 2: 0x2122232425262728n }, 0x42n);
          cpu.setState(fresh);
          const loaded = changed(fresh, CODE + 4n, { 0: 0x1817161514131211n });
          const cut = await cpu.run({ budget: 2n, stop: CODE + 4n });
          exit(cut, 'stop', 2n, 1n, loaded);
          noFault(cut);
          equal(cut.resources.compilations, 0, 'new base and index reuse compiled SIB code');
          memory(cpu, DATA - 8n, '101112131415161708070605040302011112131415161718');
          const stopped = await cpu.run({ budget: 1n, stop: CODE + 4n });
          exit(stopped, 'stop', 1n, 0n, loaded);
          noFault(stopped);
          const stored = await cpu.run({ budget: 1n });
          exit(stored, 'budget', 1n, 1n, changed(loaded, CODE + 8n));
          noFault(stored);
          equal(stored.resources.compilations, 0, 'resumed SIB store uses its installed entry');
          memory(cpu, DATA - 8n, '101112131415161708070605040302012827262524232221');
        });
      },
    },
    {
      name: 'addressing entry indexes survive overlapping owner replacement and eviction',
      run: async () => {
        await using(
          'b801000000488d348bebfa488d1500000000',
          async (cpu) => {
            const first = input();
            cpu.setState(first);
            const a = await cpu.run({ budget: 1n });
            exit(a, 'budget', 1n, 1n, changed(first, CODE + 5n, { 0: 1n }));
            noFault(a);
            const backward = input(CODE + 9n);
            cpu.setState(backward);
            const b = await cpu.run({ budget: 1n });
            exit(b, 'budget', 1n, 1n, changed(backward, CODE + 5n));
            noFault(b);
            equal(b.resources.compilations, 1, 'backward entry installs a different shared index');
            check(
              cpu
                .inspectTranslations()
                .some((unit) => unit.entries[0] === CODE + 5n && unit.entries[1] === CODE + 9n),
              'new owner metadata orders the shared entry first',
            );
            const shared = input(CODE + 5n, { 3: 0x100005000n, 1: 2n }, 0x42n);
            const useShared = async () => {
              cpu.setState(shared);
              const run = await cpu.run({ budget: 1n });
              exit(run, 'budget', 1n, 1n, changed(shared, CODE + 9n, { 6: 0x100005008n }));
              noFault(run);
              equal(
                run.resources.compilations,
                0,
                'shared addressing entry keeps its current owner',
              );
            };
            await useShared();
            const third = input(CODE + 11n);
            cpu.setState(third);
            const c = await cpu.run({ budget: 1n });
            exit(c, 'budget', 1n, 1n, changed(third, CODE + 18n, { 2: 0x1012n }));
            noFault(c);
            check(
              !cpu.inspectTranslations().some((unit) => unit.entries.includes(CODE)),
              'older owner evicted',
            );
            await useShared();
            cpu.setState(first);
            const recompiled = await cpu.run({ budget: 1n });
            exit(recompiled, 'budget', 1n, 1n, changed(first, CODE + 5n, { 0: 1n }));
            noFault(recompiled);
            equal(recompiled.resources.compilations, 1, 'evicted addressing owner recompiles');
            await useShared();
            cpu.setState(backward);
            const retained = await cpu.run({ budget: 1n });
            exit(retained, 'budget', 1n, 1n, changed(backward, CODE + 5n));
            noFault(retained);
            equal(retained.resources.compilations, 0, 'overlapping owner retains its other entry');
            memory(cpu, 0x4000n, '00');
          },
          { ...defaultRam, limits: { maxInstructions: 2, maxCachedArtifacts: 2 } },
        );
      },
    },
    {
      name: 'addressing diagnostics win translation limits before operand checks',
      run: async () => {
        for (const item of [
          { tail: '488dc4', reason: 'invalid-encoding' },
          { tail: '488d04', reason: 'fetch-fault' },
          { tail: '488b048b', reason: 'resource-limit' },
        ]) {
          await using(
            'b801000000' + item.tail,
            async (cpu) => {
              const before = input(CODE, { 3: 0x800000000000n, 1: 0n });
              cpu.setState(before);
              const after = changed(before, CODE + 5n, { 0: 1n }),
                result = await cpu.run({ budget: 3n });
              exit(result, item.reason, 3n, 1n, after);
              if (item.reason === 'fetch-fault')
                fault(result, {
                  instructionPc: CODE + 5n,
                  address: CODE + 8n,
                  width: 1,
                  access: 'execute',
                  cause: 'unmapped',
                  failingAddress: CODE + 8n,
                });
              else noFault(result);
              memory(cpu, 0x4000n, '00');
              if (item.reason === 'resource-limit') {
                const resumed = await cpu.run({ budget: 1n });
                exit(resumed, 'data-fault', 1n, 0n, after);
                fault(resumed, {
                  instructionPc: CODE + 5n,
                  address: 0x800000000000n,
                  width: 8,
                  access: 'read',
                  cause: 'noncanonical',
                  failingAddress: 0x800000000000n,
                });
                memory(cpu, 0x4000n, '00');
              }
            },
            { ...defaultRam, limits: { maxInstructions: 1, maxTranslationsPerRun: 1 } },
          );
        }
      },
    },
    {
      name: 'addressing required-byte failures and invalid LEA never invent a SIB fetch',
      run: async () => {
        const prefixes = [
          '488b04',
          '488b444b',
          '488b844b',
          '488b844b01',
          '488b844b0102',
          '488b844b010203',
          '488b0425',
          '488b042501',
          '488b04250102',
          '488b0425010203',
          '488b05',
          '488b0501',
          '488b050102',
          '488b05010203',
        ];
        for (const prefix of prefixes)
          for (const code of [prefix, prefix.replace('8b', '8d')])
            await using(
              code,
              async (cpu) => {
                const before = input();
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                exit(result, 'fetch-fault', 1n, 0n, before);
                const missing = CODE + BigInt(code.length / 2);
                fault(result, {
                  instructionPc: CODE,
                  address: missing,
                  width: 1,
                  access: 'execute',
                  cause: 'unmapped',
                  failingAddress: missing,
                });
                memory(cpu, 0x4000n, '00');
              },
              defaultRam,
            );
        for (const code of ['488dc0', '488dc4'])
          await using(
            code,
            async (cpu) => {
              const before = input(0xfffffffffffffffdn);
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              exit(result, 'invalid-encoding', 1n, 0n, before);
              noFault(result);
              memory(cpu, 0x4000n, '00');
            },
            { ...defaultRam, codeBase: 0xfffffffffffffffdn },
          );
      },
    },
    {
      name: 'failed SIB stores report complete spans without changing any guard byte',
      run: async () => {
        for (const item of [
          {
            pointer: 0xfffffffffffffffcn,
            ramBase: 0xfffffffffffffffcn,
            ram: 'aabbccdd',
            cause: 'address-range',
            failing: 1n << 64n,
          },
          {
            pointer: 0x7ffffffffffcn,
            ramBase: 0x7ffffffffffcn,
            ram: 'aabbccdd',
            cause: 'noncanonical',
            failing: 0x800000000000n,
          },
          {
            pointer: 0x4000n,
            ramBase: 0x4000n,
            ram: 'aabbccdd',
            cause: 'unmapped',
            failing: 0x4004n,
          },
          {
            pointer: CODE - 2n,
            ramBase: CODE - 2n,
            ram: 'aabb',
            cause: 'permission',
            failing: CODE,
          },
        ] as const)
          await using(
            '488904cb',
            async (cpu) => {
              const before = input(CODE, { 3: item.pointer, 1: 0n, 0: 0x1122334455667788n });
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              exit(result, 'data-fault', 1n, 0n, before);
              fault(result, {
                instructionPc: CODE,
                address: item.pointer,
                width: 8,
                access: 'write',
                cause: item.cause,
                failingAddress: item.failing,
              });
              memory(cpu, item.ramBase, item.ram);
              memory(cpu, CODE, '488904cb');
            },
            { ramBase: item.ramBase, ram: item.ram },
          );
        await using(
          '488b4301',
          async (cpu) => {
            const before = input(CODE, { 3: 0x7fffffffffffn });
            cpu.setState(before);
            const result = await cpu.run({ budget: 1n });
            exit(result, 'data-fault', 1n, 0n, before);
            fault(result, {
              instructionPc: CODE,
              address: 0x800000000000n,
              width: 8,
              access: 'read',
              cause: 'noncanonical',
              failingAddress: 0x800000000000n,
            });
            memory(cpu, 0x4000n, '00');
          },
          defaultRam,
        );
      },
    },
    {
      name: 'repairing a SIB fault resumes without replaying an earlier completed store',
      run: async () => {
        await using('4889048b488b14ce', async (cpu) => {
          const before = input(CODE, { 3: DATA - 8n, 1: 2n, 0: 0xaabbccdd89abcdefn, 6: 0x6ff0n });
          cpu.setState(before);
          const after = changed(before, CODE + 4n),
            failed = await cpu.run({ budget: 5n });
          exit(failed, 'data-fault', 5n, 1n, after);
          fault(failed, {
            instructionPc: CODE + 4n,
            address: 0x7000n,
            width: 8,
            access: 'read',
            cause: 'unmapped',
            failingAddress: 0x7000n,
          });
          memory(cpu, DATA - 8n, '1011121314151617efcdab89ddccbbaaf0f1f2f3f4f5f6f7');
          cpu.writeMemory(DATA, hex('0807060504030201'));
          const repaired = changed(after, CODE + 4n, { 6: DATA - 16n });
          cpu.setState(repaired);
          const resumed = await cpu.run({ budget: 1n });
          exit(resumed, 'budget', 1n, 1n, changed(repaired, CODE + 8n, { 2: 0x0102030405060708n }));
          noFault(resumed);
          equal(resumed.resources.compilations, 0, 'faulting SIB entry was already admitted');
          memory(cpu, DATA - 8n, '10111213141516170807060504030201f0f1f2f3f4f5f6f7');
        });
      },
    },
    {
      name: 'new addressing boundaries preserve budget stop and discovery priorities',
      run: async () => {
        await using('488d048b488b148b4889348b', async (cpu) => {
          const before = input(CODE, { 3: DATA - 8n, 1: 2n, 6: 0x0102030405060708n });
          cpu.setState(before);
          const zero = await cpu.run({ budget: 0n, stop: CODE });
          exit(zero, 'budget', 0n, 0n, before);
          equal(zero.resources.compilations, 0, 'zero budget does not translate');
          noFault(zero);
          const stop = await cpu.run({ budget: 1n, stop: CODE });
          exit(stop, 'stop', 1n, 0n, before);
          equal(stop.resources.compilations, 0, 'entry stop does not translate');
          noFault(stop);
          const first = await cpu.run({ budget: 1n });
          const afterLea = changed(before, CODE + 4n, { 0: DATA });
          exit(first, 'budget', 1n, 1n, afterLea);
          noFault(first);
          memory(cpu, DATA - 8n, FRAME);
          const second = await cpu.run({ budget: 1n, stop: CODE + 8n });
          const afterLoad = changed(afterLea, CODE + 8n, { 2: 0x1122334455667788n });
          exit(second, 'budget', 1n, 1n, afterLoad);
          noFault(second);
          const stopped = await cpu.run({ budget: 1n, stop: CODE + 8n });
          exit(stopped, 'stop', 1n, 0n, afterLoad);
          noFault(stopped);
          memory(cpu, DATA - 8n, FRAME);
          const stored = await cpu.run({ budget: 1n });
          exit(stored, 'budget', 1n, 1n, changed(afterLoad, CODE + 12n));
          noFault(stored);
          equal(stored.resources.compilations, 0, 'budget-one resumes use the same unit');
          memory(cpu, DATA - 8n, '10111213141516170807060504030201f0f1f2f3f4f5f6f7');
        });
        await using(
          'ebfe488d04',
          async (cpu) => {
            const before = input();
            cpu.setState(before);
            const result = await cpu.run({ budget: 3n });
            exit(result, 'budget', 3n, 3n, before);
            noFault(result);
            memory(cpu, 0x4000n, '00');
          },
          defaultRam,
        );
        await using(
          'b801000000488d04',
          async (cpu) => {
            const before = input();
            cpu.setState(before);
            const after = changed(before, CODE + 5n, { 0: 1n });
            const stopped = await cpu.run({ budget: 2n, stop: CODE + 5n });
            exit(stopped, 'stop', 2n, 1n, after);
            noFault(stopped);
            const failed = await cpu.run({ budget: 1n });
            exit(failed, 'fetch-fault', 1n, 0n, after);
            fault(failed, {
              instructionPc: CODE + 5n,
              address: CODE + 8n,
              width: 1,
              access: 'execute',
              cause: 'unmapped',
              failingAddress: CODE + 8n,
            });
            memory(cpu, 0x4000n, '00');
          },
          defaultRam,
        );
      },
    },
  ];
}
