import {
  CODE,
  changed,
  createFixture,
  equal,
  exit,
  fault,
  memory,
  type Scenario,
} from '../../../support/fixture.js';
import { completed, input, modrm, noFault, patch, prefix, RAM, setup } from './fixture.js';

export function arithmeticBoundaryScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createFixture(core);
  return [
    {
      name: 'integer arithmetic admitted tails and counts are fully fetched before operand access',
      run: async () => {
        const packets = [
          '66481500000080',
          '66481d00000080',
          '6681948b010000000080',
          '48839ca501000000ff',
          '6644fe848b01000000',
          '664cff8ca501000000',
          'f6948b01000000',
          '48f79ca501000000',
          '66d3a48b01000000',
          '48c1948b0100000041',
          'c09c8b0100000009',
          '660fa48c8b0100000010',
          '480fac8c8b0100000040',
          '480fa58c8b01000000',
          '660fad8c8b01000000',
          '660fa38c8b01000000',
          '480fab8c8b01000000',
          '0fb38c8b01000000',
          '660fbb8c8b01000000',
          '660fbaa48b0100000010',
          '480fbaac8b01000000ff',
          '0fbab48b0100000000',
          '0fbabc8b0100000000',
          '660fbc848b01000000',
          '480fbd848b01000000',
          '664f0fc8',
        ];
        for (const full of packets)
          for (let length = 1; length < full.length / 2; length++) {
            const code = full.slice(0, length * 2);
            await using(
              code,
              async (cpu) => {
                const before = input(CODE, { 3: 0x800000000000n, 13: 0x800000000000n }, 0x12n);
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                exit(result, 'fetch-fault', 1n, 0n, before);
                const missing = CODE + BigInt(length);
                fault(result, {
                  instructionPc: CODE,
                  address: missing,
                  width: 1,
                  access: 'execute',
                  cause: 'unmapped',
                  failingAddress: missing,
                });
                equal(result.resources.compilations, 0, 'decode failure precedes translation');
                memory(cpu, setup.ramBase, RAM);
                memory(cpu, CODE, code);
              },
              setup,
            );
          }
      },
    },
    {
      name: 'integer arithmetic excluded selectors stop before tails while shared FF prefix decoding requires its selector',
      run: async () => {
        const unsupported = [
          '66ff14',
          '660fc8',
          '66470fc8',
          'f30fbc',
          'f30fbd',
          'f001',
          'f201',
          'f301',
        ];
        for (const opcode of ['c0', 'c1', 'd0', 'd1', 'd2', 'd3'])
          unsupported.push('6644' + opcode + modrm(6, 4, 0));
        for (let selector = 2; selector < 8; selector++)
          unsupported.push('6644fe' + modrm(selector, 4, 0));
        for (let selector = 0; selector < 4; selector++)
          unsupported.push('66440fba' + modrm(selector, 4, 0));
        for (const opcode of ['f6', 'f7'])
          for (const selector of [1]) unsupported.push('6644' + opcode + modrm(selector, 4, 0));
        for (const code of ['66ff', ...unsupported])
          await using(
            code,
            async (cpu) => {
              const before = input(CODE, { 3: 0x800000000000n });
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              exit(result, code === '66ff' ? 'fetch-fault' : 'unsupported', 1n, 0n, before);
              if (code === '66ff')
                fault(result, {
                  instructionPc: CODE,
                  address: 0x1002n,
                  width: 1,
                  access: 'execute',
                  cause: 'unmapped',
                  failingAddress: 0x1002n,
                });
              else noFault(result);
              equal(
                result.resources.compilations,
                0,
                'excluded selector has no compiled or accessed suffix',
              );
              memory(cpu, setup.ramBase, RAM);
              memory(cpu, CODE, code);
            },
            setup,
          );
      },
    },
    {
      name: 'integer modifying memory forms preflight whole writes even for zero and identity operations',
      run: async () => {
        for (const width of [8, 16, 32, 64]) {
          const p = prefix(width);
          const codes = [
            p + (width === 8 ? '10' : '11') + '03',
            p + (width === 8 ? '18' : '19') + '03',
          ];
          for (const selector of [0, 1])
            codes.push(p + (width === 8 ? 'fe' : 'ff') + modrm(selector, 3, 0));
          for (const selector of [2, 3])
            codes.push(p + (width === 8 ? 'f6' : 'f7') + modrm(selector, 3, 0));
          for (const selector of [0, 1, 2, 3, 4, 5, 7])
            codes.push(p + (width === 8 ? 'c0' : 'c1') + modrm(selector, 3, 0) + '00');
          codes.push(
            p +
              (width === 8 ? 'c0' : 'c1') +
              modrm(2, 3, 0) +
              (width === 8 ? '09' : width === 16 ? '11' : '00'),
          );
          if (width !== 8) {
            codes.push(p + '0fa40300', p + '0fac0300');
            for (const selector of [5, 6, 7]) codes.push(p + '0fba' + modrm(selector, 3, 0) + '00');
          }
          for (const code of codes)
            for (const [address, cause] of [
              [CODE, 'permission'],
              [0x7000n, 'unmapped'],
              [0x800000000000n, 'noncanonical'],
            ] as const)
              await using(
                code,
                async (cpu) => {
                  const before = input(CODE, { 0: 0n, 1: 0n, 3: address }, 0x12n);
                  cpu.setState(before);
                  const zero = await cpu.run({ budget: 0n });
                  exit(zero, 'budget', 0n, 0n, before);
                  noFault(zero);
                  const stopped = await cpu.run({ budget: 1n, stop: CODE });
                  exit(stopped, 'stop', 1n, 0n, before);
                  noFault(stopped);
                  const result = await cpu.run({ budget: 1n });
                  exit(result, 'data-fault', 1n, 0n, before);
                  fault(result, {
                    instructionPc: CODE,
                    address,
                    width: width / 8,
                    access: 'write',
                    cause,
                    failingAddress: address,
                  });
                  memory(cpu, setup.ramBase, RAM);
                  memory(cpu, CODE, code);
                },
                setup,
              );
        }
      },
    },
    {
      name: 'integer zero-count writes and read-only bit and scan sources validate entire boundary spans',
      run: async () => {
        for (const width of [16, 32, 64])
          for (const operation of ['shift', 'double', 'bit', 'scan']) {
            const code =
              prefix(width) +
              (operation === 'shift'
                ? 'c12300'
                : operation === 'double'
                  ? '0fa40300'
                  : operation === 'bit'
                    ? '0fa30b'
                    : '0fbc03');
            await using(
              code,
              async (cpu) => {
                const before = input(CODE, { 3: 0x4010n, 1: 0n });
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                exit(result, 'data-fault', 1n, 0n, before);
                fault(result, {
                  instructionPc: CODE,
                  address: 0x4010n,
                  width: width / 8,
                  access: operation === 'bit' || operation === 'scan' ? 'read' : 'write',
                  cause: 'unmapped',
                  failingAddress: 0x4011n,
                });
                memory(cpu, 0x4010n, '00');
                memory(cpu, CODE, code);
              },
              { ramBase: 0x4010n, ram: '00' },
            );
          }
        await using(
          '66d323',
          async (cpu) => {
            const before = input(CODE, { 3: CODE - 1n, 1: 0n });
            cpu.setState(before);
            const result = await cpu.run({ budget: 1n });
            exit(result, 'data-fault', 1n, 0n, before);
            fault(result, {
              instructionPc: CODE,
              address: CODE - 1n,
              width: 2,
              access: 'write',
              cause: 'permission',
              failingAddress: CODE,
            });
            memory(cpu, CODE - 1n, 'a5');
            memory(cpu, CODE, '66d323');
          },
          { ramBase: CODE - 1n, ram: 'a5' },
        );
        for (const width of [16, 32, 64])
          for (const operation of ['shift', 'bit', 'scan']) {
            const code =
              prefix(width) +
              (operation === 'shift' ? 'c12300' : operation === 'bit' ? '0fba2300' : '0fbc03');
            await using(
              code,
              async (cpu) => {
                const address = 0xffffffffffffffffn;
                const before = input(CODE, { 3: address, 1: 0n });
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                exit(result, 'data-fault', 1n, 0n, before);
                fault(result, {
                  instructionPc: CODE,
                  address,
                  width: width / 8,
                  access: operation === 'shift' ? 'write' : 'read',
                  cause: 'address-range',
                  failingAddress: 1n << 64n,
                });
                memory(cpu, setup.ramBase, RAM);
                memory(cpu, CODE, code);
              },
              setup,
            );
          }
      },
    },
    {
      name: 'undefined word double-shift results still require complete writes and constrain every surrounding byte',
      run: async () => {
        for (const right of [false, true])
          for (const immediate of [false, true])
            for (const count of [17, 31]) {
              const code =
                '66' +
                (right ? (immediate ? '0fac' : '0fad') : immediate ? '0fa4' : '0fa5') +
                '0b' +
                (immediate ? count.toString(16).padStart(2, '0') : '');
              await using(
                code,
                async (cpu) => {
                  const before = input(CODE, { 1: 0x8877665544332200n + BigInt(count) });
                  cpu.setState(before);
                  const result = await cpu.run({ budget: 1n });
                  completed(result, changed(before, CODE + BigInt(code.length / 2), {}, 2n), 2n);
                  const value = cpu.readMemory(0x4010n, 2);
                  const word = BigInt(value[0]!) + BigInt(value[1]!) * 256n;
                  memory(cpu, setup.ramBase, patch(RAM, 16, word, 2));
                  memory(cpu, CODE, code);
                },
                setup,
              );
              for (const [address, cause] of [
                [CODE, 'permission'],
                [0x7000n, 'unmapped'],
              ] as const)
                await using(
                  code,
                  async (cpu) => {
                    const before = input(CODE, { 1: BigInt(count), 3: address });
                    cpu.setState(before);
                    const result = await cpu.run({ budget: 1n });
                    exit(result, 'data-fault', 1n, 0n, before);
                    fault(result, {
                      instructionPc: CODE,
                      address,
                      width: 2,
                      access: 'write',
                      cause,
                      failingAddress: address,
                    });
                    memory(cpu, setup.ramBase, RAM);
                    memory(cpu, CODE, code);
                  },
                  setup,
                );
            }
      },
    },
    {
      name: 'bit-string diagnostics report the adjusted element including canonical transitions and address aliases',
      run: async () => {
        for (const width of [16, 32, 64])
          for (const modifying of [false, true]) {
            const code = prefix(width, 1) + (modifying ? '0fab' : '0fa3') + '0b';
            for (const [base, index, address, cause] of [
              [0x4010n, -1n, 0x4010n - BigInt(width / 8), 'unmapped'],
              [
                0x7ffffffffff8n,
                BigInt(width),
                0x7ffffffffff8n + BigInt(width / 8),
                width === 64 ? 'noncanonical' : 'unmapped',
              ],
            ] as const)
              await using(
                code,
                async (cpu) => {
                  const before = input(CODE, { 3: base, 1: BigInt.asUintN(64, index) });
                  cpu.setState(before);
                  const result = await cpu.run({ budget: 1n });
                  exit(result, 'data-fault', 1n, 0n, before);
                  fault(result, {
                    instructionPc: CODE,
                    address,
                    width: width / 8,
                    access: modifying ? 'write' : 'read',
                    cause,
                    failingAddress: address,
                  });
                  memory(cpu, 0x5000n, 'a5');
                  memory(cpu, CODE, code);
                },
                { ramBase: 0x5000n, ram: 'a5' },
              );
            const aliasCode = prefix(width, 3) + (modifying ? '0fab' : '0fa3') + '1b';
            const address =
              0x4010n + (BigInt.asIntN(width, 0x4010n) / BigInt(width)) * BigInt(width / 8);
            await using(
              aliasCode,
              async (cpu) => {
                const before = input();
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                exit(result, 'data-fault', 1n, 0n, before);
                fault(result, {
                  instructionPc: CODE,
                  address,
                  width: width / 8,
                  access: modifying ? 'write' : 'read',
                  cause: 'unmapped',
                  failingAddress: address,
                });
                memory(cpu, setup.ramBase, RAM);
                memory(cpu, CODE, aliasCode);
              },
              setup,
            );
          }
      },
    },
  ];
}
