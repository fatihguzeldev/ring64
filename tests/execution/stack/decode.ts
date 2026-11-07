import { type Scenario, CODE, changed, equal, exit, fault, memory } from '../../support/fixture.js';
import { RAM, createStackFixture, input, noFault, stack } from './fixture.js';

export function decodeScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createStackFixture(core);
  return [
    {
      name: 'complete near-CALL bytes can end at u64 max but required bytes never wrap',
      run: async () => {
        await using(
          '4fe800000000',
          async (cpu) => {
            const before = input(0xfffffffffffffffan);
            cpu.setState(before);
            const result = await cpu.run({ budget: 1n });
            exit(result, 'budget', 1n, 1n, changed(before, 0n, { 4: 0x4018n }));
            noFault(result);
            memory(cpu, 0x4000n, stack(0n, 24));
            memory(cpu, before.rip, '4fe800000000');
          },
          { codeBase: 0xfffffffffffffffan },
        );
        await using(
          '4fe8000000',
          async (cpu) => {
            const before = input(0xfffffffffffffffbn, { 4: 0x7000n });
            cpu.setState(before);
            const result = await cpu.run({ budget: 1n });
            exit(result, 'fetch-fault', 1n, 0n, before);
            fault(result, {
              instructionPc: before.rip,
              address: before.rip,
              width: 6,
              access: 'execute',
              cause: 'address-range',
              failingAddress: 0x10000000000000000n,
            });
            memory(cpu, 0x4000n, RAM);
            memory(cpu, before.rip, '4fe8000000');
          },
          { codeBase: 0xfffffffffffffffbn },
        );
        for (const [code, targetFailure] of [
          ['e80b000000', true],
          ['e800000000', false],
        ] as const) {
          await using(
            code,
            async (cpu) => {
              const before = input(0x7ffffffffff0n, { 4: 0x7000n });
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              exit(result, targetFailure ? 'target-fault' : 'data-fault', 1n, 0n, before);
              fault(result, {
                instructionPc: before.rip,
                address: targetFailure ? 0x800000000000n : 0x6ff8n,
                width: targetFailure ? 0 : 8,
                access: targetFailure ? 'execute' : 'write',
                cause: targetFailure ? 'noncanonical' : 'unmapped',
                failingAddress: targetFailure ? 0x800000000000n : 0x6ff8n,
              });
              memory(cpu, 0x4000n, RAM);
              memory(cpu, before.rip, code);
            },
            { codeBase: 0x7ffffffffff0n },
          );
        }
      },
    },
    {
      name: 'new stack encodings fetch every required byte before operand checks and reject excluded forms',
      run: async () => {
        for (const instruction of ['6a80', '6800000080', 'e80b000000', 'c2ffff', 'ffd0', 'ffe4'])
          for (const prefix of ['', '4f']) {
            const complete = prefix + instruction;
            for (let bytes = 1; bytes < complete.length / 2; bytes++) {
              const code = complete.slice(0, bytes * 2);
              await using(code, async (cpu) => {
                const before = input(CODE, { 0: 0x800000000000n, 4: 0x7000n, 12: 0x800000000000n });
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                exit(result, 'fetch-fault', 1n, 0n, before);
                fault(result, {
                  instructionPc: CODE,
                  address: CODE + BigInt(bytes),
                  width: 1,
                  access: 'execute',
                  cause: 'unmapped',
                  failingAddress: CODE + BigInt(bytes),
                });
                memory(cpu, CODE, code);
                memory(cpu, 0x4000n, RAM);
              });
            }
          }
        for (const code of ['6650', '6758', '404050'])
          await using(code, async (cpu) => {
            const before = input(CODE, { 0: 0x1122334455667788n });
            cpu.setState(before);
            const popped = code === '6758';
            const pointer = popped ? 0x4028n : code === '6650' ? 0x401en : 0x4018n;
            const result = await cpu.run({ budget: 1n });
            exit(
              result,
              'budget',
              1n,
              1n,
              changed(before, CODE + BigInt(code.length / 2), {
                4: pointer,
                ...(popped ? { 0: 0xa5a5a5a5a5a5a5a5n } : {}),
              }),
            );
            noFault(result);
            if (!popped) memory(cpu, pointer, code === '6650' ? '8877' : '8877665544332211');
          });
        for (const code of [
          'ff10',
          'ff14',
          'ff15',
          'ff20',
          'ff24',
          'ff1c',
          'ff2c',
          'ffd8',
          'ffe8',
          'fff0',
          'fff8',
          '8f',
          '8fc0',
          'f050',
          'f2c3',
          'f3c3',
          '9a',
          'ca',
          'cb',
          'c8',
          'c9',
          '9c',
          '9d',
        ]) {
          await using(code, async (cpu) => {
            const before = input(CODE, { 0: 0x800000000000n, 4: 0x7000n });
            cpu.setState(before);
            const result = await cpu.run({ budget: 1n });
            exit(result, 'unsupported', 1n, 0n, before);
            noFault(result);
            equal(result.resources.compilations, 0, 'unsupported form does not compile');
            memory(cpu, CODE, code);
            memory(cpu, 0x4000n, RAM);
          });
        }
      },
    },
  ];
}
