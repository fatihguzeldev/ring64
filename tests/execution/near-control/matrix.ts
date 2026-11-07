import { memory } from '../../support/fixture.js';
import {
  LONG,
  bytes,
  changed,
  context,
  input,
  outcome,
  patch,
  using,
  type Scenario,
} from './fixture.js';

const modes = [
  { execution: LONG, long64: true, code32: true, stack32: false },
  ...(['real', 'protected', 'compatibility'] as const).flatMap((mode) =>
    [false, true].flatMap((code32) =>
      [false, true].map((stack32) => ({
        execution: context(mode, code32, stack32),
        long64: false,
        code32,
        stack32,
      })),
    ),
  ),
  {
    execution: context('virtual8086', false, false),
    long64: false,
    code32: false,
    stack32: false,
  },
];

function merge(bank: bigint, value: bigint, width: number, long64: boolean): bigint {
  const mask = (1n << BigInt(width)) - 1n;
  return width === 64 || (width === 32 && long64) ? value & mask : (bank & ~mask) | (value & mask);
}

export function matrixScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'near stack memory forms keep operand address and SS widths independent in every imported mode',
      async run() {
        for (const mode of modes)
          for (const operand of mode.long64 ? [16, 64] : [16, 32])
            for (const address of mode.long64 ? [32, 64] : [16, 32])
              for (const family of ['call', 'jump', 'push', 'pop', 'leave'] as const) {
                const slot =
                  (mode.long64 && (family === 'call' || family === 'jump') ? 64 : operand) / 8;
                const operandPrefix =
                  operand === (mode.long64 ? 64 : mode.code32 ? 32 : 16) ? '' : '66';
                const addressPrefix =
                  address === (mode.long64 ? 64 : mode.code32 ? 32 : 16) ? '' : '67';
                const rm = address === 16 ? 7 : 0;
                const encoding =
                  family === 'leave'
                    ? 'c9'
                    : family === 'pop'
                      ? `8f0${rm}`
                      : `ff${((family === 'call' ? 2 : family === 'jump' ? 4 : 6) * 8 + rm).toString(16)}`;
                const code = operandPrefix + addressPrefix + encoding;
                const rawSp = mode.long64 ? 0x4010n : 0x1122334400004010n;
                const rawBp = mode.long64 ? 0x4010n : 0x99aabbcc00004010n;
                const sourceAddress = address === 64 ? 0x6000n : 0xaabbccdd00006000n;
                const value = 0x8877665544332211n;
                const stack = patch('a5'.repeat(48), 16, bytes(value, slot));
                const source =
                  family === 'pop'
                    ? 'cc'.repeat(slot)
                    : bytes(family === 'call' || family === 'jump' ? 0x1020n : value, slot);
                await using(
                  compiler,
                  code,
                  mode.execution,
                  async (cpu) => {
                    const before = input(
                      0x1000n,
                      { 0: sourceAddress, 3: sourceAddress, 4: rawSp, 5: rawBp },
                      0xcd7n,
                    );
                    cpu.setState(before);
                    const updates: Record<number, bigint> = {};
                    let expectedStack = stack;
                    let expectedSource = source;
                    if (family === 'call' || family === 'push') {
                      updates[4] = rawSp - BigInt(slot);
                      expectedStack = patch(
                        stack,
                        16 - slot,
                        bytes(family === 'call' ? 0x1000n + BigInt(code.length / 2) : value, slot),
                      );
                    } else if (family === 'pop') {
                      updates[4] = rawSp + BigInt(slot);
                      expectedSource = bytes(value, slot);
                    } else if (family === 'leave') {
                      updates[4] = rawSp + BigInt(slot);
                      updates[5] = merge(rawBp, value, operand, mode.long64);
                    }
                    outcome(
                      await cpu.run({ budget: 1n, repeatBudget: 0n }),
                      'budget',
                      1n,
                      1n,
                      changed(
                        before,
                        family === 'call' || family === 'jump'
                          ? 0x1020n
                          : 0x1000n + BigInt(code.length / 2),
                        updates,
                      ),
                    );
                    memory(cpu, 0x4000n, expectedStack);
                    memory(cpu, 0x6000n, expectedSource);
                    memory(cpu, 0x1000n, code);
                  },
                  {
                    data: [
                      { base: 0x4000n, bytes: stack },
                      { base: 0x6000n, bytes: source },
                    ],
                  },
                );
              }
      },
    },
    {
      name: 'alternate register stack encodings preserve incoming SP sources and POP SP write ordering',
      async run() {
        for (const mode of modes)
          for (const operand of mode.long64 ? [16, 64] : [16, 32])
            for (const opcode of ['fff4', '8fc4']) {
              const prefix = operand === (mode.long64 ? 64 : mode.code32 ? 32 : 16) ? '' : '66';
              const code = prefix + opcode;
              const slot = operand / 8;
              const rawSp = mode.long64 ? 0x4010n : 0x1122334400004010n;
              const value = 0x8877665544332211n;
              const stack = patch('a5'.repeat(48), 16, bytes(value, slot));
              await using(
                compiler,
                code,
                mode.execution,
                async (cpu) => {
                  const before = input(0x1000n, { 4: rawSp }, 0xcd7n);
                  cpu.setState(before);
                  outcome(
                    await cpu.run({ budget: 1n, repeatBudget: 0n }),
                    'budget',
                    1n,
                    1n,
                    changed(before, 0x1000n + BigInt(code.length / 2), {
                      4:
                        opcode === 'fff4'
                          ? rawSp - BigInt(slot)
                          : merge(rawSp + BigInt(slot), value, operand, mode.long64),
                    }),
                  );
                  memory(
                    cpu,
                    0x4000n,
                    opcode === 'fff4' ? patch(stack, 16 - slot, bytes(rawSp, slot)) : stack,
                  );
                },
                { data: [{ base: 0x4000n, bytes: stack }] },
              );
            }
      },
    },
    {
      name: 'counter branch matrix separates count size target size and incoming ZF without writing flags',
      async run() {
        for (const mode of modes)
          for (const operand of mode.long64 ? [64, 16] : [16, 32])
            for (const address of mode.long64 ? [32, 64] : [16, 32])
              for (const opcode of ['e0', 'e1', 'e2', 'e3']) {
                const prefix =
                  (operand === (mode.long64 ? 64 : mode.code32 ? 32 : 16) ? '' : '66') +
                  (address === (mode.long64 ? 64 : mode.code32 ? 32 : 16) ? '' : '67');
                const code = `${prefix}${opcode}05`;
                const next = 0x1000n + BigInt(code.length / 2);
                await using(compiler, code, mode.execution, async (cpu) => {
                  for (const count of [0n, 1n, 2n, (1n << BigInt(address)) - 1n])
                    for (const flags of [0xc97n, 0xcd7n]) {
                      const bank =
                        address === 64
                          ? count
                          : (address === 16 ? 0x1122334400010000n : 0x1122334400000000n) | count;
                      const candidate = BigInt.asUintN(address, count - 1n);
                      const taken =
                        opcode === 'e3'
                          ? count === 0n
                          : candidate !== 0n &&
                            (opcode === 'e2' ||
                              (opcode === 'e1' ? (flags & 0x40n) !== 0n : (flags & 0x40n) === 0n));
                      const before = input(0x1000n, { 1: bank }, flags);
                      cpu.setState(before);
                      outcome(
                        await cpu.run({ budget: 1n, repeatBudget: 0n }),
                        'budget',
                        1n,
                        1n,
                        changed(
                          before,
                          taken ? next + 5n : next,
                          opcode === 'e3'
                            ? {}
                            : { 1: merge(bank, candidate, address, mode.long64) },
                        ),
                      );
                    }
                });
              }
      },
    },
  ];
}
