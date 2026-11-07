import type { Cpu, State } from '../../../host/index.js';
import { check, equal, memory } from '../../support/fixture.js';
import {
  LONG,
  MASK128,
  banks,
  bytes,
  changed,
  context,
  input,
  lanes,
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
import { classify, lane, rational, round, type Format } from './reference.js';

const wordMask = (f: Format) => (1n << BigInt(f)) - 1n;
const controls = [0x1f80, 0x1f00, 0x1e80, 0x1fc0];
const execution = (p: (typeof profiles)[number]) =>
  p.mode === 'long64' ? LONG : context(p.mode, p.code32, p.stack32);
function patterns(f: Format): bigint[] {
  return f === 32
    ? [
        0n,
        0x80000000n,
        0x3f800000n,
        0xbf800000n,
        0x7f800000n,
        0xff800000n,
        0x7fc00011n,
        0x7f800022n,
        1n,
        0x80000001n,
      ]
    : [
        0n,
        0x8000000000000000n,
        0x3ff0000000000000n,
        0xbff0000000000000n,
        0x7ff0000000000000n,
        0xfff0000000000000n,
        0x7ff8000000000011n,
        0x7ff0000000000022n,
        1n,
        0x8000000000000001n,
      ];
}
function ordered(a: bigint, b: bigint, f: Format): number {
  const x = classify(a, f),
    y = classify(b, f);
  if (a === b || (x.zero && y.zero)) return 0;
  if (x.sign !== y.sign) return x.sign ? -1 : 1;
  return (a < b ? -1 : 1) * (x.sign ? -1 : 1);
}
function comparison(
  a: bigint,
  b: bigint,
  f: Format,
  csr: number,
  predicate: number,
  flags = false,
  unorderedQuiet = false,
) {
  const sign = 1n << BigInt(f - 1);
  if (csr & 64) {
    if (classify(a, f).denormal) a &= sign;
    if (classify(b, f).denormal) b &= sign;
  }
  const x = classify(a, f),
    y = classify(b, f),
    nan = x.nan || y.nan;
  let raised = nan
    ? x.snan ||
      y.snan ||
      (flags && !unorderedQuiet) ||
      (!flags && [1, 2, 5, 6].includes(predicate & 7))
      ? 1
      : 0
    : x.denormal || y.denormal
      ? 2
      : 0;
  const order = nan ? undefined : ordered(a, b, f);
  if (flags)
    return {
      bits: BigInt(order === undefined ? 0x45 : order === 0 ? 0x40 : order < 0 ? 1 : 0),
      raised,
    };
  const truth = [
    order === 0,
    order !== undefined && order < 0,
    order !== undefined && order <= 0,
    nan,
    order !== 0,
    order === undefined || order >= 0,
    order === undefined || order > 0,
    !nan,
  ][predicate & 7]!;
  return { bits: truth ? wordMask(f) : 0n, raised };
}
async function execute(
  cpu: Cpu,
  code: string,
  before: State,
  raw: bigint[],
  expected: bigint[],
  csr: number,
  raised = 0,
  flags = before.flags,
) {
  cpu.setState(before);
  cpu.setXmmState(raw);
  cpu.setMxcsr(csr);
  const unmasked = raised & ~(csr >>> 7) & 63,
    result = await cpu.run({ budget: 1n, repeatBudget: 7n });
  outcome(
    result,
    unmasked ? 'simd-exception' : 'budget',
    1n,
    unmasked ? 0n : 1n,
    7n,
    0n,
    unmasked ? before : changed(before, 0x1000n + BigInt(code.length / 2), {}, flags),
  );
  xmm(cpu, unmasked ? raw : expected);
  mxcsr(cpu, csr | raised);
  if (unmasked) simdFault(result, csr, csr | raised, raised, unmasked, 'pre-computation');
  else noFault(result);
  return result;
}
function reciprocal(raw: bigint): bigint {
  const x = rational(raw, 32),
    negative = x.n < 0n;
  let result = round({ n: negative ? -x.d : x.d, d: negative ? -x.n : x.n }, 32, 0x1f80).bits;
  if (classify(result, 32).denormal) result &= 0x80000000n;
  return result;
}
function approximate(raw: bigint, root: boolean): bigint {
  let c = classify(raw, 32);
  if (c.denormal) {
    raw &= 0x80000000n;
    c = classify(raw, 32);
  }
  if (c.nan) return raw | 0x00400000n;
  if (c.zero) return (raw & 0x80000000n) | 0x7f800000n;
  if (root && c.sign) return 0xffc00000n;
  if (c.inf) return raw & 0x80000000n;
  return reciprocal(root ? lane('sqrt', 0n, raw, 32, 0x1f80).bits : raw);
}
function errorBound(raw: bigint, result: bigint, root: boolean) {
  const c = classify(raw, 32),
    out = classify(result, 32);
  if (c.nan || c.inf || c.zero || c.denormal || (root && c.sign) || out.zero) return;
  const x = rational(raw, 32),
    y = rational(result, 32);
  if (root) {
    const n = x.n * y.n * y.n,
      d = x.d * y.d * y.d;
    check(
      n * 8192n ** 2n >= d * 8189n ** 2n && n * 8192n ** 2n <= d * 8195n ** 2n,
      'RSQRT independent relative-error bound',
    );
  } else {
    const n = x.n * y.n,
      d = x.d * y.d;
    check((n > d ? n - d : d - n) * 8192n <= 3n * d, 'RCP independent relative-error bound');
  }
}

export function relationScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'floating CMP predicates use all imm8 aliases and quiet signalling signed-zero infinity and denormal rules',
      async run() {
        for (const [prefix, f, scalar] of [
          ['', 32, false],
          ['66', 64, false],
          ['f3', 32, true],
          ['f2', 64, true],
        ] as const)
          for (let immediate = 0; immediate < 256; immediate++) {
            const code = prefix + '450fc2c1' + immediate.toString(16).padStart(2, '0'),
              v = patterns(f),
              pairs = [
                [0, 1],
                [2, 3],
                [5, 4],
                [6, 2],
                [2, 7],
                [8, 0],
                [9, 1],
              ];
            await using(compiler, code, LONG, async (cpu) => {
              let calls = 0;
              for (const csr0 of controls)
                for (let sample = 0; sample < pairs.length; sample++) {
                  const csr = csr0 | (sample % 2 ? 0x3f : 0),
                    raw = banks(),
                    count = scalar ? 1 : 128 / f,
                    expected = raw.slice();
                  const a = vector(
                      Array.from(
                        { length: count },
                        (_, i) => v[pairs[(sample + i) % pairs.length]![0]!]!,
                      ),
                      f,
                    ),
                    b = vector(
                      Array.from(
                        { length: count },
                        (_, i) => v[pairs[(sample + i) % pairs.length]![1]!]!,
                      ),
                      f,
                    );
                  raw[8] = scalar ? (raw[8]! & ~wordMask(f)) | a : a;
                  raw[9] = scalar ? (raw[9]! & ~wordMask(f)) | b : b;
                  const values = Array.from({ length: count }, (_, i) =>
                    comparison(
                      (a >> BigInt(i * f)) & wordMask(f),
                      (b >> BigInt(i * f)) & wordMask(f),
                      f,
                      csr,
                      immediate,
                    ),
                  );
                  const raised = values.reduce((r, v) => r | v.raised, 0),
                    bits = vector(
                      values.map((v) => v.bits),
                      f,
                    );
                  expected[8] = (scalar ? raw[8]! & ~wordMask(f) : 0n) | bits;
                  expected[9] = raw[9]!;
                  const result = await execute(cpu, code, input(), raw, expected, csr, raised);
                  equal(
                    result.resources.compilations,
                    calls++ === 0 ? 1 : 0,
                    'CMP immediates keep imported values out of dependencies',
                  );
                }
              memory(cpu, 0x1000n, code);
            });
          }
      },
    },
    {
      name: 'floating COMI and UCOMI publish only defined arithmetic flags across modes aliases and exception controls',
      async run() {
        for (const p of profiles)
          for (const [prefix, f] of [
            ['', 32],
            ['66', 64],
          ] as const)
            for (const [opcode, quiet] of [
              ['2f', false],
              ['2e', true],
            ] as const)
              for (const alias of [false, true]) {
                const dst = p.mode === 'long64' ? 8 : 0,
                  src = alias ? dst : p.mode === 'long64' ? 15 : 7,
                  code =
                    prefix +
                    (p.mode === 'long64' ? '4d' : '') +
                    '0f' +
                    opcode +
                    (alias ? 'c0' : 'c7'),
                  v = patterns(f);
                await using(compiler, code, execution(p), async (cpu) => {
                  for (const csr0 of [
                    0, 0x1f80, 0x1f00, 0x1e80, 0x1fc0, 0x3f80, 0x5f80, 0x7f80, 0x9f80, 0xffff,
                  ])
                    for (let sample = 0; sample < v.length; sample++) {
                      const raw = banks(),
                        csr = csr0 | (sample % 2 ? 63 : 0);
                      raw[dst] = (raw[dst]! & ~wordMask(f)) | v[sample]!;
                      if (!alias)
                        raw[src] = (raw[src]! & ~wordMask(f)) | v[(sample * 3 + 2) % v.length]!;
                      const value = comparison(
                          raw[dst]! & wordMask(f),
                          raw[src]! & wordMask(f),
                          f,
                          csr,
                          0,
                          true,
                          quiet,
                        ),
                        before = input(0x1000n, {}, sample % 2 ? 0xcd7n : 0x8d7n);
                      const flags = (before.flags & ~0x8d5n) | value.bits;
                      await execute(cpu, code, before, raw, raw, csr, value.raised, flags);
                    }
                  memory(cpu, 0x1000n, code);
                });
              }
      },
    },
    {
      name: 'floating reciprocals use deterministic exact references and independent error bounds while ignoring every MXCSR control',
      async run() {
        const v = [
          0n,
          0x80000000n,
          1n,
          0x80000001n,
          0x7f800000n,
          0xff800000n,
          0xbf800000n,
          0x7f800022n,
          0xffc00011n,
          0x3f800000n,
          0x40000000n,
          0x40400000n,
          0x00800000n,
          0x7f7fffffn,
          0x3f7fffffn,
          0x41234567n,
        ];
        for (const p of profiles)
          for (const scalar of [false, true])
            for (const root of [false, true])
              for (const alias of [false, true]) {
                const dst = p.mode === 'long64' ? 8 : 0,
                  src = alias ? dst : p.mode === 'long64' ? 15 : 1,
                  code =
                    (scalar ? 'f3' : '') +
                    (p.mode === 'long64' ? '45' : '') +
                    '0f' +
                    (root ? '52' : '53') +
                    (alias ? 'c0' : p.mode === 'long64' ? 'c7' : 'c1');
                await using(compiler, code, execution(p), async (cpu) => {
                  for (const csr of [0, 0x3f, 0x1f80, 0x3f80, 0x5f80, 0x7f80, 0x9fc0, 0xffff])
                    for (let sample = 0; sample < v.length; sample++) {
                      const raw = banks(),
                        count = scalar ? 1 : 4,
                        source = vector(
                          Array.from({ length: count }, (_, i) => v[(sample + 3 * i) % v.length]!),
                          32,
                        );
                      raw[src] = scalar ? (raw[src]! & ~0xffffffffn) | source : source;
                      const values = Array.from({ length: count }, (_, i) => {
                        const x = (source >> BigInt(32 * i)) & 0xffffffffn;
                        const result = approximate(x, root);
                        errorBound(x, result, root);
                        return result;
                      });
                      const expected = raw.slice();
                      expected[dst] = (scalar ? raw[dst]! & ~0xffffffffn : 0n) | vector(values, 32);
                      await execute(cpu, code, input(), raw, expected, csr);
                    }
                  memory(cpu, 0x1000n, code);
                });
              }
      },
    },
    {
      name: 'floating raw logic and unpack preserve signalling NaN bits and MXCSR in register memory and same-bank forms',
      async run() {
        const a = 0x7f800001ffc000227ff0000000000001n,
          b = 0xff8000447fc000557ff8000000000066n;
        for (const p of profiles)
          for (const [prefix, width] of [
            ['', 32],
            ['66', 64],
          ] as const)
            for (const opcode of ['54', '55', '56', '57', '14', '15'])
              for (const form of ['register', 'alias', 'memory'] as const) {
                const dst = p.mode === 'long64' ? 8 : 0,
                  src = form === 'alias' ? dst : p.mode === 'long64' ? 15 : 1,
                  address16 = p.mode !== 'long64' && !p.code32,
                  at = 0x6000n,
                  rex = p.mode === 'long64' ? (form === 'memory' ? '44' : '45') : '',
                  rm =
                    form === 'memory'
                      ? address16
                        ? '07'
                        : '00'
                      : form === 'alias'
                        ? 'c0'
                        : p.mode === 'long64'
                          ? 'c7'
                          : 'c1',
                  code = prefix + rex + '0f' + opcode + rm;
                await using(
                  compiler,
                  code,
                  execution(p),
                  async (cpu) => {
                    for (const csr of [0, 0xffff]) {
                      const raw = banks();
                      raw[dst] = a;
                      if (form !== 'alias') raw[src] = b;
                      const rhs = form === 'alias' ? a : b;
                      let value: bigint;
                      if (opcode === '54') value = a & rhs;
                      else if (opcode === '55') value = ~a & rhs & MASK128;
                      else if (opcode === '56') value = a | rhs;
                      else if (opcode === '57') value = a ^ rhs;
                      else {
                        const x = lanes(a, width),
                          y = lanes(rhs, width),
                          start = opcode === '14' ? 0 : x.length / 2;
                        value = vector(
                          x
                            .slice(start, start + x.length / 2)
                            .flatMap((lane, i) => [lane, y[start + i]!]),
                          width,
                        );
                      }
                      const expected = raw.slice();
                      expected[dst] = value;
                      await execute(
                        cpu,
                        code,
                        input(0x1000n, { [address16 ? 3 : 0]: at }),
                        raw,
                        expected,
                        csr,
                      );
                      if (form === 'memory')
                        memory(cpu, at - 3n, 'a5'.repeat(3) + bytes(b) + '5a'.repeat(3));
                    }
                  },
                  form === 'memory'
                    ? {
                        data: [
                          { base: at - 3n, bytes: 'a5'.repeat(3) + bytes(b) + '5a'.repeat(3) },
                        ],
                      }
                    : {},
                );
              }
      },
    },
    {
      name: 'floating raw half moves preserve the opposite half with exact unaligned eight-byte accesses and aliases',
      async run() {
        const a = 0x7f800001ffc000227ff0000000000001n,
          b = 0xff8000447fc000557ff8000000000066n,
          lowMask = (1n << 64n) - 1n;
        for (const p of profiles)
          for (const prefix of ['', '66'])
            for (const high of [false, true])
              for (const store of [false, true]) {
                const dst = p.mode === 'long64' ? 8 : 0,
                  address16 = p.mode !== 'long64' && !p.code32,
                  at = 0x6001n,
                  code =
                    prefix +
                    (p.mode === 'long64' ? '44' : '') +
                    '0f' +
                    (high ? (store ? '17' : '16') : store ? '13' : '12') +
                    (address16 ? '07' : '00');
                const frame = 'a5'.repeat(3) + bytes(b, 8) + '5a'.repeat(3);
                await using(
                  compiler,
                  code,
                  execution(p),
                  async (cpu) => {
                    for (const csr of [0, 0xffff]) {
                      const raw = banks();
                      raw[dst] = a;
                      const expected = raw.slice();
                      if (!store)
                        expected[dst] = high
                          ? (a & lowMask) | ((b & lowMask) << 64n)
                          : (a & ~lowMask) | (b & lowMask);
                      const result = await execute(
                        cpu,
                        code,
                        input(0x1000n, { [address16 ? 3 : 0]: at }),
                        raw,
                        expected,
                        csr,
                      );
                      equal(result.resources.nativeEntries, 1, 'half move native entry');
                      memory(
                        cpu,
                        at - 3n,
                        'a5'.repeat(3) +
                          (store ? bytes(high ? a >> 64n : a, 8) : bytes(b, 8)) +
                          '5a'.repeat(3),
                      );
                    }
                  },
                  { data: [{ base: at - 3n, bytes: frame }] },
                );
              }
        for (const p of profiles)
          for (const high of [false, true])
            for (const alias of [false, true]) {
              const dst = p.mode === 'long64' ? 8 : 0,
                src = alias ? dst : p.mode === 'long64' ? 15 : 1,
                code =
                  (p.mode === 'long64' ? '45' : '') +
                  '0f' +
                  (high ? '16' : '12') +
                  (alias ? 'c0' : p.mode === 'long64' ? 'c7' : 'c1');
              await using(compiler, code, execution(p), async (cpu) => {
                const raw = banks();
                raw[dst] = a;
                if (!alias) raw[src] = b;
                const rhs = raw[src]!,
                  expected = raw.slice();
                expected[dst] = high
                  ? (a & lowMask) | ((rhs & lowMask) << 64n)
                  : (a & ~lowMask) | (rhs >> 64n);
                await execute(cpu, code, input(), raw, expected, 0xffff);
              });
            }
      },
    },
  ];
}
