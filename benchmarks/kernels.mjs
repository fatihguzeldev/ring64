import { x87Rows } from './x87.mjs';
import { numericStateRows } from './numeric-state.mjs';
import { streamingRows } from './streaming.mjs';

const MASK64 = (1n << 64n) - 1n;
const MASK128 = (1n << 128n) - 1n;
const FLAGS = 0xcd7n;
const CODE = 0x1000n;
const RAM = 0x4000n;
const limits = {
  maxInstructions: 128,
  maxSourceBytes: 2048,
  maxArtifactBytes: 262144,
  maxCachedArtifacts: 32,
  maxCachedBytes: 4194304,
  maxTranslationsPerRun: 32,
};
const hex = (s) => Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
const pack = (values, width) =>
  values.reduce((v, x, i) => v | (BigInt(x) << BigInt(width * i)), 0n);
const little = (bytes, offset, value, width) => {
  for (let i = 0; i < width; i++) bytes[offset + i] = Number((value >> BigInt(i * 8)) & 255n);
};
const read = (bytes, offset, width) =>
  bytes.slice(offset, offset + width).reduce((v, b, i) => v | (BigInt(b) << BigInt(i * 8)), 0n);
const low32 = (old, value) => (old & ~0xffffffffn) | BigInt(value);
const low64 = (old, value) => (old & ~MASK64) | value;
const parity = (n) => {
  let bits = Number(n & 255n),
    count = 0;
  while (bits) {
    count += bits & 1;
    bits >>>= 1;
  }
  return count % 2 === 0 ? 4n : 0n;
};
const addFlags = (n) => 0x402n | parity(n) | (n % 16n === 0n ? 16n : 0n);
const incFlags = (n) => {
  const v = n & 255n;
  return (
    0x403n |
    parity(v) |
    (v % 16n === 0n ? 16n : 0n) |
    (v === 0n ? 64n : 0n) |
    (v & 128n) |
    (v === 128n ? 2048n : 0n)
  );
};
const rows = [
  ...[4, 8].map((width) => ({
    name: `checked-vector-load-low${width * 8}`,
    body: width === 4 ? 'f30f1003' : 'f20f1003',
    instructions: 1,
    expected(s) {
      s.xmm[0] = read(s.ram, 16, width);
    },
  })),
  {
    name: 'scalar-add',
    body: '4883c001',
    instructions: 1,
    factor: 5,
    setup: (s) => {
      s.gpr[0] = 0n;
    },
    expected: (s, n) => {
      s.gpr[0] = n;
      s.flags = addFlags(n);
    },
  },
  {
    name: 'checked-scalar-load',
    body: '488b03',
    instructions: 1,
    factor: 5,
    setup: (s) => little(s.ram, 16, 7n, 8),
    expected: (s) => {
      s.gpr[0] = 7n;
    },
  },
  {
    name: 'checked-byte-rmw',
    body: 'fe03',
    instructions: 1,
    factor: 5,
    setup: (s) => {
      s.ram[16] = 0;
    },
    expected: (s, n) => {
      s.ram[16] = Number(n & 255n);
      s.flags = incFlags(n);
    },
  },
  {
    name: 'stack-push-pop',
    body: '5058',
    instructions: 2,
    factor: 5,
    setup: (s) => {
      s.gpr[0] = 0x123456789abcdef0n;
      s.gpr[4] = RAM + 48n;
    },
    expected: (s) => little(s.ram, 40, s.gpr[0], 8),
  },
  {
    name: 'signed-multiply',
    body: '480fafc2',
    instructions: 1,
    factor: 5,
    flagMask: 0xc03n,
    setup: (s) => {
      s.gpr[0] = 1n;
      s.gpr[2] = 1n;
    },
    expected: (s) => {
      s.flags = 0x402n;
    },
  },
  {
    name: 'unsigned-divide',
    body: 'b86400000031d248f7f7',
    instructions: 3,
    factor: 5,
    flagMask: 0x402n,
    setup: (s) => {
      s.gpr[7] = 7n;
    },
    expected: (s) => {
      s.gpr[0] = 14n;
      s.gpr[2] = 2n;
      s.flags = 0x402n;
    },
  },
  {
    name: 'integer-qword-add',
    body: '660fd4c1',
    instructions: 1,
    setup: (s) => {
      s.xmm[1] = pack([7n, 11n], 64);
    },
    expected: (s, n) => {
      s.xmm[0] =
        (((s.xmm[0] & MASK64) + 7n * n) & MASK64) |
        ((((s.xmm[0] >> 64n) + 11n * n) & MASK64) << 64n);
    },
  },
  {
    name: 'checked-vector-load',
    body: 'f30f6f03',
    instructions: 1,
    expected: (s) => {
      s.xmm[0] = read(s.ram, 16, 16);
    },
  },
  {
    name: 'checked-vector-store-unaligned',
    body: 'f30f7f03',
    instructions: 1,
    setup: (s) => {
      s.gpr[3] = RAM + 17n;
    },
    expected: (s) => little(s.ram, 17, s.xmm[0], 16),
  },
  {
    name: 'scalar-f32-add-inexact',
    body: '660f6fc2f30f58c1',
    instructions: 2,
    setup: (s) => {
      s.xmm[2] = low32(s.xmm[2], 0x3f800000);
      s.xmm[1] = low32(s.xmm[1], 0x33800000);
    },
    expected: (s) => {
      s.xmm[0] = s.xmm[2];
      s.mxcsr = 0x1fa0;
    },
  },
  {
    name: 'packed-f32-add-exact',
    body: '660f6fc20f58c1',
    instructions: 2,
    setup: (s) => {
      s.xmm[2] = pack([0x3f800000, 0x40000000, 0x40800000, 0x41000000], 32);
      s.xmm[1] = pack(Array(4).fill(0x3f000000), 32);
    },
    expected: (s) => {
      s.xmm[0] = pack([0x3fc00000, 0x40200000, 0x40900000, 0x41080000], 32);
    },
  },
  {
    name: 'scalar-f64-sqrt',
    body: 'f20f51c1',
    instructions: 1,
    setup: (s) => {
      s.xmm[1] = low64(s.xmm[1], 0x4000000000000000n);
    },
    expected: (s) => {
      s.xmm[0] = low64(s.xmm[0], 0x3ff6a09e667f3bcdn);
      s.mxcsr = 0x1fa0;
    },
  },
  {
    name: 'signed-i64-to-f64',
    body: 'f2480f2ac2',
    instructions: 1,
    setup: (s) => {
      s.gpr[2] = 0x0020000000000001n;
    },
    expected: (s) => {
      s.xmm[0] = low64(s.xmm[0], 0x4340000000000000n);
      s.mxcsr = 0x1fa0;
    },
  },
  {
    name: 'memory-f32-to-gpr',
    body: 'f30f2c03',
    instructions: 1,
    setup: (s) => little(s.ram, 16, 0xc0e00000n, 4),
    expected: (s) => {
      s.gpr[0] = 0xfffffff9n;
    },
  },
  {
    name: 'packed-f32-reciprocal',
    body: '0f53c1',
    instructions: 1,
    setup: (s) => {
      s.xmm[1] = pack([0x3f800000, 0x40000000, 0x40800000, 0x41000000], 32);
      s.mxcsr = 0xffff;
    },
    expected: (s) => {
      s.xmm[0] = pack([0x3f800000, 0x3f000000, 0x3e800000, 0x3e000000], 32);
    },
  },
  {
    name: 'mxcsr-reset-each-iteration',
    body: '0fae13660f6fc2f30f58c1',
    instructions: 3,
    setup: (s) => {
      little(s.ram, 16, 0x5f80n, 4);
      s.xmm[2] = low32(s.xmm[2], 0x3f800000);
      s.xmm[1] = low32(s.xmm[1], 0x33800000);
    },
    expected: (s) => {
      s.xmm[0] = low32(s.xmm[2], 0x3f800001);
      s.mxcsr = 0x5fa0;
    },
  },
  {
    name: 'budget-one-resume',
    body: '4883c001',
    instructions: 1,
    resume: true,
    setup: (s) => {
      s.gpr[0] = 0n;
    },
    expected: (s, n) => {
      s.gpr[0] = n;
      s.flags = addFlags(n);
    },
  },
  {
    name: 'rep-forward-copy',
    repeat: true,
    body: 'f3a4',
    instructions: 1,
    expected: (s, n) => {
      const size = Number(n);
      s.ram.copyWithin(size + 32, 0, size);
      s.gpr[6] = RAM + n;
      s.gpr[7] = RAM + 2n * n + 32n;
    },
  },
];
rows.push(...x87Rows);
rows.push(...numericStateRows);
rows.push(...streamingRows);
export const workloadNames = rows.map((row) => row.name);
function check(actual, expected, label) {
  if (actual !== expected) throw Error(`${label}: expected ${expected}, received ${actual}`);
}
function checkArray(actual, expected, label) {
  check(actual.length, expected.length, label + ' length');
  expected.forEach((v, i) => check(actual[i], v, `${label}${i}`));
}
function initial(n, repeat, sample) {
  const ram = Uint8Array.from(
    { length: repeat ? 2 * Number(n) + 64 : 64 },
    (_, i) => (i * 7 + sample * 11 + 3) & 255,
  );
  const gpr = Array.from({ length: 16 }, (_, i) => 0x1122334400000000n + BigInt(i));
  gpr[1] = n;
  gpr[3] = RAM + 16n;
  const xmm = Array.from(
    { length: 16 },
    (_, i) =>
      ((0x102030405060708090a0b0c0d0e0f001n * BigInt(i + 1)) ^ (BigInt(sample) << 67n)) & MASK128,
  );
  if (repeat) {
    gpr[6] = RAM;
    gpr[7] = RAM + n + 32n;
  }
  const x87 = {
    registers: Array.from(
      { length: 8 },
      (_, i) => (BigInt(0xa000 + i) << 64n) | BigInt(i + sample + 1),
    ),
    controlWord: 0x037b,
    statusWord: 0xa884,
    tagWord: 0xffff,
    opcode: 0x123,
    instructionPointer: 0x1122334455667788n,
    dataPointer: 0x8877665544332211n,
  };
  return { gpr, xmm, ram, x87, flags: repeat ? 0x8d7n : FLAGS, mxcsr: 0x1f80 };
}
const copy = (s) => ({
  ...s,
  gpr: s.gpr.slice(),
  xmm: s.xmm.slice(),
  ram: s.ram.slice(),
  x87: { ...s.x87, registers: s.x87.registers.slice() },
});
const resources = () => ({
  compilations: 0,
  cacheHits: 0,
  nativeEntries: 0,
  dispatches: 0,
  generatedBytes: 0,
});
const phases = () => ({
  translationMs: 0,
  browserCompileMs: 0,
  instantiationMs: 0,
  executionMs: 0,
  totalMs: 0,
});
const sum = (a, b) => {
  for (const key of Object.keys(a)) a[key] += b[key];
};

export async function measure(
  sides,
  { iterations = 1000001, samples = 11, workloads = workloadNames } = {},
) {
  for (const [name, value, max] of [
    ['iterations', iterations, 10000000],
    ['samples', samples, 101],
  ])
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw Error(`${name} must be an integer in 1..${max}`);
  for (const name of workloads)
    if (!workloadNames.includes(name)) throw Error(`unknown workload: ${name}`);
  const results = [],
    definitions = [],
    unavailable = [];
  for (const row of rows.filter((row) => workloads.includes(row.name))) {
    const n =
      BigInt(row.resume ? Math.min(iterations, 3000) : iterations) * BigInt(row.factor ?? 1);
    const displacement = -(row.body.length / 2 + 2),
      code = row.repeat
        ? hex(row.body)
        : hex(row.body + 'e2' + (displacement & 255).toString(16).padStart(2, '0'));
    if (displacement < -128) throw Error('benchmark loop exceeds rel8');
    const budget = row.repeat ? 1n : BigInt(row.instructions + 1) * n,
      repeatBudget = row.repeat ? n : 0n;
    const active = [];
    definitions.push({
      name: row.name,
      code: Array.from(code, (b) => b.toString(16).padStart(2, '0')).join(''),
      iterations: n,
      instructions: budget,
      repeatBudget,
      work: row.repeat ? repeatBudget : budget,
      throughputUnit: row.repeat ? 'repeat elements' : 'guest instructions',
      flagMask: row.flagMask ?? 0xcd7n,
      resume: !!row.resume,
      requiresX87: !!row.requiresX87,
      requiresNumericState: !!row.requiresNumericState,
      requiresStreaming: !!row.requiresStreaming,
      ...(row.guestMemoryPerIteration
        ? { guestMemoryPerIteration: row.guestMemoryPerIteration }
        : {}),
    });
    try {
      for (const side of sides) {
        if (
          row.requiresStreaming &&
          !WebAssembly.Module.exports(side.compiler).some((e) => e.name === 'core_masked_store')
        ) {
          if (side.label === 'current')
            throw Error('current build is missing masked and streaming memory');
          unavailable.push({
            side: side.label,
            workload: row.name,
            reason: 'masked and streaming memory unavailable',
          });
          continue;
        }
        if (
          row.requiresNumericState &&
          !WebAssembly.Module.exports(side.compiler).some((e) => e.name === 'core_numeric_image')
        ) {
          if (side.label === 'current')
            throw Error('current build is missing numeric state execution');
          unavailable.push({
            side: side.label,
            workload: row.name,
            reason: 'MMX and numeric state images unavailable',
          });
          continue;
        }
        const cpu = await side.createCpu({
          compiler: side.compiler,
          code: { base: CODE, bytes: code },
          ram: {
            base: RAM,
            bytes: new Uint8Array(row.repeat ? 2 * Number(n) + 64 : (row.ramBytes ?? 64)),
          },
          limits,
        });
        const hasX87 =
          typeof cpu.readX87State === 'function' && typeof cpu.setX87State === 'function';
        active.push({ ...side, cpu, hasX87 });
        if (row.requiresX87 && !hasX87) {
          if (side.label === 'current') throw Error('current build is missing x87 APIs');
          cpu.dispose();
          active.pop();
          unavailable.push({ side: side.label, workload: row.name, reason: 'x87 API unavailable' });
        }
      }
      for (let sample = 0; sample < samples; sample++)
        for (const side of sample % 2 ? [...active].reverse() : active) {
          const input = initial(n, row.repeat, sample);
          if (row.ramBytes) input.ram = new Uint8Array(row.ramBytes);
          row.setup?.(input, n, sample);
          const expected = copy(input);
          row.expected(expected, n, sample);
          expected.gpr[1] = 0n;
          side.cpu.writeMemory(RAM, input.ram);
          side.cpu.setState({ registers: input.gpr, flags: input.flags, rip: CODE });
          side.cpu.setXmmState(input.xmm);
          side.cpu.setMxcsr(input.mxcsr);
          const hasX87 = side.hasX87;
          if (hasX87) side.cpu.setX87State(input.x87);
          let result;
          const totals = resources(),
            timings = phases();
          const began = performance.now();
          let elapsedMs = 0;
          if (row.resume) {
            for (let i = 0n; i < budget; i++) {
              const callAt = performance.now();
              result = await side.cpu.run({ budget: 1n, repeatBudget: 0n });
              elapsedMs += performance.now() - callAt;
              check(result.reason, 'budget', 'resume reason');
              check(result.retired, 1n, 'resume retired');
              check(result.remaining, 0n, 'resume remaining');
              sum(totals, result.resources);
              sum(timings, result.timings);
            }
          } else {
            const callAt = performance.now();
            result = await side.cpu.run({ budget, repeatBudget });
            elapsedMs = performance.now() - callAt;
            sum(totals, result.resources);
            sum(timings, result.timings);
          }
          const wallMs = performance.now() - began;
          check(result.reason, 'budget', 'reason');
          check(result.remaining, 0n, 'remaining');
          if (!row.resume) check(result.retired, budget, 'retired');
          check(result.repeatIterations, repeatBudget, 'repeated elements');
          check(result.remainingRepeatBudget, 0n, 'remaining repeat budget');
          check(result.state.rip, CODE + BigInt(code.length), 'RIP');
          checkArray(result.state.registers, expected.gpr, 'GPR');
          checkArray(side.cpu.readXmmState(), expected.xmm, 'XMM');
          check(side.cpu.readMxcsr(), expected.mxcsr, 'MXCSR');
          const x87 = hasX87 ? side.cpu.readX87State() : undefined;
          if (x87) {
            checkArray(x87.registers, expected.x87.registers, 'physical x87');
            const mask = row.requiresX87 ? (row.x87StatusMask ?? 0xbaff) : 0xffff;
            check(x87.statusWord & mask, expected.x87.statusWord & mask, 'defined x87 status');
            for (const field of [
              'controlWord',
              'tagWord',
              'opcode',
              'instructionPointer',
              'dataPointer',
            ])
              check(x87[field], expected.x87[field], `x87 ${field}`);
          }
          check(result.state.flags & ~0xcd7n, 0n, 'valid flags');
          const flagMask = row.flagMask ?? 0xcd7n;
          check(
            result.state.flags & flagMask,
            expected.flags & flagMask,
            'defined and preserved flags',
          );
          checkArray(side.cpu.readMemory(RAM, expected.ram.length), expected.ram, 'RAM');
          checkArray(side.cpu.readMemory(CODE, code.length), code, 'code');
          for (const field of [
            'fault',
            'segmentFault',
            'alignmentFault',
            'simdException',
            'generalProtectionFault',
            'x87Exception',
          ])
            check(result[field], undefined, field);
          check(totals.compilations, sample === 0 ? 1 : 0, 'compilations');
          check(totals.dispatches, 0, 'dispatches');
          check(totals.nativeEntries, row.resume ? Number(budget) : 1, 'native entries');
          results.push({
            side: side.label,
            workload: row.name,
            sample,
            window: sample === 0 ? 'first' : sample < 4 ? 'early' : 'later',
            elapsedMs,
            ...(row.resume ? { wallMs } : {}),
            creationMs: side.cpu.creationMs,
            resources: { ...result.resources, ...totals },
            timings,
            state: result.state,
            xmm: side.cpu.readXmmState(),
            mxcsr: side.cpu.readMxcsr(),
            ...(x87 ? { x87 } : {}),
            units: side.cpu.inspectTranslations(),
          });
        }
    } finally {
      active.forEach((side) => side.cpu.dispose());
    }
  }
  return {
    definitions,
    unavailable,
    samples: results,
    limits,
    ceiling:
      'Synthetic private-memory long64 kernels. Timings exclude reset/import/output guards, but include run snapshots and phase costs. FP loops include their recorded reset/control instructions. Undefined multiply/divide flags are masked. First completion is not an independent cold-start sample. No game/native-SIMD/peak-allocation claim.',
  };
}
