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
import {
  arithmetic,
  byte,
  input,
  little,
  logicalExit,
  noFault,
  patch,
  prefix,
  RAM,
  setup,
  written,
} from './fixture.js';

export function dataObservationScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createFixture(core);
  return [
    {
      name: 'partial scalar writes and full-bank observations retain all live register values in one invocation',
      run: async () => {
        let code = '';
        const before = input();
        const registers = [...before.registers];
        for (let bank = 0; bank < 16; bank++) {
          code += prefix(8, 0, bank) + byte(0xb0 + (bank & 7)) + byte(0x80 + bank);
          registers[bank] = written(registers[bank]!, BigInt(0x80 + bank), 8);
          code += prefix(16, 0, bank) + byte(0xb8 + (bank & 7)) + little(BigInt(0x8000 + bank), 2);
          registers[bank] = written(registers[bank]!, BigInt(0x8000 + bank), 16);
        }
        for (let bank = 0; bank < 4; bank++) {
          code += byte(0xb4 + bank) + byte(0x70 + bank);
          registers[bank] = written(registers[bank]!, BigInt(0x70 + bank), 8, true);
        }
        code += '6689c10fb6f4480fbec40f94c46639c80f9cc0660f4cd1';
        registers[1] = written(registers[1]!, registers[0]!, 16);
        registers[6] = BigInt.asUintN(8, registers[0]! >> 8n);
        registers[0] = BigInt.asUintN(64, BigInt.asIntN(8, registers[4]!));
        registers[0] = written(registers[0]!, 1n, 8, true);
        const compared = arithmetic(registers[0]!, registers[1]!, 16, true);
        const less = BigInt.asIntN(16, registers[0]!) < BigInt.asIntN(16, registers[1]!);
        registers[0] = written(registers[0]!, less ? 1n : 0n, 8);
        if (less) registers[2] = written(registers[2]!, registers[1]!, 16);
        await using(
          code,
          async (cpu) => {
            cpu.setState(before);
            const result = await cpu.run({ budget: 43n });
            exit(result, 'budget', 43n, 43n, {
              registers,
              rip: CODE + BigInt(code.length / 2),
              flags: compared.flags,
            });
            noFault(result);
            equal(result.resources.nativeEntries, 1, 'live scalar views remain in one invocation');
            equal(result.resources.dispatches, 0, 'view changes require no host dispatch');
            memory(cpu, setup.ramBase, RAM);
            memory(cpu, CODE, code);
          },
          setup,
        );
      },
    },
    {
      name: 'concrete logical AF survives narrow moves conditions faults repair and direct cached entries',
      run: async () => {
        const code = '80e480b07f6689c10f98c2660f48d8480fbe06';
        await using(
          code,
          async (cpu) => {
            const before = input(CODE, { 0: 0x112233445566ff88n, 6: 0x7000n });
            cpu.setState(before);
            const produced = await cpu.run({ budget: 1n });
            logicalExit(produced, changed(before, 0x1003n, { 0: 0x1122334455668088n }, 0x82n));
            noFault(produced);
            const failed = await cpu.run({ budget: 6n });
            const atFault = changed(produced.state, 0x100fn, {
              0: 0x112233445566807fn,
              1: 0x112233440000807fn,
              2: 0x1122334400000001n,
              3: 0x807fn,
            });
            exit(failed, 'data-fault', 6n, 4n, atFault);
            fault(failed, {
              instructionPc: 0x100fn,
              address: 0x7000n,
              width: 1,
              access: 'read',
              cause: 'unmapped',
              failingAddress: 0x7000n,
            });
            equal(
              failed.resources.compilations,
              0,
              'preserving suffix reuses logical producer artifact',
            );
            const repaired = changed(atFault, atFault.rip, { 6: 0x4010n });
            cpu.setState(repaired);
            const resumed = await cpu.run({ budget: 1n });
            exit(resumed, 'budget', 1n, 1n, changed(repaired, 0x1013n, { 0: 0xffffffffffffffa5n }));
            noFault(resumed);
            equal(resumed.resources.compilations, 0, 'repair does not recompile or replay views');
            const fresh = input(0x100fn, { 6: 0x7000n }, 0x8d7n);
            cpu.setState(fresh);
            const imported = await cpu.run({ budget: 1n });
            exit(imported, 'data-fault', 1n, 0n, fresh);
            fault(imported, {
              instructionPc: 0x100fn,
              address: 0x7000n,
              width: 1,
              access: 'read',
              cause: 'unmapped',
              failingAddress: 0x7000n,
            });
            equal(imported.resources.compilations, 0, 'fresh AF=1 is an entry input');
            memory(cpu, setup.ramBase, RAM);
            memory(cpu, CODE, code);
          },
          setup,
        );
      },
    },
    {
      name: 'fault repair and stop boundaries never replay a non-idempotent byte update before false CMOV',
      run: async () => {
        const code = '8003010f4406';
        const original = patch(RAM, 16, 0n, 1);
        await using(
          code,
          async (cpu) => {
            const before = input(CODE, { 6: 0x7000n });
            cpu.setState(before);
            const failed = await cpu.run({ budget: 3n });
            const atFault = changed(before, 0x1003n, {}, 2n);
            exit(failed, 'data-fault', 3n, 1n, atFault);
            fault(failed, {
              instructionPc: 0x1003n,
              address: 0x7000n,
              width: 4,
              access: 'read',
              cause: 'unmapped',
              failingAddress: 0x7000n,
            });
            memory(cpu, setup.ramBase, patch(original, 16, 1n, 1));
            const repaired = changed(atFault, atFault.rip, { 6: 0x4014n });
            cpu.setState(repaired);
            const resumed = await cpu.run({ budget: 1n });
            exit(resumed, 'budget', 1n, 1n, changed(repaired, 0x1006n, { 0: 0x55667788n }));
            noFault(resumed);
            equal(resumed.resources.compilations, 0, 'repaired CMOV consumes retained entry');
            memory(cpu, setup.ramBase, patch(original, 16, 1n, 1));
            for (const gate of [
              { budget: 1n, stop: undefined, reason: 'budget' },
              { budget: 3n, stop: 0x1003n, reason: 'stop' },
            ]) {
              cpu.writeMemory(setup.ramBase, hex(original));
              cpu.setState(before);
              const result = await cpu.run(
                gate.stop === undefined
                  ? { budget: gate.budget }
                  : { budget: gate.budget, stop: gate.stop },
              );
              exit(result, gate.reason, gate.budget, 1n, atFault);
              noFault(result);
              equal(result.resources.compilations, 0, 'gate retains compiled scalar entries');
              memory(cpu, setup.ramBase, patch(original, 16, 1n, 1));
            }
            memory(cpu, CODE, code);
          },
          { ...setup, ram: original },
        );
      },
    },
    {
      name: 'middle scalar entries retain fresh full banks and their current owner through overlap eviction',
      run: async () => {
        const code = 'b480b07f66b90080ebf8';
        await using(
          code,
          async (cpu) => {
            const runAt = async (
              pc: bigint,
              next: bigint,
              writes: Record<number, bigint>,
              compilations: number,
            ) => {
              const before = input(pc, { 0: 0xfedcba9876543210n, 1: 0x8877665544332211n }, 0x12n);
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              exit(result, 'budget', 1n, 1n, changed(before, next, writes));
              noFault(result);
              equal(
                result.resources.compilations,
                compilations,
                'scalar entry owner compilation count',
              );
              memory(cpu, setup.ramBase, RAM);
              memory(cpu, CODE, code);
            };
            await runAt(0x1000n, 0x1002n, { 0: 0xfedcba9876548010n }, 1);
            await runAt(0x1008n, 0x1002n, {}, 1);
            check(
              cpu
                .inspectTranslations()
                .some((unit) => unit.entries[0] === 0x1002n && unit.entries[1] === 0x1008n),
              'backedge installs a different ordinal for shared scalar entry',
            );
            await runAt(0x1002n, 0x1004n, { 0: 0xfedcba987654327fn }, 0);
            await runAt(0x1004n, 0x1008n, { 1: 0x8877665544338000n }, 1);
            check(
              !cpu.inspectTranslations().some((unit) => unit.entries.includes(0x1000n)),
              'old scalar owner is evicted',
            );
            await runAt(0x1002n, 0x1004n, { 0: 0xfedcba987654327fn }, 0);
            await runAt(0x1000n, 0x1002n, { 0: 0xfedcba9876548010n }, 1);
            await runAt(0x1002n, 0x1004n, { 0: 0xfedcba987654327fn }, 0);
          },
          { ...setup, limits: { maxInstructions: 2, maxCachedArtifacts: 2 } },
        );
      },
    },
    {
      name: 'scalar resource frontiers resume faulting views without inheriting an executed predecessor',
      run: async () => {
        await using(
          'b480660f4403',
          async (cpu) => {
            const before = input(CODE, { 3: 0x7000n });
            cpu.setState(before);
            const frontier = await cpu.run({ budget: 3n });
            const after = changed(before, 0x1002n, { 0: 0x1122334455668088n });
            exit(frontier, 'resource-limit', 3n, 1n, after);
            noFault(frontier);
            const failed = await cpu.run({ budget: 1n });
            exit(failed, 'data-fault', 1n, 0n, after);
            fault(failed, {
              instructionPc: 0x1002n,
              address: 0x7000n,
              width: 2,
              access: 'read',
              cause: 'unmapped',
              failingAddress: 0x7000n,
            });
            const repaired = changed(after, after.rip, { 3: 0x4010n });
            cpu.setState(repaired);
            const resumed = await cpu.run({ budget: 1n });
            exit(resumed, 'budget', 1n, 1n, changed(repaired, 0x1006n, { 0: 0x112233445566a5a5n }));
            noFault(resumed);
            equal(
              resumed.resources.compilations,
              0,
              'faulting word view retains its frontier artifact',
            );
            memory(cpu, setup.ramBase, RAM);
          },
          { ...setup, limits: { maxInstructions: 1, maxTranslationsPerRun: 1 } },
        );
      },
    },
  ];
}
