import {
  CODE,
  changed,
  createFixture,
  equal,
  exit,
  fault,
  hex,
  memory,
  type Scenario,
} from '../../../support/fixture.js';
import {
  completed,
  dividend,
  input,
  little,
  noFault,
  paired,
  patch,
  RAM,
  setup,
  written,
} from './fixture.js';
import { divide } from './oracle.js';

export function multiplyRestartScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createFixture(core);
  return [
    {
      name: 'divide-error repeats stay resumable and repaired register or memory divisors never replay an AF-setting prefix',
      run: async () => {
        for (const isSigned of [false, true])
          for (const inMemory of [false, true])
            for (const overflow of [false, true]) {
              const code =
                '80030148f7' + (inMemory ? (isSigned ? '3e' : '36') : isSigned ? 'f9' : 'f1');
              const registers = {
                0: overflow ? (isSigned ? 0x8000000000000000n : 0n) : 7n,
                1: overflow ? 1n : 0n,
                2: overflow && !isSigned ? 1n : 0n,
                6: 0x4018n,
              };
              const ram = patch(patch(RAM, 16, 0xfn, 1), 24, registers[1], 8);
              const after = patch(ram, 16, 0x10n, 1);
              await using(
                code,
                async (cpu) => {
                  const before = input(CODE, registers);
                  const atFault = changed(before, 0x1003n, {}, 0x12n);
                  cpu.setState(before);
                  const failed = await cpu.run({ budget: 3n });
                  exit(failed, 'divide-error', 3n, 1n, atFault);
                  noFault(failed);
                  memory(cpu, setup.ramBase, after);
                  const repeated = await cpu.run({ budget: 2n });
                  exit(repeated, 'divide-error', 2n, 0n, atFault);
                  noFault(repeated);
                  equal(repeated.resources.compilations, 0, 'unchanged error reuses its entry');
                  equal(
                    cpu.readState().rip,
                    0x1003n,
                    'controlled error leaves the CPU inspectable',
                  );
                  const repaired = changed(atFault, atFault.rip, inMemory ? {} : { 1: 3n });
                  if (inMemory) cpu.writeMemory(0x4018n, hex(little(3n, 8)));
                  else cpu.setState(repaired);
                  const answer = divide(dividend(repaired, 64), 3n, 64, isSigned)!;
                  const resumed = await cpu.run({ budget: 1n });
                  completed(
                    resumed,
                    changed(repaired, 0x1006n, paired(repaired, 64, answer), 2n),
                    2n,
                  );
                  equal(resumed.resources.compilations, 0, 'repair uses the retained divide');
                  memory(cpu, setup.ramBase, inMemory ? patch(after, 24, 3n, 8) : after);
                  for (const stop of [false, true]) {
                    cpu.writeMemory(setup.ramBase, hex(ram));
                    cpu.setState(before);
                    const gated = await cpu.run(
                      stop ? { budget: 3n, stop: 0x1003n } : { budget: 1n },
                    );
                    exit(gated, stop ? 'stop' : 'budget', stop ? 3n : 1n, 1n, atFault);
                    noFault(gated);
                    equal(gated.resources.compilations, 0, 'reached gate reuses the prefix');
                    memory(cpu, setup.ramBase, after);
                  }
                  memory(cpu, CODE, code);
                },
                { ...setup, ram },
              );
            }
      },
    },
    {
      name: 'observed undefined multiply and divide flags survive preserving suffixes and errors without stale fault metadata',
      run: async () => {
        for (const producer of ['48f7e1', '48f7f1']) {
          const code = producer + '4889c0f6d34f9f48f7f1488b06ffe0f70c8dc048f7';
          await using(
            code,
            async (cpu) => {
              const before = input(CODE, { 0: 7n, 1: 3n, 2: 0n });
              cpu.setState(before);
              const produced = await cpu.run({ budget: 1n });
              completed(
                produced,
                changed(
                  before,
                  0x1003n,
                  producer === '48f7e1' ? { 0: 21n, 2: 0n } : { 0: 2n, 2: 1n },
                  2n,
                ),
                producer === '48f7e1' ? 0x803n : 2n,
              );
              const next = changed(produced.state, 0x1003n, { 1: 0n });
              cpu.setState(next);
              const atFault = changed(next, 0x100an, {
                0: written(next.registers[0]!, (next.flags & 0xd5n) | 2n, 8, true),
                3: written(next.registers[3]!, 0xefn, 8),
              });
              const preserved = await cpu.run({ budget: 4n });
              exit(preserved, 'divide-error', 4n, 3n, atFault);
              noFault(preserved);
              equal(
                preserved.resources.compilations,
                0,
                'preserving suffix uses the producer artifact',
              );
              for (const stop of [false, true]) {
                const result = await cpu.run(
                  stop ? { budget: 1n, stop: atFault.rip } : { budget: 0n },
                );
                exit(result, stop ? 'stop' : 'budget', stop ? 1n : 0n, 0n, atFault);
                noFault(result);
                equal(
                  result.resources.nativeEntries,
                  0,
                  'reached gate precedes repeated arithmetic',
                );
              }
              const errorAgain = async () => {
                const current = input(
                  0x100an,
                  { 0: 0x1122334455667788n, 1: 0n, 2: 0x99aabbccddeeff11n },
                  0x8d7n,
                );
                cpu.setState(current);
                const result = await cpu.run({ budget: 1n });
                exit(result, 'divide-error', 1n, 0n, current);
                noFault(result);
                equal(
                  result.resources.compilations,
                  0,
                  'fault transitions retain the divide entry',
                );
              };
              for (const reason of [
                'data-fault',
                'target-fault',
                'unsupported',
                'invalid-encoding',
                'fetch-fault',
              ] as const) {
                const pc =
                  reason === 'data-fault'
                    ? 0x100dn
                    : reason === 'target-fault'
                      ? 0x1010n
                      : reason === 'unsupported'
                        ? 0x1012n
                        : reason === 'invalid-encoding'
                          ? 0x1014n
                          : 0x1016n;
                const current = input(pc, { 0: 0x800000000000n, 6: 0x7000n }, 0x12n);
                cpu.setState(current);
                const result = await cpu.run({ budget: 1n });
                exit(result, reason, 1n, 0n, current);
                if (reason === 'data-fault')
                  fault(result, {
                    instructionPc: pc,
                    address: 0x7000n,
                    width: 8,
                    access: 'read',
                    cause: 'unmapped',
                    failingAddress: 0x7000n,
                  });
                else if (reason === 'target-fault')
                  fault(result, {
                    instructionPc: pc,
                    address: current.registers[0]!,
                    width: 0,
                    access: 'execute',
                    cause: 'noncanonical',
                    failingAddress: current.registers[0]!,
                  });
                else if (reason === 'fetch-fault')
                  fault(result, {
                    instructionPc: pc,
                    address: 0x1018n,
                    width: 1,
                    access: 'execute',
                    cause: 'unmapped',
                    failingAddress: 0x1018n,
                  });
                else noFault(result);
                await errorAgain();
              }
              const repaired = input(0x100an, { 0: 7n, 1: 3n, 2: 0n });
              cpu.setState(repaired);
              const success = await cpu.run({ budget: 1n });
              completed(success, changed(repaired, 0x100dn, { 0: 2n, 2: 1n }, 2n), 2n);
              await errorAgain();
              memory(cpu, setup.ramBase, RAM);
              memory(cpu, CODE, code);
            },
            setup,
          );
        }
      },
    },
  ];
}
