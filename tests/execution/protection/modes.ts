import type { Cpu, ExecutionContextSnapshot } from '../../../host/index.js';
import { changed, equal, hex, initial, snapshot, state, using, type Scenario } from './fixture.js';

export function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) => {
    if (typeof v === 'bigint') return v.toString(16);
    if (v !== null && typeof v === 'object' && !Array.isArray(v))
      return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)));
    return v;
  });
}
export function bytes(value: bigint, width: number): string {
  return Array.from({ length: width }, (_, i) =>
    Number((value >> BigInt(i * 8)) & 255n)
      .toString(16)
      .padStart(2, '0'),
  ).join('');
}
export function addressPrefix(execution: ExecutionContextSnapshot): string {
  return execution.mode === 'long64' || execution.segments.cs.default32 ? '' : '67';
}
export function operandPrefix(execution: ExecutionContextSnapshot, width: number): string {
  if (width === 64) return '48';
  const normal = execution.mode === 'long64' || execution.segments.cs.default32 ? 32 : 16;
  return normal === width ? '' : '66';
}
export function profiles(): ExecutionContextSnapshot[] {
  const result: ExecutionContextSnapshot[] = [];
  for (const mode of ['real', 'protected', 'compatibility'] as const)
    for (const code32 of [false, true])
      for (const stack32 of [false, true]) {
        const execution = snapshot(mode);
        execution.segments.cs.default32 = code32;
        execution.segments.ss.default32 = stack32;
        result.push(execution);
      }
  result.push(snapshot('virtual8086'), snapshot());
  return result;
}
export function preserveNumeric(cpu: Cpu): () => void {
  cpu.setXmmState(
    Array.from({ length: 16 }, (_, i) => (BigInt(i + 1) << 112n) | 0xfedcba9876543210n),
  );
  cpu.setMxcsr(0xffc5);
  cpu.setX87State({
    registers: Array.from({ length: 8 }, (_, i) => (BigInt(i + 1) << 64n) | 0x123456789abcdef0n),
    controlWord: 0x37e,
    statusWord: 0x8081,
    tagWord: 0xffff,
    instructionPointer: 0x1122334455667788n,
    dataPointer: 0x8877665544332211n,
    opcode: 0x5a5,
  });
  const expected = fingerprint([cpu.readXmmState(), cpu.readMxcsr(), cpu.readX87State()]);
  return () =>
    equal(
      fingerprint([cpu.readXmmState(), cpu.readMxcsr(), cpu.readX87State()]),
      expected,
      'all raw numeric banks/pending state',
    );
}

export function modeScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'protection SGDT SIDT store exact pseudo descriptors in all fourteen profiles',
      async run() {
        const matrix = profiles();
        equal(matrix.length, 14, 'profile count');
        for (const execution of matrix) {
          const long = execution.mode === 'long64',
            ia32e = long || execution.mode === 'compatibility';
          execution.gdtr = { base: ia32e ? 0x123456789abcn : 0x12345678n, limit: 0x1234 };
          execution.idtr = { base: ia32e ? 0x23456789abcdn : 0x23456789n, limit: 0xabcd };
          const prefix = addressPrefix(execution),
            code = prefix + '0f0103' + prefix + '0f014b10';
          await using(
            compiler,
            code,
            execution,
            async (cpu) => {
              const before = initial(0x1000n, { 3: 0x6000n }, 0xcd7n),
                numeric = preserveNumeric(cpu);
              cpu.setState(before);
              const zero = await cpu.run({ budget: 0n });
              equal(zero.retired, 0n, 'zero budget has no store');
              equal(fingerprint(cpu.readContext()), fingerprint(execution), 'zero budget context');
              equal(
                fingerprint(cpu.readMemory(0x6000n, 40)),
                fingerprint(hex('cc'.repeat(40))),
                'zero budget memory',
              );
              const result = await cpu.run({ budget: 2n });
              equal(result.reason, 'budget', 'store completion');
              equal(result.retired, 2n, 'two table stores');
              state(result.state, changed(before, 0x1000n + BigInt(code.length / 2)));
              const expected = hex('cc'.repeat(40)),
                width = long ? 8 : 4;
              expected.set(hex(bytes(0x1234n, 2) + bytes(execution.gdtr.base, width)), 0);
              expected.set(hex(bytes(0xabcdn, 2) + bytes(execution.idtr.base, width)), 16);
              equal(
                fingerprint(cpu.readMemory(0x6000n, 40)),
                fingerprint(expected),
                'exact fields and neighboring bytes',
              );
              equal(
                fingerprint(cpu.readContext()),
                fingerprint(execution),
                'stores do not change roots/caches',
              );
              numeric();
            },
            { data: [{ base: 0x6000n, bytes: 'cc'.repeat(40) }] },
          );
        }
      },
    },
    {
      name: 'protection LGDT LIDT use legacy24 and32 bit bases and fixed long64 ten byte operands',
      async run() {
        for (const execution of profiles())
          for (const width of [16, 32]) {
            const long = execution.mode === 'long64';
            const prefix = operandPrefix(execution, width) + addressPrefix(execution);
            const code = prefix + '0f0113' + prefix + '0f015b10';
            const base = long ? 0x123456789abcn : 0xa1b2c3d4n,
              other = long ? 0x23456789abcdn : 0x9a8b7c6dn;
            const data = hex('cc'.repeat(40));
            data.set(hex(bytes(0x1234n, 2) + bytes(base, long ? 8 : 4)), 0);
            data.set(hex(bytes(0xabcdn, 2) + bytes(other, long ? 8 : 4)), 16);
            const source = Array.from(data, (b) => b.toString(16).padStart(2, '0')).join('');
            await using(
              compiler,
              code,
              execution,
              async (cpu) => {
                const before = initial(0x1000n, { 3: 0x6000n }, 0xcd7n),
                  numeric = preserveNumeric(cpu);
                cpu.setState(before);
                const result = await cpu.run({ budget: 2n });
                if (execution.mode === 'virtual8086') {
                  equal(result.reason, 'protection-fault', 'V86 privilege rejection');
                  equal(result.retired, 0n, 'no privileged retirement');
                  equal(result.protectionFault?.phase, 'privilege', 'privilege before operand');
                  state(result.state, before);
                  equal(
                    fingerprint(cpu.readContext()),
                    fingerprint(execution),
                    'no roots on failure',
                  );
                } else {
                  equal(result.reason, 'budget', 'load completion');
                  equal(result.retired, 2n, 'two table loads');
                  const expected = structuredClone(execution),
                    mask = long ? (1n << 64n) - 1n : width === 16 ? 0xffffffn : 0xffffffffn;
                  expected.gdtr = { base: base & mask, limit: 0x1234 };
                  expected.idtr = { base: other & mask, limit: 0xabcd };
                  equal(
                    fingerprint(cpu.readContext()),
                    fingerprint(expected),
                    'new roots with old loaded caches',
                  );
                  state(result.state, changed(before, 0x1000n + BigInt(code.length / 2)));
                }
                equal(
                  fingerprint(cpu.readMemory(0x6000n, 40)),
                  fingerprint(data),
                  'source bytes untouched',
                );
                numeric();
              },
              { data: [{ base: 0x6000n, bytes: source, write: false }] },
            );
          }
      },
    },
    {
      name: 'protection dirty MOV selector producers and real V86 reload cache preservation cover fourteen profiles',
      async run() {
        for (const original of profiles()) {
          const real = original.mode === 'real' || original.mode === 'virtual8086';
          for (const selector of real ? [0, 0x31] : [8]) {
            const execution = structuredClone(original);
            if (execution.mode === 'real') {
              execution.segments.ds.base = 0x76540000n;
              execution.segments.ds.limit = 0x12345678;
              execution.segments.ds.type = 'expand-down-read-only';
              execution.segments.ds.usable = false;
              execution.segments.ds.default32 = true;
              execution.segments.ds.available = true;
            }
            const prefix = operandPrefix(execution, 16);
            const code = prefix + 'b8' + bytes(BigInt(selector), 2) + '8ed8' + prefix + '8cd9';
            await using(
              compiler,
              code,
              execution,
              async (cpu) => {
                const before = initial(0x1000n, {}, 0xcd7n),
                  numeric = preserveNumeric(cpu);
                cpu.setState(before);
                const result = await cpu.run({ budget: 3n });
                equal(result.reason, 'budget', 'selector moves');
                equal(result.retired, 3n, 'producer load and read');
                const merge = (bank: bigint) => (bank & ~0xffffn) | BigInt(selector);
                state(
                  result.state,
                  changed(before, 0x1000n + BigInt(code.length / 2), {
                    0: merge(before.registers[0]!),
                    1: merge(before.registers[1]!),
                  }),
                );
                const expected = structuredClone(execution);
                if (real) {
                  expected.segments.ds.selector = selector;
                  expected.segments.ds.base = BigInt(selector) << 4n;
                } else
                  expected.segments.ds = {
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
                equal(
                  fingerprint(cpu.readContext()),
                  fingerprint(expected),
                  'literal loaded cache and all preserved fields',
                );
                numeric();
              },
              { data: real ? [] : [{ base: 0x4008n, bytes: 'ffff007000930000', write: false }] },
            );
          }
        }
      },
    },
  ];
}
