import type { SegmentName, SegmentSnapshot } from '../../../host/index.js';
import { changed, equal, hex, initial, snapshot, state, using, type Scenario } from './fixture.js';
import {
  addressPrefix,
  bytes,
  fingerprint,
  operandPrefix,
  preserveNumeric,
  profiles,
} from './modes.js';

function loaded(selector = 8): SegmentSnapshot {
  return {
    selector,
    base: 0x7000n,
    limit: 0xffff,
    default32: false,
    usable: true,
    type: 'read-write',
    dpl: 0,
    present: true,
    conforming: false,
    accessed: true,
    long: false,
    granularity: false,
    available: false,
  };
}

export function valueScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'protection far pointer loads cover every admitted profile form width and exact source span',
      async run() {
        const forms: readonly [SegmentName, string, number][] = [
          ['ds', 'c5', 0],
          ['es', 'c4', 1],
          ['fs', '0fb4', 2],
          ['gs', '0fb5', 6],
          ['ss', '0fb2', 4],
        ];
        for (const execution of profiles())
          for (const [target, opcode, destination] of forms) {
            const long = execution.mode === 'long64',
              real = execution.mode === 'real' || execution.mode === 'virtual8086';
            if (long && (target === 'ds' || target === 'es')) continue;
            for (const width of long ? [16, 32, 64] : [16, 32]) {
              const selector = real ? 0x31 : 8,
                offset = width === 16 ? 0x5678n : width === 32 ? 0x89abcdefn : 0x123456789abcdef0n;
              const code =
                operandPrefix(execution, width) +
                addressPrefix(execution) +
                opcode +
                (destination * 8 + 3).toString(16).padStart(2, '0');
              const pointer = bytes(offset, width / 8) + bytes(BigInt(selector), 2);
              await using(
                compiler,
                code,
                execution,
                async (cpu) => {
                  const before = initial(
                      0x1000n,
                      { 3: long ? 0x6000n : 0x1234567800006000n },
                      0xcd7n,
                    ),
                    numeric = preserveNumeric(cpu);
                  cpu.setState(before);
                  const result = await cpu.run({ budget: 1n });
                  equal(result.reason, 'budget', 'far pointer success');
                  equal(result.retired, 1n, 'one far load');
                  const mask = (1n << BigInt(width)) - 1n;
                  const value =
                    long && width === 32
                      ? offset
                      : (before.registers[destination]! & ~mask) | (offset & mask);
                  state(
                    result.state,
                    changed(before, 0x1000n + BigInt(code.length / 2), { [destination]: value }),
                  );
                  const expected = structuredClone(execution);
                  expected.segments[target] = real
                    ? { ...expected.segments[target], selector, base: BigInt(selector) << 4n }
                    : loaded();
                  equal(
                    fingerprint(cpu.readContext()),
                    fingerprint(expected),
                    'literal far-load cache and preserved context',
                  );
                  equal(
                    fingerprint(cpu.readMemory(0x6000n, pointer.length / 2)),
                    fingerprint(hex(pointer)),
                    'exact captured source',
                  );
                  numeric();
                },
                {
                  data: [
                    { base: 0x6000n, bytes: pointer, write: false },
                    ...(real ? [] : [{ base: 0x4008n, bytes: 'ffff007000930000', write: false }]),
                  ],
                },
              );
            }
          }
      },
    },
    {
      name: 'protection LSS merges a sixteen bit destination with the live producer and leaves SP independent',
      async run() {
        for (const execution of [
          snapshot(),
          ...profiles().filter((p) => p.mode === 'protected' || p.mode === 'compatibility'),
        ]) {
          const code =
            operandPrefix(execution, 32) +
            'b9ffff2211' +
            operandPrefix(execution, 16) +
            addressPrefix(execution) +
            '0fb20b';
          await using(
            compiler,
            code,
            execution,
            async (cpu) => {
              const before = initial(0x1000n, { 3: 0x6000n }, 0xcd7n),
                numeric = preserveNumeric(cpu);
              cpu.setState(before);
              const result = await cpu.run({ budget: 2n });
              equal(result.reason, 'budget', 'dirty LSS completion');
              equal(result.retired, 2n, 'producer plus load');
              const value =
                (execution.mode === 'long64' ? 0n : before.registers[1]! & ~0xffffffffn) |
                0x11225678n;
              state(result.state, changed(before, 0x1000n + BigInt(code.length / 2), { 1: value }));
              equal(result.state.registers[4], before.registers[4], 'non-SP destination');
              const expected = structuredClone(execution);
              expected.segments.ss = loaded();
              equal(
                fingerprint(cpu.readContext()),
                fingerprint(expected),
                'new SS with encoded CX destination',
              );
              numeric();
            },
            {
              data: [
                { base: 0x6000n, bytes: '78560800', write: false },
                { base: 0x4008n, bytes: 'ffff007000930000', write: false },
              ],
            },
          );
        }
      },
    },
    {
      name: 'protection LSS changes the actual subsequent PUSH POP stack base and sixteen bit stack address size',
      async run() {
        const execution = snapshot('protected');
        await using(
          compiler,
          '0fb223505a',
          execution,
          async (cpu) => {
            const before = initial(
                0x1000n,
                { 0: 0x8877665555667788n, 3: 0x6000n, 4: 0x11223344deadbeefn },
                0xcd7n,
              ),
              numeric = preserveNumeric(cpu);
            cpu.setState(before);
            const first = await cpu.run({ budget: 1n });
            equal(first.reason, 'budget', 'LSS retires at its own boundary');
            equal(first.retired, 1n, 'one LSS');
            const after = changed(before, 0x1003n, { 4: 0x1122334400000080n });
            state(first.state, after);
            equal(cpu.readContext().segments.ss.default32, false, 'loaded SS.B0');
            const resumed = await cpu.run({ budget: 2n });
            equal(resumed.reason, 'budget', 'stack consumers');
            equal(resumed.retired, 2n, 'one push and pop');
            state(resumed.state, changed(after, 0x1005n, { 2: 0x1122334455667788n }));
            const expected = hex('cc'.repeat(256));
            expected.set(hex('88776655'), 0x7c);
            equal(
              fingerprint(cpu.readMemory(0x7000n, 256)),
              fingerprint(expected),
              'new stack physical bytes and all guards',
            );
            numeric();
          },
          {
            data: [
              { base: 0x6000n, bytes: '800000000800', write: false },
              { base: 0x4008n, bytes: 'ffff007000930000', write: false },
              { base: 0x7000n, bytes: 'cc'.repeat(256) },
            ],
          },
        );
      },
    },
    {
      name: 'protection SLDT reads its visible invalid selector into every register width and exactly m16 at CPL3',
      async run() {
        for (const execution of profiles().filter(
          (p) => p.mode === 'protected' || p.mode === 'compatibility' || p.mode === 'long64',
        )) {
          execution.cpl = 3;
          execution.ldtr.selector = 0xbeef;
          for (const width of execution.mode === 'long64' ? [16, 32, 64] : [16, 32]) {
            const prefix = operandPrefix(execution, width);
            const code =
              operandPrefix(execution, 32) +
              'b9ffff2211' +
              prefix +
              '0f00c1' +
              prefix +
              addressPrefix(execution) +
              '0f0003';
            await using(
              compiler,
              code,
              execution,
              async (cpu) => {
                const before = initial(0x1000n, { 3: 0x6000n }, 0xcd7n),
                  numeric = preserveNumeric(cpu);
                cpu.setState(before);
                const result = await cpu.run({ budget: 3n });
                equal(result.reason, 'budget', 'unprivileged SLDT');
                equal(result.retired, 3n, 'producer register and memory');
                const producer =
                  (execution.mode === 'long64' ? 0n : before.registers[1]! & ~0xffffffffn) |
                  0x1122ffffn;
                const value =
                  width === 16
                    ? (producer & ~0xffffn) | 0xbeefn
                    : execution.mode === 'long64'
                      ? 0xbeefn
                      : (producer & ~0xffffffffn) | 0xbeefn;
                state(
                  result.state,
                  changed(before, 0x1000n + BigInt(code.length / 2), { 1: value }),
                );
                equal(
                  fingerprint(cpu.readMemory(0x6000n, 8)),
                  fingerprint(hex('efbe' + 'cc'.repeat(6))),
                  'm16 regardless of operand prefixes',
                );
                equal(
                  fingerprint(cpu.readContext()),
                  fingerprint(execution),
                  'SLDT preserves invalid LDTR cache and all roots',
                );
                numeric();
              },
              { data: [{ base: 0x6000n, bytes: 'cc'.repeat(8) }] },
            );
          }
        }
      },
    },
    {
      name: 'protection REX extension belongs to GPR banks while segment numbers ignore REX R',
      async run() {
        const execution = snapshot(),
          code = '66b808004d8cc8448ee8450fb40b';
        await using(
          compiler,
          code,
          execution,
          async (cpu) => {
            const before = initial(0x1000n, { 11: 0x6000n }, 0xcd7n),
              numeric = preserveNumeric(cpu);
            cpu.setState(before);
            const result = await cpu.run({ budget: 4n });
            equal(result.reason, 'budget', 'high bank forms');
            equal(result.retired, 4n, 'four forms');
            state(
              result.state,
              changed(before, 0x1000n + BigInt(code.length / 2), {
                0: (before.registers[0]! & ~0xffffn) | 8n,
                8: 8n,
                9: 0x89abcdefn,
              }),
            );
            const expected = structuredClone(execution);
            expected.segments.gs = loaded();
            expected.segments.fs = loaded();
            equal(
              fingerprint(cpu.readContext()),
              fingerprint(expected),
              'GS source field ignores REX R and LFS uses R9',
            );
            numeric();
          },
          {
            data: [
              { base: 0x6000n, bytes: 'efcdab890800', write: false },
              { base: 0x4008n, bytes: 'ffff007000930000', write: false },
            ],
          },
        );
      },
    },
  ];
}
