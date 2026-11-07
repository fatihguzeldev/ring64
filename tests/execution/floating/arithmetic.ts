import { equal } from '../../support/fixture.js';
import {
  LONG,
  banks,
  changed,
  context,
  input,
  mxcsr,
  noFault,
  outcome,
  profiles,
  simdFault,
  using,
  vector,
  xmm,
  type Scenario,
} from './fixture.js';
import { arithmetic, type Arithmetic, type Format } from './reference.js';
export const formats = [
  { prefix: '', format: 32, scalar: false },
  { prefix: '66', format: 64, scalar: false },
  { prefix: 'f3', format: 32, scalar: true },
  { prefix: 'f2', format: 64, scalar: true },
] as const;
export const operations = [
  ['add', '58'],
  ['sub', '5c'],
  ['mul', '59'],
  ['div', '5e'],
  ['sqrt', '51'],
  ['min', '5d'],
  ['max', '5f'],
] as const;
export function patterns(f: Format): bigint[] {
  return f === 32
    ? [
        0n,
        0x80000000n,
        0x3f800000n,
        0xbf800000n,
        0x40000000n,
        0x40400000n,
        0x00800000n,
        1n,
        0x7f7fffffn,
        0x7f800000n,
        0xff800000n,
        0x7fc00011n,
        0x7f800022n,
        0x33800000n,
        0x007fffffn,
        0x3f7fffffn,
      ]
    : [
        0n,
        0x8000000000000000n,
        0x3ff0000000000000n,
        0xbff0000000000000n,
        0x4000000000000000n,
        0x4008000000000000n,
        0x0010000000000000n,
        1n,
        0x7fefffffffffffffn,
        0x7ff0000000000000n,
        0xfff0000000000000n,
        0x7ff8000000000011n,
        0x7ff0000000000022n,
        0x3ca0000000000000n,
        0x000fffffffffffffn,
        0x3fefffffffffffffn,
      ];
}
export function arithmeticScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'floating arithmetic matches independent exact rational models in every mode and rounding direction',
      async run() {
        for (const p of profiles)
          for (const form of formats)
            for (const [operation, opcode] of operations) {
              const code = form.prefix + '0f' + opcode + 'c1',
                execution = p.mode === 'long64' ? LONG : context(p.mode, p.code32, p.stack32),
                v = patterns(form.format);
              await using(compiler, code, execution, async (cpu) => {
                for (let rc = 0; rc < 4; rc++)
                  for (let sample = 0; sample < v.length; sample++) {
                    const raw = banks(),
                      mask = (1n << BigInt(form.format)) - 1n,
                      count = form.scalar ? 1 : 128 / form.format;
                    const a = vector(
                        Array.from({ length: count }, (_, i) => v[(sample + 3 * i) % v.length]!),
                        form.format,
                      ),
                      b = vector(
                        Array.from(
                          { length: count },
                          (_, i) => v[(5 * sample + 7 * i + 3) % v.length]!,
                        ),
                        form.format,
                      );
                    raw[0] = form.scalar ? (raw[0]! & ~mask) | a : a;
                    raw[1] = form.scalar ? (raw[1]! & ~mask) | b : b;
                    const csr = 0x1f80 | (rc << 13),
                      expected = arithmetic(
                        operation,
                        raw[0]!,
                        raw[1]!,
                        form.format,
                        form.scalar,
                        csr,
                      ),
                      after = raw.slice(),
                      before = input(0x1000n, {}, 0xcd7n);
                    after[0] = expected.bits;
                    cpu.setState(before);
                    cpu.setXmmState(raw);
                    cpu.setMxcsr(csr);
                    const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
                    outcome(
                      result,
                      'budget',
                      1n,
                      1n,
                      0n,
                      0n,
                      changed(before, 0x1000n + BigInt(code.length / 2)),
                    );
                    xmm(cpu, after);
                    equal(
                      cpu.readMxcsr(),
                      expected.mxcsr,
                      `${p.name}/${operation}/${form.format}/${form.scalar}/rc${rc}/sample${sample}/a${raw[0]!.toString(16)}/b${raw[1]!.toString(16)}`,
                    );
                    noFault(result);
                    if (rc !== 0 || sample !== 0)
                      equal(
                        result.resources.compilations,
                        0,
                        'numeric values and controls retain translation',
                      );
                  }
              });
            }
      },
    },
    {
      name: 'floating unmasked exception phases preserve all lanes and re-raise already sticky status',
      async run() {
        for (const form of formats)
          for (const [operation, opcode] of operations) {
            const code = form.prefix + '0f' + opcode + 'c1',
              v = patterns(form.format);
            await using(compiler, code, LONG, async (cpu) => {
              for (const controls of [
                0, 0x1f80, 0x1f00, 0x1e80, 0x1d80, 0x1b80, 0x1780, 0x0f80, 0x1fc0, 0x9f80, 0x9780,
                0x8f80,
              ])
                for (let sample = 0; sample < v.length; sample++) {
                  const f = form.format,
                    count = form.scalar ? 1 : 128 / f,
                    mask = (1n << BigInt(f)) - 1n,
                    raw = banks();
                  const a = vector(
                      Array.from({ length: count }, (_, i) => v[(sample + i) % v.length]!),
                      f,
                    ),
                    b = vector(
                      Array.from(
                        { length: count },
                        (_, i) => v[(sample * 3 + i * 5 + 2) % v.length]!,
                      ),
                      f,
                    );
                  raw[0] = form.scalar ? (raw[0]! & ~mask) | a : a;
                  raw[1] = form.scalar ? (raw[1]! & ~mask) | b : b;
                  for (const sticky of [0, 0x3f]) {
                    const csr = controls | sticky,
                      expected = arithmetic(operation, raw[0]!, raw[1]!, f, form.scalar, csr),
                      after = raw.slice(),
                      before = input(0x1000n, {}, 0xcd7n);
                    after[0] = expected.bits;
                    cpu.setState(before);
                    cpu.setXmmState(raw);
                    cpu.setMxcsr(csr);
                    const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
                    outcome(
                      result,
                      expected.unmasked ? 'simd-exception' : 'budget',
                      1n,
                      expected.unmasked ? 0n : 1n,
                      0n,
                      0n,
                      expected.unmasked
                        ? before
                        : changed(before, 0x1000n + BigInt(code.length / 2)),
                    );
                    xmm(cpu, after);
                    mxcsr(cpu, expected.mxcsr);
                    if (expected.unmasked)
                      simdFault(
                        result,
                        csr,
                        expected.mxcsr,
                        expected.raised,
                        expected.unmasked,
                        expected.stage!,
                      );
                    else noFault(result);
                  }
                }
            });
          }
      },
    },
    {
      name: 'floating extended and same-bank operands capture incoming values before scalar and packed publication',
      async run() {
        for (const form of formats)
          for (const [operation, opcode] of operations)
            for (const [dst, src, rex] of [
              [0, 0, ''],
              [8, 9, '45'],
              [15, 15, '4d'],
            ] as const) {
              const modrm = (0xc0 | ((dst & 7) << 3) | (src & 7)).toString(16),
                code = form.prefix + rex + '0f' + opcode + modrm;
              await using(compiler, code, LONG, async (cpu) => {
                const raw = banks(),
                  v = patterns(form.format),
                  count = form.scalar ? 1 : 128 / form.format,
                  mask = (1n << BigInt(form.format)) - 1n;
                raw[dst] = form.scalar
                  ? (raw[dst]! & ~mask) | v[2]!
                  : vector(
                      Array.from({ length: count }, (_, i) => v[2 + i]!),
                      form.format,
                    );
                if (dst !== src)
                  raw[src] = form.scalar
                    ? (raw[src]! & ~mask) | v[5]!
                    : vector(
                        Array.from({ length: count }, (_, i) => v[5 + i]!),
                        form.format,
                      );
                const csr = 0x1f80,
                  expected = arithmetic(
                    operation as Arithmetic,
                    raw[dst]!,
                    raw[src]!,
                    form.format,
                    form.scalar,
                    csr,
                  ),
                  after = raw.slice(),
                  before = input();
                after[dst] = expected.bits;
                cpu.setState(before);
                cpu.setXmmState(raw);
                cpu.setMxcsr(csr);
                const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
                outcome(
                  result,
                  'budget',
                  1n,
                  1n,
                  0n,
                  0n,
                  changed(before, 0x1000n + BigInt(code.length / 2)),
                );
                xmm(cpu, after);
                mxcsr(cpu, expected.mxcsr);
                noFault(result);
              });
            }
      },
    },
  ];
}
