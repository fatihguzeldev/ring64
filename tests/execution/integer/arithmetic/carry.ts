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
  runPacket,
  setup,
  seed,
  written,
} from './fixture.js';
import { carry } from './oracle.js';

export function carryScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createFixture(core);
  return [
    {
      name: 'ADC and SBB register directions cover every bank width incoming carry and overlapping source',
      run: async () => {
        for (const subtract of [false, true])
          for (const width of [8, 16, 32, 64])
            for (let bank = 0; bank < 16; bank++)
              for (const reverse of [false, true]) {
                const source = (bank + 7) % 16;
                const opcode = (subtract ? 0x18 : 0x10) + (width === 8 ? 0 : 1) + (reverse ? 2 : 0);
                const code =
                  prefix(width, reverse ? bank : source, reverse ? source : bank) +
                  byte(opcode) +
                  modrm(reverse ? bank : source, reverse ? source : bank);
                await using(
                  code,
                  async (cpu) => {
                    for (const c of [0n, 1n])
                      for (const [a, b] of [
                        [0n, 2n ** BigInt(width) - 1n],
                        [2n ** BigInt(width - 1) - 1n, 0n],
                        [2n ** BigInt(width - 1), 15n],
                      ]) {
                        const before = input(
                          CODE,
                          { [bank]: 0xaabbccddffffffffn, [source]: 0x8877665500000000n },
                          0x8d6n | c,
                        );
                        const registers = {
                          [bank]: seed(a!, width, before.registers[bank]!),
                          [source]: seed(b!, width, before.registers[source]!),
                        };
                        const answer = carry(a!, b!, width, c, subtract);
                        await runPacket(cpu, {
                          code,
                          registers,
                          flags: before.flags,
                          writes: { [bank]: written(registers[bank]!, answer.result, width) },
                          outputFlags: answer.flags,
                        });
                      }
                  },
                  setup,
                );
                const alias = prefix(width, bank, bank) + byte(opcode) + modrm(bank, bank);
                const before = input(CODE, { [bank]: 0x88776655ffffffffn });
                const answer = carry(
                  before.registers[bank]!,
                  before.registers[bank]!,
                  width,
                  1n,
                  subtract,
                );
                await one(using, {
                  code: alias,
                  registers: { [bank]: before.registers[bank]! },
                  writes: { [bank]: written(before.registers[bank]!, answer.result, width) },
                  outputFlags: answer.flags,
                });
              }
      },
    },
    {
      name: 'ADC and SBB all immediate accumulator and memory forms retain signed immediates and full guards',
      run: async () => {
        for (const subtract of [false, true])
          for (const width of [8, 16, 32, 64])
            for (const cf of [0n, 1n]) {
              const a = 2n ** BigInt(width - 1);
              const max = 2n ** BigInt(width) - 1n;
              const flags = 0x8d6n | cf;
              const ram = patch(RAM, 16, a, width / 8);
              const memoryFirst =
                prefix(width, 1) + byte((subtract ? 0x18 : 0x10) + (width === 8 ? 0 : 1)) + '0b';
              const first = carry(a, max, width, cf, subtract);
              await one(using, {
                code: memoryFirst,
                registers: { 1: max },
                flags,
                ram,
                ramAfter: patch(ram, 16, first.result, width / 8),
                outputFlags: first.flags,
              });
              const registerFirst =
                prefix(width) + byte((subtract ? 0x1a : 0x12) + (width === 8 ? 0 : 1)) + '03';
              const before = input(CODE, {}, flags);
              const second = carry(before.registers[0]!, a, width, cf, subtract);
              await one(using, {
                code: registerFirst,
                flags,
                ram,
                writes: { 0: written(before.registers[0]!, second.result, width) },
                outputFlags: second.flags,
              });
              const immediateBytes = width === 64 ? 4 : width / 8;
              const immediate = little(max, immediateBytes);
              const accumulator =
                prefix(width) + byte((subtract ? 0x1c : 0x14) + (width === 8 ? 0 : 1)) + immediate;
              const acc = carry(before.registers[0]!, max, width, cf, subtract);
              await one(using, {
                code: accumulator,
                flags,
                writes: { 0: written(before.registers[0]!, acc.result, width) },
                outputFlags: acc.flags,
              });
              for (const memory of [false, true])
                for (const short of width === 8 ? [false] : [false, true]) {
                  const bank = 8;
                  const opcode = width === 8 ? '80' : short ? '83' : '81';
                  const code =
                    prefix(width, 0, memory ? 3 : bank) +
                    opcode +
                    modrm(subtract ? 3 : 2, memory ? 3 : bank, memory ? 0 : 3) +
                    (short ? 'ff' : immediate);
                  const old = input().registers[bank]!;
                  const answer = carry(memory ? a : old, max, width, cf, subtract);
                  await one(using, {
                    code,
                    flags,
                    ram,
                    ...(memory
                      ? { ramAfter: patch(ram, 16, answer.result, width / 8) }
                      : { writes: { [bank]: written(old, answer.result, width) } }),
                    outputFlags: answer.flags,
                  });
                }
            }
      },
    },
    {
      name: 'carry arithmetic prefix distinctions preserve high-byte aliases and ignore unused REX fields',
      run: async () => {
        for (const subtract of [false, true]) {
          for (const reverse of [false, true]) {
            const code =
              byte((subtract ? 0x18 : 0x10) + (reverse ? 2 : 0)) + (reverse ? 'e5' : 'ec');
            const before = input(CODE, { 0: 0x1122334455667f88n, 1: 0xaabbccddeeff0080n });
            const answer = carry(0x7fn, 0n, 8, 1n, subtract);
            await one(using, {
              code,
              registers: { 0: before.registers[0]!, 1: before.registers[1]! },
              writes: { 0: written(before.registers[0]!, answer.result, 8, true) },
              outputFlags: answer.flags,
            });
          }
          for (const code of subtract ? ['66481cc0', '664818c0'] : ['664814c0', '664810c0']) {
            const immediate = code.endsWith('1cc0') || code.endsWith('14c0');
            const before = input();
            const answer = carry(
              before.registers[0]!,
              immediate ? 0xc0n : before.registers[0]!,
              8,
              1n,
              subtract,
            );
            await one(using, {
              code,
              writes: { 0: written(before.registers[0]!, answer.result, 8) },
              outputFlags: answer.flags,
            });
          }
          const before = input();
          const code = '664f83' + modrm(subtract ? 3 : 2, 8) + 'ff';
          const answer = carry(before.registers[8]!, -1n, 64, 1n, subtract);
          await one(using, { code, writes: { 8: answer.result }, outputFlags: answer.flags });
        }
      },
    },
  ];
}
