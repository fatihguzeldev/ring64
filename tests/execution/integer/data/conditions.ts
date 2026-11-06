import {
  CODE,
  changed,
  createFixture,
  equal,
  exit,
  hex,
  memory,
  type Scenario,
} from '../../../support/fixture.js';
import {
  byte,
  input,
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

// Bit cc is the literal truth-table result for CF/PF/ZF/SF/OF; AF is orthogonal.
const truth: readonly (readonly [bigint, number])[] = [
  [0x2n, 0xaaaa],
  [0x3n, 0xaa66],
  [0x6n, 0xa6aa],
  [0x7n, 0xa666],
  [0x42n, 0x6a5a],
  [0x43n, 0x6a56],
  [0x46n, 0x665a],
  [0x47n, 0x6656],
  [0x82n, 0x59aa],
  [0x83n, 0x5966],
  [0x86n, 0x55aa],
  [0x87n, 0x5566],
  [0xc2n, 0x595a],
  [0xc3n, 0x5956],
  [0xc6n, 0x555a],
  [0xc7n, 0x5556],
  [0x802n, 0x5aa9],
  [0x803n, 0x5a65],
  [0x806n, 0x56a9],
  [0x807n, 0x5665],
  [0x842n, 0x5a59],
  [0x843n, 0x5a55],
  [0x846n, 0x5659],
  [0x847n, 0x5655],
  [0x882n, 0xa9a9],
  [0x883n, 0xa965],
  [0x886n, 0xa5a9],
  [0x887n, 0xa565],
  [0x8c2n, 0x6959],
  [0x8c3n, 0x6955],
  [0x8c6n, 0x6559],
  [0x8c7n, 0x6555],
];

export function dataConditionScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createFixture(core);
  return [
    {
      name: 'SETcc and CMOVcc consume all condition flag combinations and preserve concrete AF in retained code',
      run: async () => {
        for (let cc = 0; cc < 16; cc++)
          for (const width of [8, 16, 32, 64])
            for (const fromMemory of [false, true]) {
              const setting = width === 8;
              const code =
                prefix(width) +
                '0f' +
                byte((setting ? 0x90 : 0x40) + cc) +
                (fromMemory ? '03' : setting ? 'c0' : 'c1');
              const operand = view(0xfedcba98800080ffn, width);
              const ram = setting ? RAM : patch(RAM, 16, operand, width / 8);
              await using(
                code,
                async (cpu) => {
                  let first = true;
                  for (const [flags, mask] of truth)
                    for (const af of [0n, 0x10n]) {
                      const before = input(CODE, { 1: 0xfedcba98800080ffn }, flags | af);
                      const taken = (mask & (1 << cc)) !== 0;
                      const value = taken ? 1n : 0n;
                      const source = fromMemory ? operand : view(before.registers[1]!, width);
                      const writes = setting
                        ? fromMemory
                          ? {}
                          : { 0: written(before.registers[0]!, value, 8) }
                        : taken
                          ? { 0: written(before.registers[0]!, source, width) }
                          : width === 32
                            ? { 0: view(before.registers[0]!, 32) }
                            : {};
                      cpu.writeMemory(setup.ramBase, hex(ram));
                      cpu.setState(before);
                      const result = await cpu.run({ budget: 1n });
                      exit(
                        result,
                        'budget',
                        1n,
                        1n,
                        changed(before, CODE + BigInt(code.length / 2), writes),
                      );
                      noFault(result);
                      equal(
                        result.resources.compilations,
                        first ? 1 : 0,
                        'fresh conditions reuse one artifact',
                      );
                      equal(
                        result.resources.nativeEntries,
                        1,
                        'one native entry per condition observation',
                      );
                      first = false;
                      memory(
                        cpu,
                        setup.ramBase,
                        setting && fromMemory ? patch(ram, 16, value, 1) : ram,
                      );
                      memory(cpu, CODE, code);
                    }
                },
                { ...setup, ram },
              );
            }
      },
    },
    {
      name: 'conditional data destinations select every bank high byte and ignored ModRM field',
      run: async () => {
        for (let bank = 0; bank < 16; bank++) {
          for (let ignored = 0; ignored < 8; ignored++) {
            await one(using, {
              code: prefix(8, 0, bank) + '0f94' + modrm(ignored, bank),
              writes: { [bank]: written(input().registers[bank]!, 1n, 8) },
            });
            const p = prefix(8, 8, bank);
            await one(using, {
              code:
                '66' +
                p.slice(0, -2) +
                byte(Number.parseInt(p.slice(-2), 16) | 8) +
                '0f94' +
                modrm(ignored, bank),
              writes: { [bank]: written(input().registers[bank]!, 1n, 8) },
            });
          }
          for (const width of [16, 32, 64])
            for (const taken of [false, true]) {
              const source = (bank + 5) % 16;
              const before = input(undefined, {}, taken ? 0x52n : 0x12n);
              const value = taken
                ? written(before.registers[bank]!, before.registers[source]!, width)
                : width === 32
                  ? view(before.registers[bank]!, 32)
                  : before.registers[bank]!;
              await one(using, {
                code: prefix(width, bank, source) + '0f44' + modrm(bank, source),
                flags: before.flags,
                writes: { [bank]: value },
              });
              const operand = view(0xfedcba98800080ffn, width);
              await one(using, {
                code: prefix(width, bank, 3) + '0f44' + modrm(bank, 3, 0),
                flags: before.flags,
                ram: patch(RAM, 16, operand, width / 8),
                writes: {
                  [bank]: taken
                    ? written(before.registers[bank]!, operand, width)
                    : width === 32
                      ? view(before.registers[bank]!, 32)
                      : before.registers[bank]!,
                },
              });
            }
        }
        for (let bank = 0; bank < 4; bank++)
          for (let ignored = 0; ignored < 8; ignored++)
            for (const taken of [false, true])
              await one(using, {
                code: '0f94' + modrm(ignored, bank + 4),
                flags: taken ? 0x52n : 0x12n,
                writes: { [bank]: written(input().registers[bank]!, taken ? 1n : 0n, 8, true) },
              });
      },
    },
  ];
}
