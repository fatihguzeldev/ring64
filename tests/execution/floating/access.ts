import { createCpu } from '../../../host/index.js';
import { LIMITS, equal, fault, hex, memory } from '../../support/fixture.js';
import {
  LONG,
  MASK128,
  banks,
  bytes,
  changed,
  context,
  input,
  mxcsr,
  noFault,
  outcome,
  profiles,
  using,
  vector,
  xmm,
  type Scenario,
} from './fixture.js';

const rx = { read: true, write: false, execute: true },
  rw = { read: true, write: true, execute: false };
const repeat = (value: bigint, bits: number) => vector(Array<bigint>(128 / bits).fill(value), bits);
const packed = [
  {
    name: 'ADDPS',
    head: '0f58',
    old: repeat(0x3f800000n, 32),
    source: repeat(0x40000000n, 32),
    result: repeat(0x40400000n, 32),
    status: 0,
  },
  {
    name: 'ADDPD',
    head: '660f58',
    old: repeat(0x3ff0000000000000n, 64),
    source: repeat(0x4000000000000000n, 64),
    result: repeat(0x4008000000000000n, 64),
    status: 0,
  },
  {
    name: 'overflow MULPS',
    head: '0f59',
    old: repeat(0x7f7fffffn, 32),
    source: repeat(0x40000000n, 32),
    result: repeat(0x7f800000n, 32),
    status: 0x28,
  },
  {
    name: 'invalid ADDPS',
    head: '0f58',
    old: repeat(0x3f800000n, 32),
    source: vector([0x7f800001n, 0x40000000n, 0x40000000n, 0x40000000n], 32),
    result: vector([0x7fc00001n, 0x40400000n, 0x40400000n, 0x40400000n], 32),
    status: 1,
  },
  {
    name: 'CVTPD2PS upper-zero',
    head: '660f5a',
    old: MASK128,
    source: vector([0x3ff8000000000000n, 0x4004000000000000n], 64),
    result: vector([0x3fc00000n, 0x40200000n, 0n, 0n], 32),
    status: 0,
  },
  {
    name: 'CVTPD2DQ upper-zero',
    head: 'f20fe6',
    old: MASK128,
    source: vector([0x3ff0000000000000n, 0x4000000000000000n], 64),
    result: vector([1n, 2n, 0n, 0n], 32),
    status: 0,
  },
  {
    name: 'CVTDQ2PS',
    head: '0f5b',
    old: MASK128,
    source: vector([-1n, 0n, 1n, 2n], 32),
    result: vector([0xbf800000n, 0n, 0x3f800000n, 0x40000000n], 32),
    status: 0,
  },
  {
    name: 'CVTPS2DQ',
    head: '660f5b',
    old: MASK128,
    source: vector([0x3f800000n, 0x40000000n, 0x40400000n, 0x40800000n], 32),
    result: vector([1n, 2n, 3n, 4n], 32),
    status: 0,
  },
  {
    name: 'CMPPS',
    head: '0fc2',
    tail: '01',
    old: repeat(0x3f800000n, 32),
    source: repeat(0x40000000n, 32),
    result: MASK128,
    status: 0,
  },
];
interface Narrow {
  head: string;
  width: number;
  source: bigint;
  old?: bigint;
  result?: bigint;
  resultBytes?: number;
  gpr?: bigint;
  wide?: boolean;
  flags?: bigint;
  status?: number;
  tail?: string;
}
const narrow: Narrow[] = [
  {
    head: 'f30f58',
    width: 4,
    source: 0x40000000n,
    old: 0x3f800000n,
    result: 0x40400000n,
    resultBytes: 4,
  },
  {
    head: 'f20f58',
    width: 8,
    source: 0x4000000000000000n,
    old: 0x3ff0000000000000n,
    result: 0x4008000000000000n,
    resultBytes: 8,
  },
  { head: 'f30f51', width: 4, source: 0x40800000n, result: 0x40000000n, resultBytes: 4 },
  {
    head: 'f20f51',
    width: 8,
    source: 0x4010000000000000n,
    result: 0x4000000000000000n,
    resultBytes: 8,
  },
  { head: 'f30f5a', width: 4, source: 0x3fc00000n, result: 0x3ff8000000000000n, resultBytes: 8 },
  { head: 'f20f5a', width: 8, source: 0x3ff8000000000000n, result: 0x3fc00000n, resultBytes: 4 },
  {
    head: '0f5a',
    width: 8,
    source: 0x400000003f800000n,
    result: 0x40000000000000003ff0000000000000n,
    resultBytes: 16,
  },
  {
    head: 'f30fe6',
    width: 8,
    source: 0x00000002ffffffffn,
    result: 0x4000000000000000bff0000000000000n,
    resultBytes: 16,
  },
  { head: 'f30f2a', width: 4, source: 7n, result: 0x40e00000n, resultBytes: 4 },
  { head: 'f20f2a', width: 4, source: 0xfffffff9n, result: 0xc01c000000000000n, resultBytes: 8 },
  {
    head: 'f3480f2a',
    width: 8,
    source: 0x100000001n,
    result: 0x4f800000n,
    resultBytes: 4,
    wide: true,
    status: 0x20,
  },
  {
    head: 'f2480f2a',
    width: 8,
    source: 0x100000001n,
    result: 0x41f0000000100000n,
    resultBytes: 8,
    wide: true,
  },
  { head: 'f30f2c', width: 4, source: 0xc0e00000n, gpr: 0xfffffff9n },
  { head: 'f2480f2c', width: 8, source: 0xc01c000000000000n, gpr: 0xfffffffffffffff9n, wide: true },
  { head: '0f2f', width: 4, source: 0x40000000n, old: 0x3f800000n, flags: 0x403n },
  {
    head: '660f2e',
    width: 8,
    source: 0x4000000000000000n,
    old: 0x3ff0000000000000n,
    flags: 0x403n,
  },
  {
    head: 'f30fc2',
    tail: '00',
    width: 4,
    source: 0x40000000n,
    old: 0x3f800000n,
    result: 0n,
    resultBytes: 4,
  },
  {
    head: 'f20fc2',
    tail: '00',
    width: 8,
    source: 0x4000000000000000n,
    old: 0x3ff0000000000000n,
    result: 0n,
    resultBytes: 8,
  },
  { head: 'f30f53', width: 4, source: 0x40800000n, result: 0x3e800000n, resultBytes: 4 },
  { head: 'f30f52', width: 4, source: 0x40800000n, result: 0x3f000000n, resultBytes: 4 },
];
function oldBanks(row: Narrow) {
  const raw = banks();
  if (row.old !== undefined) {
    const mask = (1n << BigInt(row.width * 8)) - 1n;
    raw[0] = (raw[0]! & ~mask) | row.old;
  }
  return raw;
}
export function accessScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'floating m128 sources preflight every byte with read-only permission and complete numeric or upper-zeroing results',
      async run() {
        for (const row of packed)
          for (const read of [false, true])
            for (const write of [false, true])
              for (let bad = 0; bad < 16; bad++) {
                const code = row.head + '00' + (row.tail ?? ''),
                  frame = 'a5'.repeat(3) + bytes(row.source) + '5a'.repeat(3);
                const cpu = await createCpu({
                  compiler,
                  context: LONG,
                  entry: 0x1000n,
                  memory: {
                    backings: [
                      { id: 'code', bytes: hex(code) },
                      { id: 'data', bytes: hex(frame) },
                    ],
                    mappings: [
                      {
                        base: 0x1000n,
                        backing: 'code',
                        offset: 0,
                        length: code.length / 2,
                        permissions: rx,
                      },
                      { base: 0x7000n, backing: 'data', offset: 0, length: 22, permissions: rx },
                      ...Array.from({ length: 16 }, (_, i) => ({
                        base: 0x6000n + BigInt(i),
                        backing: 'data',
                        offset: 3 + i,
                        length: 1,
                        permissions: i === bad ? { read, write, execute: false } : rw,
                      })),
                    ],
                  },
                  memoryLimits: {
                    maxBackings: 2,
                    maxMappings: 18,
                    maxBackingBytes: code.length / 2 + 22,
                  },
                  limits: LIMITS,
                });
                try {
                  const raw = banks(),
                    before = input(0x1000n, { 0: 0x6000n }, 0xcd7n);
                  raw[0] = row.old;
                  const expected = raw.slice();
                  if (read) expected[0] = row.result;
                  cpu.setState(before);
                  cpu.setXmmState(raw);
                  cpu.setMxcsr(0x1f80);
                  const result = await cpu.run({ budget: 1n, repeatBudget: 7n });
                  outcome(
                    result,
                    read ? 'budget' : 'data-fault',
                    1n,
                    read ? 1n : 0n,
                    7n,
                    0n,
                    read ? changed(before, 0x1000n + BigInt(code.length / 2)) : before,
                  );
                  xmm(cpu, expected);
                  mxcsr(cpu, 0x1f80 | (read ? row.status : 0));
                  memory(cpu, 0x7000n, frame);
                  if (read) noFault(result);
                  else {
                    fault(result, {
                      instructionPc: 0x1000n,
                      address: 0x6000n,
                      width: 16,
                      access: 'read',
                      cause: 'permission',
                      failingAddress: 0x6000n + BigInt(bad),
                      segment: 'ds',
                    });
                    equal(result.simdException, undefined, 'permission precedes numeric status');
                    equal(result.generalProtectionFault, undefined, 'exclusive memory fault');
                    equal(result.alignmentFault, undefined, 'aligned source');
                  }
                } finally {
                  cpu.dispose();
                }
              }
      },
    },
    {
      name: 'floating every missing m128 source byte suppresses unmasked arithmetic and conversion publication',
      async run() {
        for (const row of packed)
          for (let available = 0; available < 16; available++) {
            const code = row.head + '00' + (row.tail ?? '');
            await using(
              compiler,
              code,
              LONG,
              async (cpu) => {
                const raw = banks(),
                  before = input(0x1000n, { 0: 0x6000n }, 0xcd7n);
                raw[0] = row.old;
                cpu.setState(before);
                cpu.setXmmState(raw);
                cpu.setMxcsr(0);
                const result = await cpu.run({ budget: 1n, repeatBudget: 3n });
                outcome(result, 'data-fault', 1n, 0n, 3n, 0n, before);
                fault(result, {
                  instructionPc: 0x1000n,
                  address: 0x6000n,
                  width: 16,
                  access: 'read',
                  cause: 'unmapped',
                  failingAddress: 0x6000n + BigInt(available),
                  segment: 'ds',
                });
                xmm(cpu, raw);
                mxcsr(cpu, 0);
                equal(result.simdException, undefined, 'late source fault suppresses IE/OE/PE');
                equal(result.generalProtectionFault, undefined, 'no control fault');
                equal(result.alignmentFault, undefined, 'aligned source');
                if (available) memory(cpu, 0x6000n, bytes(row.source).slice(0, available * 2));
              },
              {
                data: available
                  ? [{ base: 0x6000n, bytes: bytes(row.source).slice(0, available * 2) }]
                  : [],
              },
            );
          }
      },
    },
    {
      name: 'floating narrow arithmetic and conversions use exact unaligned m32 or m64 spans across every mode and address-size grammar',
      async run() {
        for (const p of profiles)
          for (const override of [false, true])
            for (const row of narrow) {
              if (row.wide && p.mode !== 'long64') continue;
              const execution = p.mode === 'long64' ? LONG : context(p.mode, p.code32, p.stack32),
                address16 = p.mode !== 'long64' && p.code32 === override,
                base = address16 ? 3 : 0;
              const code =
                (override ? '67' : '') + row.head + (address16 ? '07' : '00') + (row.tail ?? '');
              await using(
                compiler,
                code,
                execution,
                async (cpu) => {
                  const before = input(
                      0x1000n,
                      { [base]: p.mode === 'long64' && !override ? 0x6001n : 0x1122334400006001n },
                      0xcd7n,
                    ),
                    raw = oldBanks(row),
                    expected = raw.slice();
                  const updates: Record<number, bigint> = {};
                  if (row.result !== undefined) {
                    const mask = (1n << BigInt(row.resultBytes! * 8)) - 1n;
                    expected[0] = (raw[0]! & ~mask) | row.result;
                  }
                  if (row.gpr !== undefined)
                    updates[0] =
                      row.wide || p.mode === 'long64'
                        ? row.gpr
                        : (before.registers[0]! & ~0xffffffffn) | row.gpr;
                  cpu.setState(before);
                  cpu.setXmmState(raw);
                  cpu.setMxcsr(0x1f80);
                  const result = await cpu.run({ budget: 1n, repeatBudget: 7n });
                  outcome(
                    result,
                    'budget',
                    1n,
                    1n,
                    7n,
                    0n,
                    changed(
                      before,
                      0x1000n + BigInt(code.length / 2),
                      updates,
                      row.flags ?? before.flags,
                    ),
                  );
                  noFault(result);
                  xmm(cpu, expected);
                  mxcsr(cpu, 0x1f80 | (row.status ?? 0));
                  memory(cpu, 0x6001n, bytes(row.source, row.width));
                },
                {
                  data: [
                    {
                      base: 0x6001n,
                      bytes: bytes(row.source, row.width),
                      read: true,
                      write: false,
                    },
                  ],
                },
              );
            }
      },
    },
    {
      name: 'floating narrow source faults preserve nonzero upper destinations and every original integer bank',
      async run() {
        for (const row of narrow)
          for (let available = 0; available < row.width; available++) {
            const code = row.head + '00' + (row.tail ?? '');
            await using(
              compiler,
              code,
              LONG,
              async (cpu) => {
                const before = input(0x1000n, { 0: 0x6001n }, 0xcd7n),
                  raw = oldBanks(row);
                cpu.setState(before);
                cpu.setXmmState(raw);
                cpu.setMxcsr(0x1fa5);
                const result = await cpu.run({ budget: 1n, repeatBudget: 7n });
                outcome(result, 'data-fault', 1n, 0n, 7n, 0n, before);
                fault(result, {
                  instructionPc: 0x1000n,
                  address: 0x6001n,
                  width: row.width,
                  access: 'read',
                  cause: 'unmapped',
                  failingAddress: 0x6001n + BigInt(available),
                  segment: 'ds',
                });
                xmm(cpu, raw);
                mxcsr(cpu, 0x1fa5);
                equal(result.simdException, undefined, 'memory fault excludes numeric');
                equal(result.generalProtectionFault, undefined, 'memory fault excludes GP');
                if (available)
                  memory(cpu, 0x6001n, bytes(row.source, row.width).slice(0, available * 2));
              },
              {
                data: available
                  ? [{ base: 0x6001n, bytes: bytes(row.source, row.width).slice(0, available * 2) }]
                  : [],
              },
            );
          }
      },
    },
    {
      name: 'floating raw half loads use read-only exact m64 spans and preserve the other half in every address grammar',
      async run() {
        for (const p of profiles)
          for (const override of [false, true])
            for (const prefix of ['', '66'])
              for (const high of [false, true])
                for (const read of [false, true]) {
                  const execution =
                      p.mode === 'long64' ? LONG : context(p.mode, p.code32, p.stack32),
                    address16 = p.mode !== 'long64' && p.code32 === override,
                    base = address16 ? 3 : 0;
                  const code =
                    (override ? '67' : '') +
                    prefix +
                    '0f' +
                    (high ? '16' : '12') +
                    (address16 ? '07' : '00');
                  await using(
                    compiler,
                    code,
                    execution,
                    async (cpu) => {
                      const raw = banks(),
                        before = input(
                          0x1000n,
                          {
                            [base]:
                              p.mode === 'long64' && !override ? 0x6001n : 0x1122334400006001n,
                          },
                          0xcd7n,
                        ),
                        expected = raw.slice(),
                        source = 0x0123456789abcdefn;
                      if (read)
                        expected[0] = high
                          ? (raw[0]! & 0xffffffffffffffffn) | (source << 64n)
                          : (raw[0]! & ~0xffffffffffffffffn) | source;
                      cpu.setState(before);
                      cpu.setXmmState(raw);
                      cpu.setMxcsr(0xffff);
                      const result = await cpu.run({ budget: 1n, repeatBudget: 3n });
                      outcome(
                        result,
                        read ? 'budget' : 'data-fault',
                        1n,
                        read ? 1n : 0n,
                        3n,
                        0n,
                        read ? changed(before, 0x1000n + BigInt(code.length / 2)) : before,
                      );
                      xmm(cpu, expected);
                      mxcsr(cpu, 0xffff);
                      if (read) {
                        noFault(result);
                        memory(cpu, 0x6001n, bytes(source, 8));
                      } else {
                        fault(result, {
                          instructionPc: 0x1000n,
                          address: 0x6001n,
                          width: 8,
                          access: 'read',
                          cause: 'permission',
                          failingAddress: 0x6001n,
                          segment: 'ds',
                        });
                        equal(result.simdException, undefined, 'raw source has no numeric effect');
                      }
                    },
                    {
                      data: [
                        { base: 0x6001n, bytes: bytes(0x0123456789abcdefn, 8), read, write: false },
                      ],
                    },
                  );
                }
      },
    },
    {
      name: 'floating half stores copy the selected captured half to write-only memory without touching guards or MXCSR',
      async run() {
        for (const prefix of ['', '66'])
          for (const high of [false, true])
            for (const read of [false, true])
              for (const write of [false, true]) {
                const code = prefix + '0f' + (high ? '17' : '13') + '00',
                  frame = 'a5'.repeat(3) + '00'.repeat(8) + '5a'.repeat(3);
                const cpu = await createCpu({
                  compiler,
                  context: LONG,
                  entry: 0x1000n,
                  memory: {
                    backings: [
                      { id: 'code', bytes: hex(code) },
                      { id: 'data', bytes: hex(frame) },
                    ],
                    mappings: [
                      {
                        base: 0x1000n,
                        backing: 'code',
                        offset: 0,
                        length: code.length / 2,
                        permissions: rx,
                      },
                      {
                        base: 0x6001n,
                        backing: 'data',
                        offset: 3,
                        length: 8,
                        permissions: { read, write, execute: false },
                      },
                      { base: 0x7000n, backing: 'data', offset: 0, length: 14, permissions: rx },
                    ],
                  },
                  memoryLimits: {
                    maxBackings: 2,
                    maxMappings: 3,
                    maxBackingBytes: code.length / 2 + 14,
                  },
                  limits: LIMITS,
                });
                try {
                  const raw = banks(),
                    before = input(0x1000n, { 0: 0x6001n }, 0xcd7n);
                  cpu.setState(before);
                  cpu.setXmmState(raw);
                  cpu.setMxcsr(0xffff);
                  const result = await cpu.run({ budget: 1n, repeatBudget: 7n });
                  outcome(
                    result,
                    write ? 'budget' : 'data-fault',
                    1n,
                    write ? 1n : 0n,
                    7n,
                    0n,
                    write ? changed(before, 0x1000n + BigInt(code.length / 2)) : before,
                  );
                  xmm(cpu, raw);
                  mxcsr(cpu, 0xffff);
                  if (write) noFault(result);
                  else
                    fault(result, {
                      instructionPc: 0x1000n,
                      address: 0x6001n,
                      width: 8,
                      access: 'write',
                      cause: 'permission',
                      failingAddress: 0x6001n,
                      segment: 'ds',
                    });
                  memory(
                    cpu,
                    0x7000n,
                    'a5'.repeat(3) +
                      (write ? bytes(high ? raw[0]! >> 64n : raw[0]!, 8) : '00'.repeat(8)) +
                      '5a'.repeat(3),
                  );
                } finally {
                  cpu.dispose();
                }
              }
      },
    },
    {
      name: 'floating aligned packed sources use translated FS starts and retain full-span diagnostics at competing boundaries',
      async run() {
        for (const [offset, reason, cause] of [
          [0x600fn, 'budget', ''],
          [0x6000n, 'alignment-fault', ''],
          [0x7ffffffffff8n, 'data-fault', 'noncanonical'],
        ] as const) {
          const execution = { mode: 'long64' as const, fsBase: 1n, gsBase: 0n },
            address = offset + 1n;
          await using(
            compiler,
            '640f5800',
            execution,
            async (cpu) => {
              const before = input(0x1000n, { 0: offset }, 0xcd7n),
                raw = banks(),
                expected = raw.slice();
              raw[0] = repeat(0x3f800000n, 32);
              expected[0] = reason === 'budget' ? repeat(0x40000000n, 32) : raw[0]!;
              cpu.setState(before);
              cpu.setXmmState(raw);
              cpu.setMxcsr(0);
              const result = await cpu.run({ budget: 1n, repeatBudget: 3n });
              outcome(
                result,
                reason,
                1n,
                reason === 'budget' ? 1n : 0n,
                3n,
                0n,
                reason === 'budget' ? changed(before, 0x1004n) : before,
              );
              xmm(cpu, expected);
              mxcsr(cpu, 0);
              if (reason === 'budget') noFault(result);
              else if (reason === 'alignment-fault') {
                const expectedFault = {
                  instructionPc: 0x1000n,
                  segment: 'fs',
                  offset,
                  address,
                  width: 16,
                  access: 'read',
                  alignment: 16,
                };
                for (const key of Object.keys(expectedFault) as (keyof typeof expectedFault)[])
                  equal(result.alignmentFault?.[key], expectedFault[key], `alignment ${key}`);
                equal(result.fault, undefined, 'exclusive alignment');
                equal(result.segmentFault, undefined, 'exclusive alignment segment');
              } else
                fault(result, {
                  instructionPc: 0x1000n,
                  address,
                  width: 16,
                  access: 'read',
                  cause,
                  failingAddress: 0x800000000000n,
                  segment: 'fs',
                });
              equal(result.simdException, undefined, 'address authority precedes numeric effects');
              equal(result.generalProtectionFault, undefined, 'no control payload');
            },
            { data: [{ base: 0x6010n, bytes: bytes(repeat(0x3f800000n, 32)) }] },
          );
        }
      },
    },
  ];
}
