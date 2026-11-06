import {
  CODE,
  changed,
  createFixture,
  equal,
  exit,
  memory,
  type Scenario,
} from '../../../support/fixture.js';
import {
  arithmetic,
  byte,
  input,
  little,
  logicalExit,
  logicalFlags,
  modrm,
  noFault,
  one,
  patch,
  prefix,
  RAM,
  setup,
  view,
  written,
} from './fixture.js';

const operations = [
  { name: 'add', base: 0x00, group: 0, logical: false, readOnly: false },
  { name: 'or', base: 0x08, group: 1, logical: true, readOnly: false },
  { name: 'and', base: 0x20, group: 4, logical: true, readOnly: false },
  { name: 'sub', base: 0x28, group: 5, logical: false, readOnly: false },
  { name: 'xor', base: 0x30, group: 6, logical: true, readOnly: false },
  { name: 'cmp', base: 0x38, group: 7, logical: false, readOnly: true },
  { name: 'test', base: 0x84, group: 0, logical: true, readOnly: true },
] as const;
type Operation = (typeof operations)[number];

function calculate(operation: Operation, a: bigint, b: bigint, width: number) {
  if (!operation.logical) return arithmetic(a, b, width, operation.name !== 'add');
  const result =
    operation.name === 'and' || operation.name === 'test'
      ? a & b
      : operation.name === 'or'
        ? a | b
        : a ^ b;
  return { result: view(result, width), flags: logicalFlags(result, width) };
}

export function arithmeticScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createFixture(core);
  return [
    {
      name: 'all scalar ALU opcodes directions widths and register banks preserve complete operand views',
      run: async () => {
        for (const operation of operations)
          for (const width of [8, 16, 32, 64])
            for (let bank = 0; bank < 16; bank++) {
              const src = (bank + 5) % 16;
              const before = input();
              const a = view(before.registers[bank]!, width);
              const b = view(before.registers[src]!, width);
              const expected = calculate(operation, a, b, width);
              await one(using, {
                code:
                  prefix(width, src, bank) +
                  byte(operation.base + (width === 8 ? 0 : 1)) +
                  modrm(src, bank),
                writes: operation.readOnly
                  ? {}
                  : { [bank]: written(before.registers[bank]!, expected.result, width) },
                outputFlags: expected.flags,
                logical: operation.logical,
              });
              const self = calculate(operation, a, a, width);
              await one(using, {
                code:
                  prefix(width, bank, bank) +
                  byte(operation.base + (width === 8 ? 0 : 1)) +
                  modrm(bank, bank),
                writes: operation.readOnly
                  ? {}
                  : { [bank]: written(before.registers[bank]!, self.result, width) },
                outputFlags: self.flags,
                logical: operation.logical,
              });
              if (operation.name !== 'test')
                await one(using, {
                  code:
                    prefix(width, bank, src) +
                    byte(operation.base + (width === 8 ? 2 : 3)) +
                    modrm(bank, src),
                  writes: operation.readOnly
                    ? {}
                    : { [bank]: written(before.registers[bank]!, expected.result, width) },
                  outputFlags: expected.flags,
                  logical: operation.logical,
                });

              const immediate = width === 64 ? -0x80000000n : 1n << BigInt(width - 1);
              const immediateResult = calculate(operation, a, view(immediate, width), width);
              await one(using, {
                code:
                  prefix(width, 0, bank) +
                  (operation.name === 'test'
                    ? width === 8
                      ? 'f6'
                      : 'f7'
                    : width === 8
                      ? '80'
                      : '81') +
                  modrm(operation.group, bank) +
                  little(immediate, Math.min(width / 8, 4)),
                writes: operation.readOnly
                  ? {}
                  : { [bank]: written(before.registers[bank]!, immediateResult.result, width) },
                outputFlags: immediateResult.flags,
                logical: operation.logical,
              });
              if (operation.name !== 'test' && width !== 8) {
                const result = calculate(operation, a, view(-1n, width), width);
                await one(using, {
                  code: prefix(width, 0, bank) + '83' + modrm(operation.group, bank) + 'ff',
                  writes: operation.readOnly
                    ? {}
                    : { [bank]: written(before.registers[bank]!, result.result, width) },
                  outputFlags: result.flags,
                  logical: operation.logical,
                });
              }
            }
      },
    },
    {
      name: 'scalar memory and accumulator ALU forms use operand order exact spans and ignored selectors',
      run: async () => {
        for (const operation of operations)
          for (const width of [8, 16, 32, 64]) {
            const operand = view(0x88776655800080ffn, width);
            const ram = patch(RAM, 16, operand, width / 8);
            for (let bank = 0; bank < 16; bank++) {
              const before = input();
              const register = view(before.registers[bank]!, width);
              const result = calculate(operation, operand, register, width);
              await one(using, {
                code:
                  prefix(width, bank, 3) +
                  byte(operation.base + (width === 8 ? 0 : 1)) +
                  modrm(bank, 3, 0),
                ram,
                ramAfter: operation.readOnly ? ram : patch(ram, 16, result.result, width / 8),
                outputFlags: result.flags,
                logical: operation.logical,
              });
              if (operation.name !== 'test') {
                const read = calculate(operation, register, operand, width);
                await one(using, {
                  code:
                    prefix(width, bank, 3) +
                    byte(operation.base + (width === 8 ? 2 : 3)) +
                    modrm(bank, 3, 0),
                  ram,
                  writes: operation.readOnly
                    ? {}
                    : { [bank]: written(before.registers[bank]!, read.result, width) },
                  outputFlags: read.flags,
                  logical: operation.logical,
                });
              }
            }
            const immediate = width === 64 ? -0x80000000n : 1n << BigInt(width - 1);
            const accumulator = calculate(
              operation,
              view(input().registers[0]!, width),
              view(immediate, width),
              width,
            );
            await one(using, {
              code:
                prefix(width, 0, 8) +
                byte(
                  operation.name === 'test'
                    ? width === 8
                      ? 0xa8
                      : 0xa9
                    : operation.base + (width === 8 ? 4 : 5),
                ) +
                little(immediate, Math.min(width / 8, 4)),
              writes: operation.readOnly
                ? {}
                : { 0: written(input().registers[0]!, accumulator.result, width) },
              outputFlags: accumulator.flags,
              logical: operation.logical,
            });
            for (const short of operation.name !== 'test' && width !== 8
              ? [false, true]
              : [false]) {
              const value = short ? -1n : immediate;
              const result = calculate(operation, operand, view(value, width), width);
              await one(using, {
                code:
                  (width === 16 ? '66' : '') +
                  (width === 64 ? '4c' : '44') +
                  (operation.name === 'test'
                    ? width === 8
                      ? 'f6'
                      : 'f7'
                    : short
                      ? '83'
                      : width === 8
                        ? '80'
                        : '81') +
                  modrm(operation.group, 3, 0) +
                  little(value, short ? 1 : Math.min(width / 8, 4)),
                ram,
                ramAfter: operation.readOnly ? ram : patch(ram, 16, result.result, width / 8),
                outputFlags: result.flags,
                logical: operation.logical,
              });
            }
          }
      },
    },
    {
      name: 'scalar arithmetic flags use independent signed ranges carries parity and nibble boundaries',
      run: async () => {
        for (const operation of operations)
          for (const width of [8, 16, 32, 64]) {
            const code = prefix(width) + byte(operation.base + (width === 8 ? 0 : 1)) + 'c8';
            await using(
              code,
              async (cpu) => {
                const half = 1n << BigInt(width - 1);
                const values = [0n, 1n, 15n, 16n, half - 1n, half, half + 1n, half * 2n - 1n];
                let first = true;
                for (const a of values)
                  for (const b of values) {
                    const before = input(CODE, {
                      0: written(0x1122334455667788n, a, width),
                      1: written(0x8877665544332211n, b, width),
                    });
                    const calculated = calculate(operation, a, b, width);
                    const expected = changed(
                      before,
                      CODE + BigInt(code.length / 2),
                      operation.readOnly
                        ? {}
                        : { 0: written(before.registers[0]!, calculated.result, width) },
                      calculated.flags,
                    );
                    cpu.setState(before);
                    const result = await cpu.run({ budget: 1n });
                    if (operation.logical) logicalExit(result, expected);
                    else exit(result, 'budget', 1n, 1n, expected);
                    noFault(result);
                    equal(
                      result.resources.compilations,
                      first ? 1 : 0,
                      'arithmetic case uses retained code',
                    );
                    first = false;
                    memory(cpu, setup.ramBase, RAM);
                    memory(cpu, CODE, code);
                  }
              },
              setup,
            );
          }
      },
    },
    {
      name: 'high-byte ALU destinations use original aliases and byte-width flags without clearing the bank',
      run: async () => {
        for (const operation of operations)
          for (let bank = 0; bank < 4; bank++) {
            const before = input(undefined, { [bank]: 0x112233445566ff01n });
            const a = view(before.registers[bank]!, 8, true);
            const b = view(before.registers[bank]!, 8);
            const result = calculate(operation, a, b, 8);
            await one(using, {
              code: byte(operation.base) + modrm(bank, bank + 4),
              registers: { [bank]: before.registers[bank]! },
              writes: operation.readOnly
                ? {}
                : { [bank]: written(before.registers[bank]!, result.result, 8, true) },
              outputFlags: result.flags,
              logical: operation.logical,
            });
          }
      },
    },
    {
      name: 'operand overrides and REX.W do not widen any admitted byte integer opcode',
      run: async () => {
        for (const operation of operations)
          for (const p of ['66', '48', '6648']) {
            const before = input();
            const a = view(before.registers[0]!, 8);
            const b = view(before.registers[1]!, 8);
            const result = calculate(operation, a, b, 8);
            const writes = operation.readOnly
              ? {}
              : { 0: written(before.registers[0]!, result.result, 8) };
            await one(using, {
              code: p + byte(operation.base) + 'c8',
              writes,
              outputFlags: result.flags,
              logical: operation.logical,
            });
            if (operation.name !== 'test')
              await one(using, {
                code: p + byte(operation.base + 2) + 'c1',
                writes,
                outputFlags: result.flags,
                logical: operation.logical,
              });
            const immediate = calculate(operation, a, 1n, 8);
            const immediateWrites = operation.readOnly
              ? {}
              : { 0: written(before.registers[0]!, immediate.result, 8) };
            await one(using, {
              code: p + byte(operation.name === 'test' ? 0xa8 : operation.base + 4) + '01',
              writes: immediateWrites,
              outputFlags: immediate.flags,
              logical: operation.logical,
            });
            await one(using, {
              code:
                p + (operation.name === 'test' ? 'f6' : '80') + modrm(operation.group, 0) + '01',
              writes: immediateWrites,
              outputFlags: immediate.flags,
              logical: operation.logical,
            });
          }
      },
    },
  ];
}
