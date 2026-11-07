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
import { floatConversion, floatToInt, intToFloat } from './conversion-reference.js';
import { patterns } from './arithmetic.js';
import { type Format } from './reference.js';

type Row = {
  name: string;
  code: string;
  source: Format | 'int';
  target: Format | 'int';
  scalar: boolean;
  truncation?: boolean;
};
const rows: Row[] = [
  { name: 'CVTPS2PD', code: '0f5ac1', source: 32, target: 64, scalar: false },
  { name: 'CVTPD2PS', code: '660f5ac1', source: 64, target: 32, scalar: false },
  { name: 'CVTSS2SD', code: 'f30f5ac1', source: 32, target: 64, scalar: true },
  { name: 'CVTSD2SS', code: 'f20f5ac1', source: 64, target: 32, scalar: true },
  { name: 'CVTDQ2PS', code: '0f5bc1', source: 'int', target: 32, scalar: false },
  { name: 'CVTDQ2PD', code: 'f30fe6c1', source: 'int', target: 64, scalar: false },
  { name: 'CVTPS2DQ', code: '660f5bc1', source: 32, target: 'int', scalar: false },
  {
    name: 'CVTTPS2DQ',
    code: 'f30f5bc1',
    source: 32,
    target: 'int',
    scalar: false,
    truncation: true,
  },
  { name: 'CVTPD2DQ', code: 'f20fe6c1', source: 64, target: 'int', scalar: false },
  {
    name: 'CVTTPD2DQ',
    code: '660fe6c1',
    source: 64,
    target: 'int',
    scalar: false,
    truncation: true,
  },
  { name: 'CVTSI2SS', code: 'f30f2ac1', source: 'int', target: 32, scalar: true },
  { name: 'CVTSI2SD', code: 'f20f2ac1', source: 'int', target: 64, scalar: true },
  { name: 'CVTSS2SI', code: 'f30f2dc1', source: 32, target: 'int', scalar: true },
  { name: 'CVTSD2SI', code: 'f20f2dc1', source: 64, target: 'int', scalar: true },
  {
    name: 'CVTTSS2SI',
    code: 'f30f2cc1',
    source: 32,
    target: 'int',
    scalar: true,
    truncation: true,
  },
  {
    name: 'CVTTSD2SI',
    code: 'f20f2cc1',
    source: 64,
    target: 'int',
    scalar: true,
    truncation: true,
  },
];
export function conversionScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'floating conversions use independent rational rounding range status and destination-width models across modes',
      async run() {
        for (const profile of profiles)
          for (const row of rows)
            for (const wide of profile.mode === 'long64' &&
            row.scalar &&
            (row.source === 'int' || row.target === 'int')
              ? [false, true]
              : [false]) {
              const code = wide ? row.code.slice(0, 2) + '48' + row.code.slice(2) : row.code,
                execution =
                  profile.mode === 'long64'
                    ? LONG
                    : context(profile.mode, profile.code32, profile.stack32),
                width = wide ? 64 : 32;
              const floatInputs =
                row.source === 'int'
                  ? []
                  : patterns(row.source).concat(
                      row.source === 32
                        ? [0xcf000000n, 0x4f000000n, 0x4f800000n, 0x3fc00000n, 0xbfc00000n]
                        : [
                            0xc1e0000000000000n,
                            0x41e0000000000000n,
                            0x41dfffffffe00000n,
                            0x43e0000000000000n,
                            0xc3e0000000000000n,
                            0x3ff8000000000000n,
                            0xbff8000000000000n,
                          ],
                    );
              const integers = wide
                ? [
                    0n,
                    1n,
                    0xffffffffffffffffn,
                    0x8000000000000000n,
                    0x7fffffffffffffffn,
                    0x0020000000000001n,
                    0xffffffffff000001n,
                  ]
                : [0n, 1n, 0xffffffffn, 0x80000000n, 0x7fffffffn, 0x01000001n, 0xfeffffffn];
              const values = row.source === 'int' ? integers : floatInputs;
              await using(compiler, code, execution, async (cpu) => {
                for (const csr of [
                  0x1f80, 0x3f80, 0x5f80, 0x7f80, 0x1fc0, 0x9f80, 0x1f00, 0x0f80, 0x1780, 0x1b80,
                ])
                  for (let sample = 0; sample < values.length; sample++) {
                    const raw = banks(),
                      sourceWidth = row.source === 'int' ? width : row.source,
                      targetWidth = row.target === 'int' ? width : row.target;
                    const count = row.scalar
                      ? 1
                      : row.source === 'int'
                        ? 128 / targetWidth
                        : row.target === 'int'
                          ? 128 / sourceWidth
                          : 2;
                    const source = vector(
                      Array.from(
                        { length: count },
                        (_, i) => values[(sample + i * 3) % values.length]!,
                      ),
                      sourceWidth,
                    );
                    raw[1] = row.scalar
                      ? (raw[1]! & ~((1n << BigInt(sourceWidth)) - 1n)) | source
                      : source;
                    const before = input(
                      0x1000n,
                      row.source === 'int' && row.scalar ? { 1: 0x9988776600000000n | source } : {},
                      0xcd7n,
                    );
                    if (wide && row.source === 'int') before.registers[1] = source;
                    const actualInput =
                      row.source === 'int' && row.scalar ? before.registers[1]! : raw[1]!;
                    const laneResults = Array.from({ length: count }, (_, i) => {
                      const x =
                        (actualInput >> BigInt(i * sourceWidth)) &
                        ((1n << BigInt(sourceWidth)) - 1n);
                      return row.source === 'int'
                        ? intToFloat(x, width, row.target as Format, csr)
                        : row.target === 'int'
                          ? floatToInt(x, row.source, width, !!row.truncation, csr)
                          : floatConversion(x, row.source, row.target, csr);
                    });
                    const pre = laneResults.reduce((f, v) => f | v.pre, 0),
                      preFault = (pre & ~(csr >>> 7) & 63) !== 0,
                      raised = preFault ? pre : laneResults.reduce((f, v) => f | v.post, pre),
                      unmasked = raised & ~(csr >>> 7) & 63,
                      afterCsr = csr | raised;
                    const expected = raw.slice();
                    let resultValue = 0n;
                    laneResults.forEach(
                      (v, i) => (resultValue |= v.bits << BigInt(i * targetWidth)),
                    );
                    const updates: Record<number, bigint> = {};
                    if (!unmasked) {
                      if (row.scalar && row.target === 'int')
                        updates[0] = wide
                          ? resultValue
                          : profile.mode === 'long64'
                            ? resultValue
                            : (before.registers[0]! & ~0xffffffffn) | resultValue;
                      else
                        expected[0] = row.scalar
                          ? (raw[0]! & ~((1n << BigInt(targetWidth)) - 1n)) | resultValue
                          : resultValue;
                    }
                    cpu.setState(before);
                    cpu.setXmmState(raw);
                    cpu.setMxcsr(csr);
                    const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
                    outcome(
                      result,
                      unmasked ? 'simd-exception' : 'budget',
                      1n,
                      unmasked ? 0n : 1n,
                      0n,
                      0n,
                      unmasked
                        ? before
                        : changed(before, 0x1000n + BigInt(code.length / 2), updates),
                    );
                    xmm(cpu, expected);
                    mxcsr(cpu, afterCsr);
                    if (unmasked)
                      simdFault(
                        result,
                        csr,
                        afterCsr,
                        raised,
                        unmasked,
                        preFault ? 'pre-computation' : 'post-computation',
                      );
                    else noFault(result);
                    if (csr !== 0x1f80 || sample !== 0)
                      equal(result.resources.compilations, 0, `${row.name} cached control input`);
                  }
              });
            }
      },
    },
  ];
}
