import { createFixture, type Scenario } from '../../../support/fixture.js';
import {
  input,
  modrm,
  one,
  patch,
  prefix,
  RAM,
  runPacket,
  seed,
  setup,
  written,
} from './fixture.js';
import { unary, type Unary } from './oracle.js';

const operations: { kind: Unary; selector: number; group: 'count' | 'invert' }[] = [
  { kind: 'INC', selector: 0, group: 'count' },
  { kind: 'DEC', selector: 1, group: 'count' },
  { kind: 'NOT', selector: 2, group: 'invert' },
  { kind: 'NEG', selector: 3, group: 'invert' },
];

export function unaryScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createFixture(core);
  return [
    {
      name: 'integer unary forms define their own flags and preserve carry or full flags across every bank and width',
      run: async () => {
        for (const { kind, selector, group } of operations)
          for (const width of [8, 16, 32, 64])
            for (let bank = 0; bank < 16; bank++) {
              const code =
                prefix(width, 0, bank) +
                (group === 'count' ? (width === 8 ? 'fe' : 'ff') : width === 8 ? 'f6' : 'f7') +
                modrm(selector, bank);
              await using(
                code,
                async (cpu) => {
                  for (const flags of [2n, 0x8d7n])
                    for (const value of [
                      0n,
                      1n,
                      15n,
                      2n ** BigInt(width - 1) - 1n,
                      2n ** BigInt(width - 1),
                      2n ** BigInt(width) - 1n,
                    ]) {
                      const old = seed(value, width);
                      const answer = unary(kind, old, width, flags);
                      await runPacket(cpu, {
                        code,
                        registers: { [bank]: old },
                        flags,
                        writes: { [bank]: written(old, answer.result, width) },
                        outputFlags: answer.flags,
                      });
                    }
                },
                setup,
              );
            }
      },
    },
    {
      name: 'unary memory widths high-byte views and ignored prefix fields constrain exact writes',
      run: async () => {
        for (const { kind, selector, group } of operations) {
          for (const width of [8, 16, 32, 64]) {
            const code =
              prefix(width) +
              (group === 'count' ? (width === 8 ? 'fe' : 'ff') : width === 8 ? 'f6' : 'f7') +
              modrm(selector, 3, 0);
            for (const value of [0n, 2n ** BigInt(width - 1), 2n ** BigInt(width) - 1n]) {
              const answer = unary(kind, value, width, 0x8d7n);
              const ram = patch(RAM, 16, value, width / 8);
              await one(using, {
                code,
                ram,
                ramAfter: patch(ram, 16, answer.result, width / 8),
                outputFlags: answer.flags,
              });
            }
          }
          for (let high = 0; high < 4; high++) {
            const code = (group === 'count' ? 'fe' : 'f6') + modrm(selector, high + 4);
            const old = 0xfedcba987654ff10n;
            const answer = unary(kind, 0xffn, 8, 0x8d7n);
            await one(using, {
              code,
              registers: { [high]: old },
              writes: { [high]: written(old, answer.result, 8, true) },
              outputFlags: answer.flags,
            });
          }
          const byteCode = '664f' + (group === 'count' ? 'fe' : 'f6') + modrm(selector, 12);
          const old = input().registers[12]!;
          const byteAnswer = unary(kind, old, 8, 0x8d7n);
          await one(using, {
            code: byteCode,
            writes: { 12: written(old, byteAnswer.result, 8) },
            outputFlags: byteAnswer.flags,
          });
          const wideCode = '664f' + (group === 'count' ? 'ff' : 'f7') + modrm(selector, 8);
          const wide = unary(kind, input().registers[8]!, 64, 0x8d7n);
          await one(using, { code: wideCode, writes: { 8: wide.result }, outputFlags: wide.flags });
        }
      },
    },
    {
      name: 'carry controls and implicit AH transfers preserve exact incoming flag and bank bits with every ignored prefix',
      run: async () => {
        for (const decoration of ['', '66', '40', '4f', '664f'])
          for (const opcode of ['f8', 'f9', 'f5', '9f', '9e']) {
            const code = decoration + opcode;
            await using(
              code,
              async (cpu) => {
                for (let combination = 0; combination < 64; combination++) {
                  let flags = 2n;
                  for (const [index, bit] of [1n, 4n, 0x10n, 0x40n, 0x80n, 0x800n].entries())
                    if (combination & (1 << index)) flags |= bit;
                  const ah = BigInt((combination * 37 + 0x28) % 256);
                  const old = written(0xfedcba9876543210n, ah, 8, true);
                  const outputFlags =
                    opcode === 'f8'
                      ? flags & ~1n
                      : opcode === 'f9'
                        ? flags | 1n
                        : opcode === 'f5'
                          ? flags ^ 1n
                          : opcode === '9e'
                            ? (flags & ~0xd5n) | (ah & 0xd5n) | 2n
                            : flags;
                  await runPacket(cpu, {
                    code,
                    registers: { 0: old },
                    flags,
                    writes:
                      opcode === '9f' ? { 0: written(old, (flags & 0xd5n) | 2n, 8, true) } : {},
                    outputFlags,
                  });
                }
              },
              setup,
            );
          }
        await using(
          '4f9e',
          async (cpu) => {
            for (let ah = 0; ah < 256; ah++)
              for (const of of [0n, 0x800n]) {
                const old = written(0x1122334455667788n, BigInt(ah), 8, true);
                await runPacket(cpu, {
                  code: '4f9e',
                  registers: { 0: old },
                  flags: 0xd7n | of,
                  outputFlags: (BigInt(ah) & 0xd5n) | of | 2n,
                });
              }
          },
          setup,
        );
      },
    },
  ];
}
