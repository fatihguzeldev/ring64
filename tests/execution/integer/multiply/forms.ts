import { CODE, createFixture, type Scenario } from '../../../support/fixture.js';
import { seed } from '../arithmetic/fixture.js';
import {
  dividend,
  input,
  little,
  modrm,
  one,
  paired,
  prefix,
  runPacket,
  setup,
  view,
  written,
} from './fixture.js';
import { divide, multiply, unsigned } from './oracle.js';

export function multiplyFormScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createFixture(core);
  return [
    {
      name: 'one-operand signed and unsigned products cover every source bank width and implicit-result alias',
      run: async () => {
        for (const isSigned of [false, true])
          for (const width of [8, 16, 32, 64])
            for (let bank = 0; bank < 16; bank++) {
              const code =
                prefix(width, 0, bank) +
                (width === 8 ? 'f6' : 'f7') +
                modrm(isSigned ? 5 : 4, bank);
              await using(
                code,
                async (cpu) => {
                  const max = 2n ** BigInt(width) - 1n,
                    sign = (max + 1n) / 2n;
                  for (const flags of [2n, 0x8d7n])
                    for (const [a, b] of [
                      [0n, max],
                      [1n, max],
                      [max, 2n],
                      [sign, max],
                      [sign - 1n, 2n],
                      [max, max],
                    ]) {
                      const registers = { 0: seed(a!, width), [bank]: seed(b!, width) };
                      const before = input(CODE, registers, flags);
                      const answer = multiply(
                        before.registers[0]!,
                        before.registers[bank]!,
                        width,
                        isSigned,
                      );
                      await runPacket(cpu, {
                        code,
                        registers,
                        flags,
                        writes: paired(before, width, answer),
                        outputFlags: answer.flags,
                      });
                    }
                },
                setup,
              );
            }
        for (const isSigned of [false, true])
          for (let high = 0; high < 4; high++) {
            const code = 'f6' + modrm(isSigned ? 5 : 4, high + 4);
            const before = input(CODE, { 0: 0x112233445566fe80n, [high]: 0x887766554433fd81n });
            const answer = multiply(
              before.registers[0]!,
              view(before.registers[high]!, 8, true),
              8,
              isSigned,
            );
            await one(using, {
              code,
              registers: { 0: before.registers[0]!, [high]: before.registers[high]! },
              writes: paired(before, 8, answer),
              outputFlags: answer.flags,
            });
          }
        for (const isSigned of [false, true])
          for (const width of [8, 64]) {
            const code = '664f' + (width === 8 ? 'f6' : 'f7') + modrm(isSigned ? 5 : 4, 8);
            const before = input(CODE, { 0: 0xffffffffffffffffn, 8: 2n });
            const answer = multiply(before.registers[0]!, before.registers[8]!, width, isSigned);
            await one(using, {
              code,
              registers: { 0: before.registers[0]!, 8: 2n },
              writes: paired(before, width, answer),
              outputFlags: answer.flags,
            });
          }
      },
    },
    {
      name: 'two and three operand IMUL forms cover every bank signed immediates and captured source aliases',
      run: async () => {
        for (const width of [16, 32, 64])
          for (let bank = 0; bank < 16; bank++)
            for (const kind of ['two', '69', '6b']) {
              const source = (bank + 7) % 16;
              const immediateWidth = kind === '6b' ? 1 : Math.min(width, 32) / 8;
              const immediates =
                kind === 'two'
                  ? [0n]
                  : kind === '6b'
                    ? [-128n, -1n, 0n, 127n]
                    : [
                        -(2n ** BigInt(immediateWidth * 8 - 1)),
                        -1n,
                        0n,
                        2n ** BigInt(immediateWidth * 8 - 1) - 1n,
                      ];
              for (const immediate of immediates) {
                const code =
                  prefix(width, bank, source) +
                  (kind === 'two' ? '0faf' : kind) +
                  modrm(bank, source) +
                  (kind === 'two' ? '' : little(immediate, immediateWidth));
                await using(
                  code,
                  async (cpu) => {
                    for (const value of [
                      0n,
                      1n,
                      -1n,
                      2n ** BigInt(width - 1),
                      2n ** BigInt(width - 1) - 1n,
                    ]) {
                      const registers = {
                        [bank]: 0xfedcba9876543210n,
                        [source]: seed(value, width),
                      };
                      const before = input(CODE, registers);
                      const answer = multiply(
                        kind === 'two' ? before.registers[bank]! : before.registers[source]!,
                        kind === 'two' ? before.registers[source]! : immediate,
                        width,
                        true,
                      );
                      await runPacket(cpu, {
                        code,
                        registers,
                        writes: { [bank]: written(before.registers[bank]!, answer.low, width) },
                        outputFlags: answer.flags,
                      });
                    }
                  },
                  setup,
                );
              }
              const code =
                prefix(width, bank, bank) +
                (kind === 'two' ? '0faf' : kind) +
                modrm(bank, bank) +
                (kind === 'two' ? '' : little(-1n, immediateWidth));
              const before = input(CODE, { [bank]: seed(-1n, width) });
              const answer = multiply(
                before.registers[bank]!,
                kind === 'two' ? before.registers[bank]! : -1n,
                width,
                true,
              );
              await one(using, {
                code,
                registers: { [bank]: before.registers[bank]! },
                writes: { [bank]: written(before.registers[bank]!, answer.low, width) },
                outputFlags: answer.flags,
              });
            }
      },
    },
    {
      name: 'DIV and IDIV cover all source banks paired views full dividends and exact quotient range transitions',
      run: async () => {
        for (const isSigned of [false, true])
          for (const width of [8, 16, 32, 64])
            for (let bank = 0; bank < 16; bank++) {
              const code =
                prefix(width, 0, bank) +
                (width === 8 ? 'f6' : 'f7') +
                modrm(isSigned ? 7 : 6, bank);
              await using(
                code,
                async (cpu) => {
                  const max = 2n ** BigInt(width) - 1n,
                    sign = (max + 1n) / 2n;
                  const cases = [
                    [0n, 0n, 0n],
                    [0n, 0n, 1n],
                    [max, 0n, 2n],
                    [0n, 1n, 2n],
                    [max, max - 1n, max],
                    [0n, 2n, 2n],
                    [max, max, max],
                    [sign, max, max],
                    [sign, 0n, max],
                    [max - 6n, max, 3n],
                    [7n, 0n, max - 2n],
                    [0n, sign, max],
                    [max, max, sign],
                  ];
                  for (const flags of [2n, 0x8d7n])
                    for (const [low, high, divisor] of cases) {
                      const registers: Record<number, bigint> = {
                        0: seed(width === 8 ? low! + high! * 256n : low!, width === 8 ? 16 : width),
                        2: seed(high!, width),
                      };
                      registers[bank] = written(
                        registers[bank] ?? input().registers[bank]!,
                        divisor!,
                        width,
                      );
                      const before = input(CODE, registers, flags);
                      const answer = divide(
                        dividend(before, width),
                        before.registers[bank]!,
                        width,
                        isSigned,
                      );
                      await runPacket(cpu, {
                        code,
                        registers,
                        flags,
                        writes: answer ? paired(before, width, answer) : {},
                        divideError: !answer,
                        flagMask: 2n,
                      });
                    }
                },
                setup,
              );
            }
        for (const isSigned of [false, true])
          for (let high = 0; high < 4; high++)
            for (const divisor of [0n, 1n, -1n, 127n, 128n]) {
              const code = 'f6' + modrm(isSigned ? 7 : 6, high + 4);
              const registers = {
                0: 0x112233445566fff9n,
                [high]: written(input().registers[high]!, divisor, 8, true),
              };
              const before = input(CODE, registers);
              const answer = divide(
                dividend(before, 8),
                view(before.registers[high]!, 8, true),
                8,
                isSigned,
              );
              await one(using, {
                code,
                registers,
                writes: answer ? paired(before, 8, answer) : {},
                divideError: !answer,
                flagMask: 2n,
              });
            }
        for (const isSigned of [false, true])
          for (const width of [8, 64]) {
            const code = '664f' + (width === 8 ? 'f6' : 'f7') + modrm(isSigned ? 7 : 6, 8);
            const registers = { 0: 0x1122334455660007n, 2: 0n, 8: 2n };
            const before = input(CODE, registers);
            const answer = divide(dividend(before, width), 2n, width, isSigned);
            await one(using, {
              code,
              registers,
              writes: answer ? paired(before, width, answer) : {},
              divideError: !answer,
              flagMask: 2n,
            });
          }
      },
    },
    {
      name: 'multiply and divide sources use exact read widths high addresses readonly code and complete RIP-relative lengths',
      run: async () => {
        for (const width of [8, 16, 32, 64])
          for (const selector of [4, 5, 6, 7]) {
            const code = prefix(width) + (width === 8 ? 'f6' : 'f7') + modrm(selector, 3, 0);
            for (const value of [0n, 2n, unsigned(-1n, width)]) {
              const registers = {
                0: seed(7n, width === 8 ? 16 : width),
                2: seed(0n, width),
                3: 0x100004010n,
              };
              const before = input(CODE, registers);
              const product =
                selector < 6
                  ? multiply(before.registers[0]!, value, width, selector === 5)
                  : undefined;
              const answer =
                product ?? divide(dividend(before, width), value, width, selector === 7);
              await one(using, {
                code,
                registers,
                ramBase: 0x100004010n,
                ram: little(value, width / 8),
                writes: answer ? paired(before, width, answer) : {},
                outputFlags: product?.flags ?? 2n,
                divideError: !answer,
                flagMask: selector < 6 ? 0x803n : 2n,
              });
            }
            const readonly = code + '00'.repeat(8);
            const value = BigInt(
              '0x' +
                readonly
                  .slice(0, width / 4)
                  .match(/../g)!
                  .reverse()
                  .join(''),
            );
            const before = input(CODE, { 0: 0n, 2: 0n, 3: CODE });
            const product = selector < 6 ? multiply(0n, value, width, selector === 5) : undefined;
            const answer = product ?? divide(0n, value, width, selector === 7);
            await one(using, {
              code: readonly,
              nextPc: CODE + BigInt(code.length / 2),
              registers: { 0: 0n, 2: 0n, 3: CODE },
              writes: answer ? paired(before, width, answer) : {},
              outputFlags: product?.flags ?? 2n,
              divideError: !answer,
              flagMask: selector < 6 ? 0x803n : 2n,
            });
          }
        for (const width of [16, 32, 64])
          for (const kind of ['two', '69', '6b']) {
            const immediateWidth = kind === '6b' ? 1 : Math.min(width, 32) / 8;
            const suffix = kind === 'two' ? '' : little(-1n, immediateWidth);
            const code = prefix(width) + (kind === 'two' ? '0faf' : kind) + '0500000000' + suffix;
            const before = input();
            const value = 2n ** BigInt(width - 1);
            const answer = multiply(
              kind === 'two' ? before.registers[0]! : value,
              kind === 'two' ? value : -1n,
              width,
              true,
            );
            await one(using, {
              code,
              ramBase: CODE + BigInt(code.length / 2),
              ram: little(value, width / 8),
              writes: { 0: written(before.registers[0]!, answer.low, width) },
              outputFlags: answer.flags,
            });
            const aliasCode = prefix(width, 3) + (kind === 'two' ? '0faf' : kind) + '1b' + suffix;
            const alias = input(CODE, { 3: 0x100004010n });
            const aliasAnswer = multiply(
              kind === 'two' ? alias.registers[3]! : value,
              kind === 'two' ? value : -1n,
              width,
              true,
            );
            await one(using, {
              code: aliasCode,
              registers: { 3: alias.registers[3]! },
              ramBase: 0x100004010n,
              ram: little(value, width / 8),
              writes: { 3: written(alias.registers[3]!, aliasAnswer.low, width) },
              outputFlags: aliasAnswer.flags,
            });
          }
      },
    },
  ];
}
