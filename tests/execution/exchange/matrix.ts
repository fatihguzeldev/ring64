import { memory } from '../../support/fixture.js';
import {
  LONG,
  arithmeticFlags,
  bytes,
  changed,
  context,
  input,
  mask,
  merge,
  outcome,
  patch,
  using,
  type Scenario,
} from './fixture.js';

const profiles = [
  { execution: LONG, long64: true, code32: true },
  ...(['real', 'protected', 'compatibility'] as const).flatMap((mode) =>
    [false, true].flatMap((code32) =>
      [false, true].map((stack32) => ({
        execution: context(mode, code32, stack32),
        long64: false,
        code32,
      })),
    ),
  ),
  { execution: context('virtual8086', false, false), long64: false, code32: false },
];

export function matrixScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'scalar exchange memory forms preserve mode widths LOCK and incoming operand snapshots',
      async run() {
        for (const profile of profiles)
          for (const width of profile.long64 ? [8, 16, 32, 64] : [8, 16, 32])
            for (const address of profile.long64 ? [32, 64] : [16, 32])
              for (const locked of [false, true])
                for (const family of ['exchange', 'add', 'hit', 'miss'] as const) {
                  const operandPrefix =
                    (width === 16 && (profile.long64 || profile.code32)) ||
                    (width === 32 && !profile.long64 && !profile.code32)
                      ? '66'
                      : '';
                  const addressPrefix =
                    address === (profile.long64 ? 64 : profile.code32 ? 32 : 16) ? '' : '67';
                  const opcode =
                    family === 'exchange'
                      ? width === 8
                        ? '86'
                        : '87'
                      : family === 'add'
                        ? width === 8
                          ? '0fc0'
                          : '0fc1'
                        : width === 8
                          ? '0fb0'
                          : '0fb1';
                  const code =
                    (locked ? 'f0' : '') +
                    operandPrefix +
                    addressPrefix +
                    (width === 64 ? '48' : '') +
                    opcode +
                    (address === 16 ? '17' : '13');
                  const old = mask(width) - 1n,
                    source = 3n;
                  const before = input(
                    0x1000n,
                    {
                      0: 0x1122334400000000n | (family === 'miss' ? old - 1n : old),
                      2: 0x99aabbcc00000000n | source,
                      3: address === 64 ? 0x6000n : 0xaabbccdd00006000n,
                    },
                    0xcd7n,
                  );
                  if (width === 64) {
                    before.registers[0] = family === 'miss' ? old - 1n : old;
                    before.registers[2] = source;
                  }
                  const frame = patch('a5'.repeat(24), 8, bytes(old, width / 8));
                  await using(
                    compiler,
                    code,
                    profile.execution,
                    async (cpu) => {
                      cpu.setState(before);
                      const updates: Record<number, bigint> = {};
                      let stored = source,
                        flags = before.flags;
                      if (family === 'exchange' || family === 'add')
                        updates[2] = merge(before.registers[2]!, old, width, profile.long64);
                      if (family === 'add') {
                        stored = (old + source) & mask(width);
                        flags = arithmeticFlags(old, source, width);
                      }
                      if (family === 'hit' || family === 'miss') {
                        flags = arithmeticFlags(
                          before.registers[0]! & mask(width),
                          old,
                          width,
                          true,
                        );
                        if (family === 'miss') {
                          stored = old;
                          updates[0] = merge(before.registers[0]!, old, width, profile.long64);
                        }
                      }
                      outcome(
                        await cpu.run({ budget: 1n, repeatBudget: 0n }),
                        'budget',
                        1n,
                        1n,
                        changed(before, 0x1000n + BigInt(code.length / 2), updates, flags),
                      );
                      memory(cpu, 0x5ff8n, patch(frame, 8, bytes(stored, width / 8)));
                      memory(cpu, 0x1000n, code);
                    },
                    { data: [{ base: 0x5ff8n, bytes: frame }] },
                  );
                }
      },
    },
    {
      name: 'CMPXCHG8B keeps fixed qword width and conditional pair writes in every imported mode',
      async run() {
        for (const profile of profiles)
          for (const address of profile.long64 ? [32, 64] : [16, 32])
            for (const prefix66 of ['', '66'])
              for (const locked of [false, true])
                for (const hit of [false, true]) {
                  const addressPrefix =
                    address === (profile.long64 ? 64 : profile.code32 ? 32 : 16) ? '' : '67';
                  const code =
                    (locked ? 'f0' : '') +
                    prefix66 +
                    addressPrefix +
                    '0fc7' +
                    (address === 16 ? '0c' : '0e');
                  const before = input(
                    0x1000n,
                    {
                      0: hit ? 0xaaaabbbb11223344n : 0xaaaabbbb00000000n,
                      2: hit ? 0xccccdddd55667788n : 0xccccdddd00000000n,
                      3: 0xeeeeffff89abcdefn,
                      1: 0x1111222201234567n,
                      6: address === 64 ? 0x6000n : 0x9988776600006000n,
                    },
                    0xcd7n,
                  );
                  const frame = 'a5'.repeat(8) + '4433221188776655' + 'a5'.repeat(8);
                  await using(
                    compiler,
                    code,
                    profile.execution,
                    async (cpu) => {
                      cpu.setState(before);
                      const updates = hit
                        ? {}
                        : {
                            0: merge(before.registers[0]!, 0x11223344n, 32, profile.long64),
                            2: merge(before.registers[2]!, 0x55667788n, 32, profile.long64),
                          };
                      outcome(
                        await cpu.run({ budget: 1n, repeatBudget: 0n }),
                        'budget',
                        1n,
                        1n,
                        changed(
                          before,
                          0x1000n + BigInt(code.length / 2),
                          updates,
                          hit ? 0xcd7n : 0xc97n,
                        ),
                      );
                      memory(cpu, 0x5ff8n, hit ? patch(frame, 8, 'efcdab8967452301') : frame);
                    },
                    { data: [{ base: 0x5ff8n, bytes: frame }] },
                  );
                }
      },
    },
    {
      name: 'register exchange arithmetic and compare aliases use only actual view writes',
      async run() {
        for (const width of [8, 16, 32, 64])
          for (const family of ['exchange', 'add', 'hit', 'miss'] as const)
            for (const alias of ['same', 'separate', 'high', 'extended'] as const) {
              if (alias === 'high' && width !== 8) continue;
              const dst = alias === 'extended' ? 8 : alias === 'separate' ? 1 : 0;
              const src = alias === 'extended' ? 9 : 0;
              const shift = alias === 'high' ? 8 : 0;
              const rex =
                alias === 'extended' ? (width === 64 ? '4d' : '45') : width === 64 ? '48' : '';
              const opcode =
                family === 'exchange'
                  ? width === 8
                    ? '86'
                    : '87'
                  : family === 'add'
                    ? width === 8
                      ? '0fc0'
                      : '0fc1'
                    : width === 8
                      ? '0fb0'
                      : '0fb1';
              const modrm = 0xc0 | ((src & 7) << 3) | (alias === 'high' ? 4 : dst & 7);
              const code = (width === 16 ? '66' : '') + rex + opcode + modrm.toString(16);
              const before = input(
                0x1000n,
                {
                  0: 0x1122334455661234n,
                  1: 0x99aabbcc00000055n,
                  8: 0x8877665544332211n,
                  9: 0xaabbccddeeff0011n,
                },
                0xcd7n,
              );
              if (family === 'hit' || family === 'miss') {
                if (dst === 0 && shift === 0 && family === 'miss') continue;
                const wanted = (before.registers[dst]! >> BigInt(shift)) & mask(width);
                before.registers[0] = merge(
                  before.registers[0]!,
                  family === 'hit' ? wanted : (wanted + 1n) & mask(width),
                  width,
                  false,
                );
              }
              const old = (before.registers[dst]! >> BigInt(shift)) & mask(width);
              const source = before.registers[src]! & mask(width);
              const banks = [...before.registers];
              let flags = before.flags;
              const write = (bank: number, value: bigint, offset = 0) => {
                banks[bank] = merge(banks[bank]!, value, width, true, offset);
              };
              if (family === 'exchange') {
                write(dst, source, shift);
                write(src, old);
              } else if (family === 'add') {
                write(src, old);
                write(dst, old + source, shift);
                flags = arithmeticFlags(old, source, width);
              } else {
                const accumulator = before.registers[0]! & mask(width);
                flags = arithmeticFlags(accumulator, old, width, true);
                if (accumulator === old) write(dst, source, shift);
                else write(0, old);
              }
              await using(compiler, code, LONG, async (cpu) => {
                cpu.setState(before);
                outcome(await cpu.run({ budget: 1n, repeatBudget: 0n }), 'budget', 1n, 1n, {
                  registers: banks,
                  flags,
                  rip: 0x1000n + BigInt(code.length / 2),
                });
              });
            }
      },
    },
  ];
}
