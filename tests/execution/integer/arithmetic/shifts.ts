import { CODE, createFixture, type Scenario } from '../../../support/fixture.js';
import {
  byte,
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
import { doubleShift, shift, type Shift } from './oracle.js';

const operations: { kind: Shift; selector: number }[] = [
  { kind: 'ROL', selector: 0 },
  { kind: 'ROR', selector: 1 },
  { kind: 'RCL', selector: 2 },
  { kind: 'RCR', selector: 3 },
  { kind: 'SHL', selector: 4 },
  { kind: 'SHR', selector: 5 },
  { kind: 'SAR', selector: 7 },
];

export function shiftScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createFixture(core);
  return [
    {
      name: 'shift and rotate count boundaries distinguish masking ring reduction carry and defined flag subsets',
      run: async () => {
        for (const { kind, selector } of operations)
          for (const width of [8, 16, 32, 64]) {
            const code = prefix(width) + (width === 8 ? 'd2' : 'd3') + modrm(selector, 0);
            await using(
              code,
              async (cpu) => {
                for (const raw of Array.from({ length: 256 }, (_, index) => index))
                  for (const flags of [2n, 0x8d7n])
                    for (const value of [
                      0n,
                      2n ** BigInt(width - 1) + 1n,
                      2n ** BigInt(width) - 1n,
                    ]) {
                      const old = seed(value, width);
                      const answer = shift(kind, old, width, raw, flags);
                      await runPacket(cpu, {
                        code,
                        registers: { 0: old, 1: 0x8877665544332200n + BigInt(raw) },
                        flags,
                        writes: { 0: written(old, answer.result, width) },
                        outputFlags: answer.flags,
                        flagMask: answer.mask,
                      });
                    }
              },
              setup,
            );
          }
      },
    },
    {
      name: 'all group-two count forms cover every bank width high-byte and REX alias with incoming CL',
      run: async () => {
        for (const { kind, selector } of operations)
          for (const width of [8, 16, 32, 64])
            for (let bank = 0; bank < 16; bank++)
              for (const form of ['one', 'cl', 'immediate']) {
                const old = seed(2n ** BigInt(width - 1) + 1n, width, 0x8877665544332210n);
                const before = input(CODE, { [bank]: old });
                const raw =
                  form === 'cl' ? Number(before.registers[1]! & 255n) : form === 'one' ? 1 : 255;
                const code =
                  prefix(width, 0, bank) +
                  (form === 'one'
                    ? width === 8
                      ? 'd0'
                      : 'd1'
                    : form === 'cl'
                      ? width === 8
                        ? 'd2'
                        : 'd3'
                      : width === 8
                        ? 'c0'
                        : 'c1') +
                  modrm(selector, bank) +
                  (form === 'immediate' ? 'ff' : '');
                const answer = shift(kind, old, width, raw, before.flags);
                await one(using, {
                  code,
                  registers: { [bank]: old },
                  writes: { [bank]: written(old, answer.result, width) },
                  outputFlags: answer.flags,
                  flagMask: answer.mask,
                });
              }
        for (const { kind, selector } of operations)
          for (let bank = 0; bank < 4; bank++) {
            const old = 0x1122334455668109n;
            const raw = bank === 1 ? 9 : 1;
            const answer = shift(kind, 0x81n, 8, raw, 0x8d7n);
            await one(using, {
              code: 'd2' + modrm(selector, bank + 4),
              registers: { [bank]: old },
              writes: { [bank]: written(old, answer.result, 8, true) },
              outputFlags: answer.flags,
              flagMask: answer.mask,
            });
          }
        for (const { kind, selector } of operations)
          for (const width of [8, 64]) {
            const code = '664f' + (width === 8 ? 'c0' : 'c1') + modrm(selector, 12) + '01';
            const old = input().registers[12]!;
            const answer = shift(kind, old, width, 1, 0x8d7n);
            await one(using, {
              code,
              writes: { 12: written(old, answer.result, width) },
              outputFlags: answer.flags,
              flagMask: answer.mask,
            });
          }
      },
    },
    {
      name: 'shift memory operations write only their selected width for all counts and use full incoming RCX addresses',
      run: async () => {
        for (const { kind, selector } of operations)
          for (const width of [8, 16, 32, 64])
            for (const raw of [0, 1, width, width + 1, 255]) {
              const value = 2n ** BigInt(width - 1) + 1n;
              const answer = shift(kind, value, width, raw, 0x8d7n);
              const ram = patch(RAM, 16, value, width / 8);
              for (const form of ['one', 'cl', 'immediate']) {
                if (form === 'one' && raw !== 1) continue;
                const code =
                  prefix(width) +
                  (form === 'one'
                    ? width === 8
                      ? 'd0'
                      : 'd1'
                    : form === 'cl'
                      ? width === 8
                        ? 'd2'
                        : 'd3'
                      : width === 8
                        ? 'c0'
                        : 'c1') +
                  modrm(selector, 3, 0) +
                  (form === 'immediate' ? byte(raw) : '');
                await one(using, {
                  code,
                  registers: { 1: BigInt(raw) },
                  ram,
                  ramAfter: patch(ram, 16, answer.result, width / 8),
                  outputFlags: answer.flags,
                  flagMask: answer.mask,
                });
              }
            }
        for (const { kind, selector } of operations) {
          const address = 0x100004001n;
          const value = 0x8001n;
          const answer = shift(kind, value, 16, 1, 0x8d7n);
          await one(using, {
            code: '66d3' + modrm(selector, 1, 0),
            registers: { 1: address },
            ramBase: address,
            ram: '0180',
            ramAfter:
              Number(answer.result & 255n)
                .toString(16)
                .padStart(2, '0') +
              Number(answer.result / 256n)
                .toString(16)
                .padStart(2, '0'),
            outputFlags: answer.flags,
            flagMask: answer.mask,
          });
        }
        await one(using, {
          code: '66c1250000000000',
          ramBase: 0x1008n,
          ram: '0180',
        });
      },
    },
    {
      name: 'double shifts capture source destination and CL at zero one width and undefined word counts',
      run: async () => {
        for (const right of [false, true])
          for (const width of [16, 32, 64]) {
            const code = prefix(width, 2, 0) + (right ? '0fad' : '0fa5') + modrm(2, 0);
            await using(
              code,
              async (cpu) => {
                for (const count of Array.from({ length: 256 }, (_, index) => index))
                  for (const flags of [2n, 0x8d7n]) {
                    const old = 0x8877665580008001n;
                    const source = 0x12345678abcdef01n;
                    const answer = doubleShift(right, old, source, width, count, flags);
                    const undefinedWord = width === 16 && count % 32 > 16;
                    await runPacket(cpu, {
                      code,
                      registers: { 0: old, 1: BigInt(count), 2: source },
                      flags,
                      writes: { 0: written(old, answer.result, width) },
                      outputFlags: answer.flags,
                      flagMask: answer.mask,
                      ...(undefinedWord ? { undefinedWord: 0 } : {}),
                    });
                  }
              },
              setup,
            );
            for (let bank = 0; bank < 16; bank++)
              for (const immediate of [false, true]) {
                const source = (bank + 7) % 16;
                const code =
                  prefix(width, source, bank) +
                  (right ? (immediate ? '0fac' : '0fad') : immediate ? '0fa4' : '0fa5') +
                  modrm(source, bank) +
                  (immediate ? '01' : '');
                const before = input(CODE, {
                  [bank]: 0xfedcba9876543210n,
                  [source]: 0x8877665544332211n,
                });
                const count = immediate ? 1 : Number(before.registers[1]! & 255n);
                const answer = doubleShift(
                  right,
                  before.registers[bank]!,
                  before.registers[source]!,
                  width,
                  count,
                  before.flags,
                );
                await one(using, {
                  code,
                  registers: {
                    [bank]: before.registers[bank]!,
                    [source]: before.registers[source]!,
                  },
                  writes: { [bank]: written(before.registers[bank]!, answer.result, width) },
                  outputFlags: answer.flags,
                  flagMask: answer.mask,
                  ...(width === 16 && count % 32 > 16 ? { undefinedWord: bank } : {}),
                });
              }
            for (const immediate of [false, true])
              for (const count of [0, 1, width]) {
                const code =
                  prefix(width, 1) +
                  (right ? (immediate ? '0fac' : '0fad') : immediate ? '0fa4' : '0fa5') +
                  '0b' +
                  (immediate ? byte(count) : '');
                const value = 2n ** BigInt(width - 1) + 1n;
                const source = 0x8877665544332200n + BigInt(count);
                const answer = doubleShift(right, value, source, width, count, 0x8d7n);
                const ram = patch(RAM, 16, value, width / 8);
                await one(using, {
                  code,
                  registers: { 1: source },
                  ram,
                  ramAfter: patch(ram, 16, answer.result, width / 8),
                  outputFlags: answer.flags,
                  flagMask: answer.mask,
                });
              }
            for (const count of [0, 1]) {
              const old = 0x8877665544332200n + BigInt(count);
              const code = prefix(width, 1, 1) + (right ? '0fad' : '0fa5') + 'c9';
              const answer = doubleShift(right, old, old, width, count, 0x8d7n);
              await one(using, {
                code,
                registers: { 1: old },
                writes: { 1: written(old, answer.result, width) },
                outputFlags: answer.flags,
                flagMask: answer.mask,
              });
            }
            const relativeCode = prefix(width) + (right ? '0fac' : '0fa4') + '050000000001';
            const value = 2n ** BigInt(width - 1) + 1n;
            const source = input().registers[0]!;
            const relativeAnswer = doubleShift(right, value, source, width, 1, 0x8d7n);
            const relativeRam = patch(RAM, 0, value, width / 8);
            await one(using, {
              code: relativeCode,
              ramBase: CODE + BigInt(relativeCode.length / 2),
              ram: relativeRam,
              ramAfter: patch(relativeRam, 0, relativeAnswer.result, width / 8),
              outputFlags: relativeAnswer.flags,
              flagMask: relativeAnswer.mask,
            });
          }
        for (const right of [false, true]) {
          const address = 0x100004001n;
          const value = 0x8001n;
          const answer = doubleShift(right, value, address, 16, 1, 0x8d7n);
          const ram = patch(RAM, 0, value, 2);
          await one(using, {
            code: right ? '660fad09' : '660fa509',
            registers: { 1: address },
            ramBase: address,
            ram,
            ramAfter: patch(ram, 0, answer.result, 2),
            outputFlags: answer.flags,
            flagMask: answer.mask,
          });
        }
      },
    },
  ];
}
