import {
  CODE,
  createFixture,
  equal,
  exit,
  fault,
  memory,
  type Scenario,
} from '../../../support/fixture.js';
import { input, little, modrm, noFault, one, prefix, RAM, setup } from './fixture.js';

export function multiplyBoundaryScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createFixture(core);
  return [
    {
      name: 'multiply and divide fetch complete admitted address tails and immediates before arithmetic or source checks',
      run: async () => {
        const packets: string[] = [
          '676bc001',
          '2669c001000000',
          '6666f7e0',
          '4848f7e0',
          '4866f7e0',
        ];
        for (const width of [8, 16, 32, 64])
          for (const selector of [4, 5, 6, 7])
            packets.push(
              prefix(width) + (width === 8 ? 'f6' : 'f7') + modrm(selector, 4, 2) + '8b01000000',
            );
        for (const width of [16, 32, 64])
          for (const kind of ['0faf', '69', '6b'])
            packets.push(
              prefix(width, 8, 4) +
                kind +
                modrm(8, 4, 2) +
                '8b01000000' +
                (kind === '0faf' ? '' : little(-1n, kind === '6b' ? 1 : Math.min(width, 32) / 8)),
            );
        for (const full of packets)
          for (let length = 1; length < full.length / 2; length++) {
            const code = full.slice(0, length * 2);
            await using(
              code,
              async (cpu) => {
                const before = input(
                  CODE,
                  { 0: 0n, 1: 0n, 2: 0xffffffffffffffffn, 3: 0x800000000000n },
                  0x12n,
                );
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
                equal(result.resources.compilations, 0, 'required fetch precedes translation');
                memory(cpu, setup.ramBase, RAM);
                memory(cpu, CODE, code);
              },
              setup,
            );
          }
      },
    },
    {
      name: 'multiply and divide keep excluded prefixes and F6 F7 selector one access free',
      run: async () => {
        for (const code of ['f60c', 'f70c', '664ff60c', '664ff70c', 'f048f7f1', 'f3660faf'])
          await using(
            code,
            async (cpu) => {
              const before = input(CODE, { 1: 0n, 3: 0x800000000000n });
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              exit(
                result,
                code === 'f048f7f1' ? 'invalid-encoding' : 'unsupported',
                1n,
                0n,
                before,
              );
              noFault(result);
              equal(
                result.resources.compilations,
                0,
                'excluded selector or prefix is not translated',
              );
              memory(cpu, setup.ramBase, RAM);
              memory(cpu, CODE, code);
            },
            setup,
          );
      },
    },
    {
      name: 'readonly arithmetic source failures win over zero multiplication and provable quotient overflow without partial results',
      run: async () => {
        for (const width of [8, 16, 32, 64]) {
          const codes = [4, 5, 6, 7].map(
            (selector) => prefix(width) + (width === 8 ? 'f6' : 'f7') + modrm(selector, 3, 0),
          );
          if (width !== 8)
            codes.push(
              prefix(width, 3) + '0faf1b',
              prefix(width, 3) + '691b' + little(-1n, Math.min(width, 32) / 8),
              prefix(width, 3) + '6b1bff',
            );
          for (const code of codes)
            for (const [address, cause] of [
              [0x7000n, 'unmapped'],
              [0x800000000000n, 'noncanonical'],
            ] as const)
              await using(
                code,
                async (cpu) => {
                  const before = input(CODE, { 0: 0n, 2: 0xffffffffffffffffn, 3: address }, 0x8d7n);
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
                    access: 'read',
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
      name: 'multiply and divide require full source spans and preserve all banks across range canonical and split mapping failures',
      run: async () => {
        for (const width of [16, 32, 64])
          for (const selector of [4, 5, 6, 7]) {
            const code = prefix(width) + 'f7' + modrm(selector, 3, 0);
            for (const [address, cause, failingAddress, ramBase, ram] of [
              [
                0x4010n,
                'unmapped',
                0x4010n + BigInt(width / 8 - 1),
                0x4010n,
                '00'.repeat(width / 8 - 1),
              ],
              [0x7fffffffffffn, 'noncanonical', 0x800000000000n, 0x4000n, RAM],
              [0xffffffffffffffffn, 'address-range', 1n << 64n, 0x4000n, RAM],
            ] as const)
              await using(
                code,
                async (cpu) => {
                  const before = input(CODE, { 0: 0n, 2: 0xffffffffffffffffn, 3: address });
                  cpu.setState(before);
                  const result = await cpu.run({ budget: 1n });
                  exit(result, 'data-fault', 1n, 0n, before);
                  fault(result, {
                    instructionPc: CODE,
                    address,
                    width: width / 8,
                    access: 'read',
                    cause,
                    failingAddress,
                  });
                  memory(cpu, ramBase, ram);
                  memory(cpu, CODE, code);
                },
                { ramBase, ram },
              );
          }
        await one(using, {
          code: 'f623',
          registers: { 0: 3n, 3: 0xffffffffffffffffn },
          ramBase: 0xffffffffffffffffn,
          ram: '02',
          writes: { 0: 6n },
        });
        await one(using, {
          code: 'f633',
          registers: { 0: 7n, 3: 0xffffffffffffffffn },
          ramBase: 0xffffffffffffffffn,
          ram: '02',
          writes: { 0: 0x103n },
          flagMask: 2n,
        });
      },
    },
    {
      name: 'decode and resource admission precede an uncached divide error while budget and stop prevent admission',
      run: async () => {
        for (const [code, reason] of [
          ['48f7f1', 'resource-limit'],
          ['48f734', 'fetch-fault'],
          ['48f70c', 'unsupported'],
        ] as const)
          await using(
            code,
            async (cpu) => {
              const before = input(CODE, { 0: 7n, 1: 0n, 2: 0n });
              cpu.setState(before);
              const zero = await cpu.run({ budget: 0n });
              exit(zero, 'budget', 0n, 0n, before);
              noFault(zero);
              const stopped = await cpu.run({ budget: 1n, stop: CODE });
              exit(stopped, 'stop', 1n, 0n, before);
              noFault(stopped);
              const result = await cpu.run({ budget: 1n });
              exit(result, reason, 1n, 0n, before);
              equal(
                result.resources.compilations,
                reason === 'resource-limit' ? 1 : 0,
                'probe precedes bounded source admission',
              );
              if (reason === 'fetch-fault')
                fault(result, {
                  instructionPc: CODE,
                  address: 0x1003n,
                  width: 1,
                  access: 'execute',
                  cause: 'unmapped',
                  failingAddress: 0x1003n,
                });
              else noFault(result);
              memory(cpu, setup.ramBase, RAM);
              memory(cpu, CODE, code);
            },
            { ...setup, limits: { maxSourceBytes: 1 } },
          );
      },
    },
  ];
}
