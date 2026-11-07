import { equal, memory } from '../../support/fixture.js';
import {
  LONG,
  MASK128,
  banks,
  bytes,
  changed,
  context,
  input,
  lanes,
  outcome,
  profiles,
  using,
  xmm,
  type Scenario,
} from './fixture.js';

const mask64 = (1n << 64n) - 1n;
const mask32 = 0xffffffffn;
const merge32 = (old: bigint, value: bigint, long64: boolean) =>
  long64 ? value & mask32 : (old & ~mask32) | (value & mask32);
export function transferScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'SIMD raw full scalar and qword moves obey every register direction and alias rule',
      async run() {
        for (const profile of profiles)
          for (const [prefix, load, store, width, merge] of [
            ['66', '6f', '7f', 16, false],
            ['f3', '6f', '7f', 16, false],
            ['', '28', '29', 16, false],
            ['66', '28', '29', 16, false],
            ['', '10', '11', 16, false],
            ['66', '10', '11', 16, false],
            ['f3', '10', '11', 4, true],
            ['f2', '10', '11', 8, true],
            ['f3', '7e', '', 8, false],
            ['66', '', 'd6', 8, false],
          ] as const)
            for (const reverse of [false, true])
              for (const alias of [false, true]) {
                const opcode = reverse ? store : load;
                if (!opcode) continue;
                const code = prefix + '0f' + opcode + (alias ? 'c0' : 'c1');
                const execution =
                  profile.mode === 'long64'
                    ? LONG
                    : context(profile.mode, profile.code32, profile.stack32);
                await using(compiler, code, execution, async (cpu) => {
                  const raw = banks(),
                    before = input(0x1000n, {}, 0xcd7n),
                    destination = reverse && !alias ? 1 : 0,
                    source = reverse ? 0 : alias ? 0 : 1;
                  const lowMask = (1n << BigInt(width * 8)) - 1n,
                    expected = raw.slice();
                  expected[destination] =
                    (merge ? raw[destination]! & ~lowMask : 0n) | (raw[source]! & lowMask);
                  cpu.setXmmState(raw);
                  cpu.setState(before);
                  outcome(
                    await cpu.run({ budget: 1n, repeatBudget: 0n }),
                    'budget',
                    1n,
                    1n,
                    0n,
                    0n,
                    changed(before, 0x1000n + BigInt(code.length / 2)),
                  );
                  xmm(cpu, expected);
                });
              }
      },
    },
    {
      name: 'SIMD GPR transfer insert extract and masks use fixed widths rather than mandatory operand override',
      async run() {
        for (const profile of profiles)
          for (const wide of profile.mode === 'long64' ? [false, true] : [false]) {
            const execution =
              profile.mode === 'long64'
                ? LONG
                : context(profile.mode, profile.code32, profile.stack32);
            for (const family of [
              'to',
              'from',
              'insert',
              'extract',
              'bytes-mask',
              'singles-mask',
              'doubles-mask',
            ] as const) {
              const prefix = family === 'singles-mask' ? '' : '66',
                rex = wide ? '48' : '';
              const op = {
                to: '6e',
                from: '7e',
                insert: 'c4',
                extract: 'c5',
                'bytes-mask': 'd7',
                'singles-mask': '50',
                'doubles-mask': '50',
              }[family];
              const code =
                prefix +
                rex +
                '0f' +
                op +
                'c1' +
                (family === 'insert' || family === 'extract' ? 'ff' : '');
              await using(compiler, code, execution, async (cpu) => {
                const raw = banks(),
                  before = input(
                    0x1000n,
                    { 0: 0x99aabbccddeeff00n, 1: 0x112233445566abcdn },
                    0xcd7n,
                  );
                raw[0] = MASK128;
                raw[1] = 0xabcd8000000080008000000080000080n;
                const expected = raw.slice(),
                  updates: Record<number, bigint> = {};
                if (family === 'to') expected[0] = before.registers[1]! & (wide ? mask64 : mask32);
                else if (family === 'from')
                  updates[1] = wide
                    ? raw[0]! & mask64
                    : merge32(before.registers[1]!, raw[0]!, profile.mode === 'long64');
                else if (family === 'insert')
                  expected[0] =
                    (raw[0]! & ((1n << 112n) - 1n)) | ((before.registers[1]! & 0xffffn) << 112n);
                else {
                  let value = 0n;
                  if (family === 'extract') value = (raw[1]! >> 112n) & 0xffffn;
                  else {
                    const width = family === 'bytes-mask' ? 8 : family === 'singles-mask' ? 32 : 64;
                    lanes(raw[1]!, width).forEach((lane, i) => {
                      if (lane & (1n << BigInt(width - 1))) value |= 1n << BigInt(i);
                    });
                  }
                  updates[0] = merge32(before.registers[0]!, value, profile.mode === 'long64');
                }
                cpu.setState(before);
                cpu.setXmmState(raw);
                outcome(
                  await cpu.run({ budget: 1n, repeatBudget: 0n }),
                  'budget',
                  1n,
                  1n,
                  0n,
                  0n,
                  changed(before, 0x1000n + BigInt(code.length / 2), updates),
                );
                xmm(cpu, expected);
              });
            }
          }
      },
    },
    {
      name: 'SIMD narrow memory loads use exactly two four or eight bytes and clear only required upper bits',
      async run() {
        for (const profile of profiles)
          for (const [prefix, opcode, width, insert] of [
            ['66', '6e', 4, false],
            ['f3', '10', 4, false],
            ['f2', '10', 8, false],
            ['f3', '7e', 8, false],
            ['66', 'c4', 2, true],
          ] as const) {
            const execution =
              profile.mode === 'long64'
                ? LONG
                : context(profile.mode, profile.code32, profile.stack32);
            const address16 = profile.mode !== 'long64' && !profile.code32;
            const code = prefix + '0f' + opcode + (address16 ? '07' : '00') + (insert ? 'ff' : '');
            const data = 0x8877665544332211n & ((1n << BigInt(width * 8)) - 1n);
            await using(
              compiler,
              code,
              execution,
              async (cpu) => {
                const raw = banks(),
                  before = input(0x1000n, { [address16 ? 3 : 0]: 0x6001n }, 0xcd7n),
                  expected = raw.slice();
                expected[0] = insert ? (raw[0]! & ((1n << 112n) - 1n)) | (data << 112n) : data;
                cpu.setXmmState(raw);
                cpu.setState(before);
                outcome(
                  await cpu.run({ budget: 1n, repeatBudget: 0n }),
                  'budget',
                  1n,
                  1n,
                  0n,
                  0n,
                  changed(before, 0x1000n + BigInt(code.length / 2)),
                );
                xmm(cpu, expected);
                memory(cpu, 0x6001n, bytes(data, width));
              },
              { data: [{ base: 0x6001n, bytes: bytes(data, width), write: false }] },
            );
          }
      },
    },
    {
      name: 'SIMD data imports preserve code ownership and inaccessible raw banks across context changes',
      async run() {
        await using(compiler, '66450fefc7', LONG, async (cpu) => {
          const raw = banks(),
            before = input(0x1000n, {}, 0xcd7n);
          cpu.setXmmState(raw);
          cpu.setContext(context('protected', false, false));
          xmm(cpu, raw);
          cpu.setContext(LONG);
          cpu.setState(before);
          xmm(cpu, raw);
          const expected = raw.slice();
          expected[8] = raw[8]! ^ raw[15]!;
          const first = await cpu.run({ budget: 1n, repeatBudget: 0n });
          outcome(first, 'budget', 1n, 1n, 0n, 0n, changed(before, 0x1005n));
          xmm(cpu, expected);
          const owner = cpu.inspectTranslations()[0]!.owner;
          raw[8] = MASK128;
          cpu.setXmmState(raw);
          cpu.setState(before);
          expected[8] = MASK128 ^ raw[15]!;
          const resumed = await cpu.run({ budget: 1n, repeatBudget: 0n });
          outcome(resumed, 'budget', 1n, 1n, 0n, 0n, changed(before, 0x1005n));
          xmm(cpu, expected);
          equal(
            resumed.resources.compilations,
            0,
            'changed XMM invocation inputs retain translation',
          );
          equal(cpu.inspectTranslations()[0]!.owner, owner, 'data import retains owner');
        });
      },
    },
  ];
}
