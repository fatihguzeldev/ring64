import { CODE, createFixture, type Scenario } from '../../../support/fixture.js';
import {
  byte,
  input,
  little,
  modrm,
  one,
  patch,
  prefix,
  RAM,
  seed,
  view,
  written,
} from './fixture.js';
import { bit, bitAddress, scan } from './oracle.js';

const bitOpcodes = ['a3', 'ab', 'b3', 'bb'];

export function bitScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createFixture(core);
  return [
    {
      name: 'classic bit register and immediate forms cover all banks widths indices aliases and read-only BT',
      run: async () => {
        for (let kind = 0; kind < 4; kind++)
          for (const width of [16, 32, 64])
            for (let bank = 0; bank < 16; bank++)
              for (const immediate of [false, true]) {
                const indexBank = (bank + 7) % 16;
                const before = input(CODE, {
                  [bank]: 0x8877665580008001n,
                  [indexBank]: 0xfedcba98ffffffffn,
                });
                const index = immediate ? 255n : before.registers[indexBank]!;
                const code =
                  prefix(width, immediate ? 0 : indexBank, bank) +
                  '0f' +
                  (immediate
                    ? 'ba' + modrm(kind + 4, bank) + 'ff'
                    : bitOpcodes[kind] + modrm(indexBank, bank));
                const answer = bit(
                  kind,
                  before.registers[bank]!,
                  width,
                  view(index, width),
                  before.flags,
                );
                await one(using, {
                  code,
                  registers: {
                    [bank]: before.registers[bank]!,
                    [indexBank]: before.registers[indexBank]!,
                  },
                  writes: kind
                    ? { [bank]: written(before.registers[bank]!, answer.result, width) }
                    : {},
                  outputFlags: answer.flags,
                  flagMask: answer.mask,
                });
                const aliasCode =
                  prefix(width, bank, bank) + '0f' + bitOpcodes[kind] + modrm(bank, bank);
                const alias = bit(
                  kind,
                  before.registers[bank]!,
                  width,
                  view(before.registers[bank]!, width),
                  before.flags,
                );
                await one(using, {
                  code: aliasCode,
                  registers: { [bank]: before.registers[bank]! },
                  writes: kind
                    ? { [bank]: written(before.registers[bank]!, alias.result, width) }
                    : {},
                  outputFlags: alias.flags,
                  flagMask: alias.mask,
                });
              }
        for (let kind = 0; kind < 4; kind++)
          for (const width of [16, 32, 64])
            for (const index of [0, width - 1, width, width + 1, 255]) {
              const before = input();
              const answer = bit(kind, before.registers[8]!, width, BigInt(index), before.flags);
              const code =
                (width === 16 ? '6645' : width === 64 ? '664f' : '45') +
                '0fba' +
                modrm(kind + 4, 8) +
                byte(index);
              await one(using, {
                code,
                writes: kind ? { 8: written(before.registers[8]!, answer.result, width) } : {},
                outputFlags: answer.flags,
                flagMask: answer.mask,
              });
            }
      },
    },
    {
      name: 'memory bit strings use signed floor indices full adjusted elements and local immediate indices',
      run: async () => {
        for (let kind = 0; kind < 4; kind++)
          for (const width of [16, 32, 64]) {
            for (const signed of [-1, -width, -width - 1, 0, width - 1, width, width + 1]) {
              const index = written(0x8877665500000000n, BigInt(signed), width);
              const address = bitAddress(0x4010n, index, width);
              const offset = Number(address - 0x4000n);
              const value = 2n ** BigInt(width - 1) + 1n;
              const answer = bit(kind, value, width, view(index, width), 0x8d7n);
              const ram = patch(RAM, offset, value, width / 8);
              await one(using, {
                code: prefix(width, 1) + '0f' + bitOpcodes[kind] + '0b',
                registers: { 1: index },
                ram,
                ramAfter: kind ? patch(ram, offset, answer.result, width / 8) : ram,
                outputFlags: answer.flags,
                flagMask: answer.mask,
              });
            }
            for (const index of [width, 255]) {
              const value = 2n ** BigInt(width - 1) + 1n;
              const answer = bit(kind, value, width, BigInt(index), 0x8d7n);
              const ram = patch(RAM, 16, value, width / 8);
              await one(using, {
                code: prefix(width) + '0fba' + modrm(kind + 4, 3, 0) + byte(index),
                ram,
                ramAfter: kind ? patch(ram, 16, answer.result, width / 8) : ram,
                outputFlags: answer.flags,
                flagMask: answer.mask,
              });
              await one(using, {
                code: prefix(width) + '0fba' + modrm(kind + 4, 3, 0) + byte(index),
                ramBase: 0x4010n,
                ram: little(value, width / 8),
                ramAfter: little(answer.result, width / 8),
                outputFlags: answer.flags,
                flagMask: answer.mask,
              });
            }
            for (const [base, index] of [
              [0x800000000000n, -1n],
              [0n, -1n],
              [0x100004000n, BigInt(width)],
            ]) {
              const address = bitAddress(base!, index!, width);
              const value = 2n ** BigInt(width - 1) + 1n;
              const answer = bit(kind, value, width, index!, 0x8d7n);
              await one(using, {
                code: prefix(width, 1) + '0f' + bitOpcodes[kind] + '0b',
                registers: { 1: BigInt.asUintN(64, index!), 3: base! },
                ramBase: address,
                ram: little(value, width / 8),
                ramAfter: little(answer.result, width / 8),
                outputFlags: answer.flags,
                flagMask: answer.mask,
              });
            }
          }
        await one(using, {
          code: '660fba2d0000000000',
          ramBase: 0x1009n,
          ram: '0000',
          ramAfter: '0100',
          outputFlags: 0x42n,
          flagMask: 0x43n,
        });
      },
    },
    {
      name: 'bit scans use Intel093 whole-source parity and preserve the complete zero destination across banks and widths',
      run: async () => {
        for (const reverse of [false, true])
          for (const width of [16, 32, 64])
            for (let bank = 0; bank < 16; bank++) {
              const source = (bank + 7) % 16;
              const code =
                prefix(width, bank, source) + (reverse ? '0fbd' : '0fbc') + modrm(bank, source);
              for (const value of [
                0n,
                0x100n,
                0x180n,
                2n ** BigInt(width - 1),
                2n ** BigInt(width - 1) + 1n,
              ]) {
                const old = 0xfedcba9876543210n;
                const sourceValue = seed(value, width, 0x8877665500000000n);
                const answer = scan(reverse, sourceValue, width);
                await one(using, {
                  code,
                  registers: { [bank]: old, [source]: sourceValue },
                  writes: value ? { [bank]: written(old, answer.result, width) } : {},
                  outputFlags: answer.flags,
                });
              }
              const aliasCode =
                prefix(width, bank, bank) + (reverse ? '0fbd' : '0fbc') + modrm(bank, bank);
              for (const value of [0n, 0x180n]) {
                const old = seed(value, width, 0xfedcba9800000000n);
                const answer = scan(reverse, old, width);
                await one(using, {
                  code: aliasCode,
                  registers: { [bank]: old },
                  writes: value ? { [bank]: written(old, answer.result, width) } : {},
                  outputFlags: answer.flags,
                });
              }
            }
      },
    },
    {
      name: 'scan memory reads the exact full source and BSWAP preserves flags and reverses only its selected bank width',
      run: async () => {
        for (const reverse of [false, true])
          for (const width of [16, 32, 64])
            for (const value of [0n, 0x100n, 0x180n, 2n ** BigInt(width - 1) + 1n]) {
              const code = prefix(width, 8) + (reverse ? '0fbd' : '0fbc') + '03';
              const old = input().registers[8]!;
              const answer = scan(reverse, value, width);
              await one(using, {
                code,
                ramBase: 0x4010n,
                ram: little(value, width / 8),
                writes: value ? { 8: written(old, answer.result, width) } : {},
                outputFlags: answer.flags,
              });
            }
        for (const width of [32, 64])
          for (let bank = 0; bank < 16; bank++)
            for (const ignored of [false, true]) {
              const code =
                (width === 64 && ignored ? '66' : '') +
                (ignored
                  ? byte(0x46 | (width === 64 ? 8 : 0) | (bank >= 8 ? 1 : 0))
                  : prefix(width, 0, bank)) +
                '0f' +
                byte(0xc8 + (bank % 8));
              const old = 0x0123456789abcdefn;
              const reversed = BigInt('0x' + little(old, width / 8));
              await one(using, { code, registers: { [bank]: old }, writes: { [bank]: reversed } });
            }
      },
    },
  ];
}
