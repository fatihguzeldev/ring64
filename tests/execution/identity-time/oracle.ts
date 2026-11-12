// Independent public oracle: literal byte programs and direct BigInt retirement steps.
// No decoder, time implementation, transport layout, or production retirement count supplies expectations.
import type {
  Cpu,
  ExecutionContextSnapshot,
  Options,
  PagingState,
  State,
} from '../../../host/index.js';

export type Factory = (options: Options) => Promise<Cpu>;
export type Side = { createCpu: Factory; compiler: WebAssembly.Module };
export const MAX = 0xffffffffffffffffn;
export const ENTRY = 0x1000n;
export const AUX = 0x89abcdef;
export const groups = [
  'identity',
  'ledger',
  'raw',
  'tsd',
  'msr',
  'accounting',
  'debug',
  'lifetime',
] as const;
export type Group = (typeof groups)[number];
type Mode = ExecutionContextSnapshot['mode'];
export type Family = 'linear' | 'pg0' | 'legacy32' | 'pae' | 'ia32e' | 'fixed';
export type Profile = {
  mode: Mode;
  bits: 16 | 32 | 64;
  stack?: 16 | 32;
  cpl?: number;
  family?: Family;
};
export const profiles: Profile[] = [
  ...(['real', 'protected', 'compatibility'] as const).flatMap((mode) =>
    ([16, 32] as const).flatMap((bits) =>
      ([16, 32] as const).map((stack) => ({ mode, bits, stack })),
    ),
  ),
  { mode: 'virtual8086', bits: 16, stack: 16, cpl: 3 },
  { mode: 'long64', bits: 64 },
];
export const controls: Profile[] = [
  { mode: 'real', bits: 16, family: 'pg0' },
  { mode: 'protected', bits: 16, family: 'pg0' },
  { mode: 'protected', bits: 32, family: 'legacy32' },
  { mode: 'protected', bits: 32, family: 'pae' },
  { mode: 'compatibility', bits: 16, family: 'ia32e' },
  { mode: 'compatibility', bits: 32, family: 'fixed' },
  { mode: 'long64', bits: 64, family: 'ia32e' },
  { mode: 'long64', bits: 64, family: 'fixed' },
];
export function equal(actual: unknown, expected: unknown, label: string): void {
  const encode = (value: unknown) =>
    JSON.stringify(value, (_, item: unknown) =>
      typeof item === 'bigint'
        ? item.toString(16)
        : ArrayBuffer.isView(item)
          ? Array.from(item as Uint8Array)
          : item,
    );
  if (encode(actual) !== encode(expected))
    throw Error(`${label}: ${encode(actual)} != ${encode(expected)}`);
}
export const hex = (value: string): Uint8Array =>
  Uint8Array.from(value.match(/../g) ?? [], (v) => parseInt(v, 16));
const little = (value: bigint, bytes = 4) =>
  Array.from({ length: bytes }, (_, i) => Number((value >> BigInt(i * 8)) & 255n));
export function put(bytes: Uint8Array, at: number, value: bigint, width = 4): void {
  bytes.set(little(value, width), at);
}
const imm = (value: bigint) =>
  little(value)
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
export function execution(profile: Profile): ExecutionContextSnapshot {
  const cpl = profile.mode === 'virtual8086' ? 3 : (profile.cpl ?? 0);
  const legacy = profile.mode === 'real' || profile.mode === 'virtual8086';
  const segment = (code: boolean, bits: number, selector: number) => ({
    selector: legacy ? 0 : selector | cpl,
    base: 0n,
    limit: legacy ? 0xffff : 0xffffffff,
    default32: profile.mode !== 'virtual8086' && bits === 32,
    usable: true,
    type: code && !legacy ? ('readable-code' as const) : ('read-write' as const),
    dpl: cpl,
    present: true,
    conforming: false,
    accessed: true,
    long: code && bits === 64,
    granularity: !legacy,
    available: false,
  });
  const empty = { selector: 0, valid: false, base: 0n, limit: 0, attributes: 0 };
  return {
    mode: profile.mode,
    cpl,
    segments: {
      cs: segment(true, profile.bits, 8),
      ss: segment(false, profile.stack ?? 32, 16),
      ds: segment(false, 32, 16),
      es: segment(false, 32, 16),
      fs: segment(false, 32, 16),
      gs: segment(false, 32, 16),
    },
    gdtr: { base: 0x6000n, limit: 0x7f },
    idtr: { base: 0x7000n, limit: 0xfff },
    ldtr: { ...empty },
    tr: { ...empty },
  };
}
export function input(profile: Profile, rip = ENTRY): State {
  const registers = Array.from({ length: 16 }, (_, i) => 0xa1b2c3d4e5f60000n + BigInt(i));
  registers[4] = 0x9000n;
  return {
    registers,
    flags: profile.mode === 'virtual8086' ? 0x3002n : 2n,
    rip,
    interruptibility: { sti: false, ss: false },
    event: { kind: 'ready' },
    interrupts: { irq: null, nmiPending: false, nmiBlocked: false },
  };
}
export async function using(
  side: Side,
  code: string,
  profile: Profile,
  action: (cpu: Cpu) => Promise<void>,
  extra: Pick<Options, 'io'> = {},
): Promise<void> {
  const bytes = new Uint8Array(0x50000);
  bytes.set(hex(code), Number(ENTRY));
  // Raw descriptors are authored here, independently of the execution fixture libraries.
  bytes.set(hex('ffff0000009bcf00ffff00000093cf00'), 0x6008);
  const family = profile.family ?? 'linear';
  let paging: PagingState | undefined;
  if (family !== 'linear') {
    paging = {
      cr0: profile.mode === 'real' ? 0x30n : 0x33n,
      cr2: 0xdeadn,
      cr3: 0x40000n,
      cr4: 0x608n,
      efer: 0n,
    };
    if (family === 'legacy32') {
      paging.cr0 |= 0x80000000n;
      put(bytes, 0x40000, 0x41067n);
      for (let i = 0; i < 80; i++) put(bytes, 0x41000 + i * 4, BigInt(i * 4096) | 0x67n);
    } else if (family === 'pae') {
      paging.cr0 |= 0x80000000n;
      paging.cr4 |= 0x20n;
      paging.pdpte = [0x41001n, 0n, 0n, 0n];
      put(bytes, 0x40000, 0x41001n, 8);
      put(bytes, 0x41000, 0x42067n, 8);
      for (let i = 0; i < 80; i++) put(bytes, 0x42000 + i * 8, BigInt(i * 4096) | 0x67n, 8);
    } else if (family === 'ia32e' || family === 'fixed') {
      paging.cr0 |= 0x80000000n;
      paging.cr4 |= 0x20n;
      paging.efer = 0x500n;
      put(bytes, 0x40000, 0x41027n, 8);
      put(bytes, 0x41000, 0x42027n, 8);
      put(bytes, 0x42000, 0x43027n, 8);
      for (let i = 0; i < 80; i++) put(bytes, 0x43000 + i * 8, BigInt(i * 4096) | 0x67n, 8);
    }
  }
  const common = {
    compiler: side.compiler,
    context: execution(profile),
    entry: ENTRY,
    limits: {
      maxInstructions: 32,
      maxSourceBytes: 512,
      maxArtifactBytes: 131072,
      maxCachedArtifacts: 16,
      maxCachedBytes: 2097152,
      maxTranslationsPerRun: 32,
    },
    memory: {
      backings: [{ id: 'ram', bytes }],
      mappings: [
        {
          base: 0n,
          backing: 'ram',
          offset: 0,
          length: bytes.length,
          permissions: { read: true, write: true, execute: true },
        },
      ],
    },
    memoryLimits: { maxBackings: 4, maxMappings: 16, maxBackingBytes: 0xa0000 },
  } satisfies Options;
  const options: Options =
    family === 'linear'
      ? common
      : family === 'fixed'
        ? { ...common, memoryModel: 'ia32e-paged', paging: paging! }
        : { ...common, memoryModel: 'physical', paging: paging! };
  const cpu = await side.createCpu({ ...options, ...extra });
  try {
    cpu.setState(input(profile));
    await action(cpu);
  } finally {
    cpu.dispose();
  }
}

const words = new Map<bigint, readonly bigint[]>([
  [0n, [1n, 0x676e6952n, 0x656e6967n, 0x6e453436n]],
  [1n, [0n, 0n, 0n, 0x10n]],
  [0x80000000n, [0x80000001n, 0n, 0n, 0n]],
  [0x80000001n, [0n, 0n, 0n, 0x08000000n]],
]);
const outputs = [0, 3, 1, 2];
const sample = (cpu: Cpu) => {
  const r = cpu.readState().registers;
  return (r[2]! << 32n) | r[0]!;
};
const clock = (cpu: Cpu, tsc: bigint, tscAux = AUX) =>
  equal(cpu.readTimeState(), { tsc, tscAux }, 'independent final time bank');
function partitions(count: number): number[][] {
  if (count === 0) return [[]];
  return Array.from({ length: count }, (_, i) => i + 1).flatMap((first) =>
    partitions(count - first).map((tail) => [first, ...tail]),
  );
}
type Op = {
  code: string;
  kind: 'nop' | 'rdtsc' | 'rdtscp' | 'cpuid' | 'mov' | 'copy' | 'write' | 'aux' | 'jump';
  register?: number;
  value?: bigint;
};
const mov = (register: number, value: bigint, profile: Profile): Op => ({
  kind: 'mov',
  register,
  value,
  code: (profile.bits === 16 ? '66' : '') + (0xb8 + register).toString(16) + imm(value),
});
function ledgerStep(
  op: Op,
  profile: Profile,
  state: State,
  time: { tsc: bigint; tscAux: number },
): void {
  const r = state.registers;
  if (op.kind === 'mov')
    r[op.register!] =
      profile.bits === 64
        ? op.value! & 0xffffffffn
        : (r[op.register!]! & 0xffffffff00000000n) | (op.value! & 0xffffffffn);
  if (op.kind === 'copy')
    r[3] =
      profile.bits === 64
        ? r[0]! & 0xffffffffn
        : (r[3]! & 0xffffffff00000000n) | (r[0]! & 0xffffffffn);
  if (op.kind === 'rdtsc' || op.kind === 'rdtscp') {
    r[0] = time.tsc & 0xffffffffn;
    r[2] = time.tsc >> 32n;
    if (op.kind === 'rdtscp') r[1] = BigInt(time.tscAux);
  }
  if (op.kind === 'cpuid') {
    const record = words.get(r[0]! & 0xffffffffn) ?? [0n, 0n, 0n, 0n];
    for (const [i, register] of outputs.entries()) r[register] = record[i]!;
  }
  if (op.kind === 'aux') time.tscAux = Number(r[0]! & 0xffffffffn);
  time.tsc =
    op.kind === 'write'
      ? ((r[2]! & 0xffffffffn) << 32n) | (r[0]! & 0xffffffffn)
      : (time.tsc + 1n) & MAX;
  state.rip += BigInt(op.code.length / 2);
}

async function identity(side: Side): Promise<number> {
  let cases = 0;
  const leaves = [
    ...words.keys(),
    2n,
    7n,
    0x15n,
    0x16n,
    0x0dn,
    0x40000000n,
    0x80000007n,
    0x80000008n,
    0xffffffffn,
  ];
  for (const profile of [...profiles, ...controls])
    await using(side, '0fa2', profile, async (cpu) => {
      for (const leaf of leaves)
        for (const subleaf of [0n, 0x80000001n])
          for (const id of [0n, 0x200000n]) {
            const before = input(profile);
            before.flags! |= id;
            before.registers[0] = 0xdecafbad00000000n | leaf;
            before.registers[1] = 0x1234567800000000n | subleaf;
            cpu.setState(before);
            cpu.setTimeState({ tsc: 0n, tscAux: AUX });
            const numeric = [cpu.readXmmState(), cpu.readMxcsr(), cpu.readX87State()];
            const result = await cpu.run({ budget: 1n });
            equal(result.reason, 'budget', 'CPUID selected admission');
            equal(result.retired, 1n, 'CPUID independent one instruction');
            const expected = structuredClone(before);
            expected.rip = ENTRY + 2n;
            for (const [i, register] of outputs.entries())
              expected.registers[register] = (words.get(leaf) ?? [0n, 0n, 0n, 0n])[i]!;
            equal(
              result.state.registers,
              expected.registers,
              'CPUID full raw sixteen-register packet',
            );
            equal(result.state.flags, before.flags, 'CPUID ID/FLAGS preservation');
            equal(
              [cpu.readXmmState(), cpu.readMxcsr(), cpu.readX87State()],
              numeric,
              'CPUID numeric preservation',
            );
            clock(cpu, 1n);
            cases++;
          }
    });
  const vendor = [0x676e6952n, 0x6e453436n, 0x656e6967n]
    .flatMap((value) => little(value))
    .map((v) => String.fromCharCode(v))
    .join('');
  equal(vendor, 'Ring64Engine', 'literal vendor byte-order control');
  await using(side, '0faee8d9e8', { mode: 'long64', bits: 64 }, async (cpu) => {
    const result = await cpu.run({ budget: 2n });
    equal(result.reason, 'budget', 'unclaimed SSE2 LFENCE and x87 FLD1 remain admitted');
    clock(cpu, 2n, 0);
    cases++;
  });
  return cases;
}
async function ledger(side: Side): Promise<number> {
  let cases = 0;
  for (const profile of [
    { mode: 'protected', bits: 16 },
    { mode: 'protected', bits: 32 },
    { mode: 'long64', bits: 64 },
    ...controls,
  ] as Profile[]) {
    const programs: Op[][] = [
      [
        { kind: 'nop', code: '90' },
        { kind: 'nop', code: '90' },
        { kind: 'rdtsc', code: '0f31' },
        { kind: 'copy', code: (profile.bits === 16 ? '66' : '') + '89c3' },
        { kind: 'rdtscp', code: '0f01f9' },
      ],
    ];
    let seed = 0x64c0ffee;
    for (let trace = 0; trace < 4; trace++) {
      const ops: Op[] = [];
      for (let i = 0; i < 4; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        ops.push(
          seed % 3 === 0
            ? mov(0, BigInt(seed), profile)
            : seed % 3 === 1
              ? { kind: 'rdtsc', code: '0f31' }
              : { kind: 'nop', code: '90' },
        );
      }
      ops.push({ kind: 'jump', code: 'eb029090' }, { kind: 'rdtscp', code: '0f01f9' });
      programs.push(ops);
    }
    if (profile.family && profile.family !== 'linear')
      programs.push([
        mov(1, 0x10n, profile),
        mov(0, 0xfffffffen, profile),
        mov(2, 0xffffffffn, profile),
        { kind: 'write', code: '0f30' },
        { kind: 'rdtsc', code: '0f31' },
        { kind: 'rdtscp', code: '0f01f9' },
      ]);
    for (const [index, ops] of programs.entries())
      await using(side, ops.map((op) => op.code).join(''), profile, async (cpu) => {
        for (const split of partitions(ops.length)) {
          const expected = input(profile);
          if (index === 0) expected.registers[3] = 0n;
          cpu.setState(expected);
          const reference = structuredClone(expected);
          const time = { tsc: index === 0 ? 100n : MAX - BigInt(index), tscAux: AUX };
          cpu.setTimeState(time);
          let reached = 0;
          for (const budget of split) {
            for (let i = 0; i < budget; i++) ledgerStep(ops[reached++]!, profile, reference, time);
            const result = await cpu.run({ budget: BigInt(budget) });
            equal(result.reason, 'budget', 'finite ledger budget exit');
            equal(result.retired, BigInt(budget), 'independently reached instructions');
            equal(result.state.registers, reference.registers, 'ledger full raw registers');
            equal(result.state.rip, reference.rip, 'ledger reached PC');
            equal(result.state.flags, reference.flags, 'ledger flags');
            equal(cpu.readTimeState(), time, 'direct BigInt ledger bank');
          }
          if (index === 0) {
            equal(reference.registers[3], 102n, 'literal first sample');
            equal(reference.registers[0], 104n, 'literal second sample');
            equal(time.tsc, 105n, 'literal final clock');
          }
          cases++;
        }
      });
  }
  for (const budget of [(1n << 32n) + 1n, (1n << 63n) + 1n, MAX])
    await using(side, '900f31', { mode: 'long64', bits: 64 }, async (cpu) => {
      cpu.setTimeState({ tsc: 100n, tscAux: AUX });
      const result = await cpu.run({ budget, stop: ENTRY + 3n });
      equal(result.retired, 2n, 'huge original allowance bounded reached trace');
      equal(result.remaining, budget - 2n, 'huge unsigned remaining');
      equal(sample(cpu), 101n, 'huge original allowance sample');
      clock(cpu, 102n);
      cases++;
    });
  return cases;
}
async function raw(side: Side): Promise<number> {
  let cases = 0;
  for (const profile of [...profiles, ...controls]) {
    await using(side, '900f310f01f9', profile, async (cpu) => {
      cpu.setTimeState({ tsc: MAX - 1n, tscAux: AUX });
      await cpu.run({ budget: 1n });
      clock(cpu, MAX);
      await cpu.run({ budget: 1n });
      equal(sample(cpu), MAX, 'sample before own wrap');
      clock(cpu, 0n);
      await cpu.run({ budget: 1n });
      equal(sample(cpu), 0n, 'post-wrap sample');
      equal(cpu.readState().registers[1], BigInt(AUX), 'raw AUX output zero-extension');
      clock(cpu, 1n);
      cases++;
    });
    await using(side, '0f310f01f9', profile, async (cpu) => {
      for (const tsc of [0n, 0xffffffffn, 0x100000000n, MAX])
        for (const tscAux of [0, 0xffffffff]) {
          const before = input(profile);
          cpu.setState(before);
          cpu.setTimeState({ tsc, tscAux });
          const first = await cpu.run({ budget: 1n });
          equal(sample(cpu), tsc, 'literal split halves');
          const expected = [...before.registers];
          expected[0] = tsc & 0xffffffffn;
          expected[2] = tsc >> 32n;
          equal(first.state.registers, expected, 'RDTSC all raw banks');
          const second = await cpu.run({ budget: 1n });
          expected[0] = (tsc + 1n) & 0xffffffffn;
          expected[2] = ((tsc + 1n) & MAX) >> 32n;
          expected[1] = BigInt(tscAux);
          equal(second.state.registers, expected, 'RDTSCP all raw banks');
          clock(cpu, (tsc + 2n) & MAX, tscAux);
          cases++;
        }
    });
    await using(side, '400f31', profile, async (cpu) => {
      for (const split of profile.bits === 64 ? [[1]] : [[2], [1, 1]]) {
        cpu.setState(input(profile));
        cpu.setTimeState({ tsc: 100n, tscAux: AUX });
        let retired = 0n;
        for (const budget of split) retired += (await cpu.run({ budget: BigInt(budget) })).retired;
        equal(sample(cpu), profile.bits === 64 ? 100n : 101n, '40 is REX only in long64');
        clock(cpu, profile.bits === 64 ? 101n : 102n);
        equal(retired, profile.bits === 64 ? 1n : 2n, '40 independent instruction count');
        equal(
          cpu.readState().flags,
          (profile.mode === 'virtual8086' ? 0x3002n : 2n) | (profile.bits === 32 ? 0x80n : 0n),
          'INC width controls FLAGS while long64 REX preserves them',
        );
        cases++;
      }
    });
  }
  for (const code of ['f3f30fa2', 'f2f30f31', 'f3f20f01f9', '6667672e0f31', '4f0f01f9'])
    await using(side, code, { mode: 'long64', bits: 64 }, async (cpu) => {
      cpu.setTimeState({ tsc: 100n, tscAux: AUX });
      const result = await cpu.run({ budget: 1n });
      equal(result.reason, 'budget', 'ignored prefix admission');
      equal(result.state.rip, ENTRY + BigInt(code.length / 2), 'exact prefix length');
      clock(cpu, 101n);
      cases++;
    });
  return cases;
}

async function tsd(side: Side): Promise<number> {
  let cases = 0;
  const rows: Profile[] = [
    ...controls.flatMap((profile) =>
      profile.mode === 'real' ? [profile] : [0, 1, 2, 3].map((cpl) => ({ ...profile, cpl })),
    ),
    { mode: 'virtual8086', bits: 16, family: 'pg0', cpl: 3 },
  ];
  for (const profile of rows)
    for (const restricted of [false, true])
      await using(side, '900f310f01f90fa2', profile, async (cpu) => {
        const paging = cpu.readPagingState();
        cpu.setPagingState({ ...paging, cr4: restricted ? paging.cr4 | 4n : paging.cr4 & ~4n });
        cpu.setTimeState({ tsc: 100n, tscAux: AUX });
        const before = cpu.readState();
        const result = await cpu.run({ budget: 2n });
        const denied = restricted && profile.mode !== 'real' && (profile.cpl ?? 0) > 0;
        equal(result.reason, denied ? 'protection-fault' : 'budget', 'TSD live permission');
        equal(result.retired, denied ? 1n : 2n, 'TSD independent prefix accounting');
        clock(cpu, denied ? 101n : 102n);
        if (denied) {
          equal(result.protectionFault?.vector, 13, 'TSD vector');
          equal(result.protectionFault?.errorCode, 0, 'TSD no selector');
          equal(result.protectionFault?.phase, 'privilege', 'TSD phase');
          equal(result.state.registers, before.registers, 'TSD no output publication');
          const pending = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
          equal(pending.state.event.kind, 'pending', 'TSD captured pending');
          clock(cpu, 101n);
          cpu.setState({ ...input(profile), rip: ENTRY + 3n });
          const rdtscp = await cpu.run({ budget: 1n });
          equal(rdtscp.reason, 'protection-fault', 'TSD also refuses RDTSCP');
          equal(rdtscp.protectionFault?.phase, 'privilege', 'RDTSCP TSD phase');
          equal(rdtscp.retired, 0n, 'RDTSCP TSD no retirement');
          clock(cpu, 101n);
          const identityInput = input(profile, ENTRY + 6n);
          identityInput.registers[0] = 0n;
          cpu.setState(identityInput);
          const cpuid = await cpu.run({ budget: 1n });
          equal(cpuid.reason, 'budget', 'CPUID unaffected by TSD');
          equal(
            outputs.map((register) => cpuid.state.registers[register]),
            words.get(0n),
            'TSD does not gate literal identity outputs',
          );
          clock(cpu, 102n);
        } else {
          equal(sample(cpu), 101n, 'TSD admitted sample');
          const second = await cpu.run({ budget: 1n });
          equal(second.reason, 'budget', 'RDTSCP live permission');
          equal(sample(cpu), 102n, 'RDTSCP live sample');
          clock(cpu, 103n);
        }
        cases++;
      });
  return cases;
}
async function msr(side: Side): Promise<number> {
  let cases = 0;
  for (const profile of controls) {
    for (const value of [0n, 0x800000000000n, 0x8000000000000000n, MAX]) {
      const ops = [
        mov(1, 0x10n, profile),
        mov(0, value & 0xffffffffn, profile),
        mov(2, value >> 32n, profile),
      ];
      await using(
        side,
        '90' + ops.map((op) => op.code).join('') + '0f300f320f01f9',
        profile,
        async (cpu) => {
          cpu.setTimeState({ tsc: 1000n, tscAux: AUX });
          const write = await cpu.run({ budget: 5n });
          equal(write.reason, 'budget', 'selected noncanonical TSC write');
          equal(write.retired, 5n, 'literal live-local prefix count');
          clock(cpu, value);
          await cpu.run({ budget: 1n });
          equal(sample(cpu), value, 'RDMSR TSC raw halves');
          clock(cpu, (value + 1n) & MAX);
          await cpu.run({ budget: 1n });
          equal(sample(cpu), (value + 1n) & MAX, 'RDTSCP after TSC write');
          clock(cpu, (value + 2n) & MAX);
          cases++;
        },
      );
    }
    for (const high of [0n, 1n, 0xffffffffn])
      await using(side, '900f300f320f01f9', profile, async (cpu) => {
        const before = input(profile);
        before.registers[1] = 0xabcd1234c0000103n;
        before.registers[0] = 0x11223344ffffffffn;
        before.registers[2] = 0x1234567800000000n | high;
        cpu.setState(before);
        cpu.setTimeState({ tsc: 100n, tscAux: AUX });
        const result = await cpu.run({ budget: 2n });
        if (high !== 0n) {
          equal(result.reason, 'protection-fault', 'AUX upper32 refusal');
          equal(result.protectionFault?.phase, 'target', 'AUX value owner');
          equal(result.protectionFault?.vector, 13, 'AUX value vector');
          equal(result.protectionFault?.errorCode, 0, 'AUX value no selector');
          equal(result.state.registers, before.registers, 'AUX rejected outputs retained');
          equal(result.retired, 1n, 'AUX failure retains prefix');
          clock(cpu, 101n);
        } else {
          equal(result.reason, 'budget', 'AUX max accepted');
          clock(cpu, 102n, 0xffffffff);
          await cpu.run({ budget: 1n });
          equal(sample(cpu), 0xffffffffn, 'RDMSR AUX high zero');
          clock(cpu, 103n, 0xffffffff);
          await cpu.run({ budget: 1n });
          equal(cpu.readState().registers[1], 0xffffffffn, 'cached AUX read');
          clock(cpu, 104n, 0xffffffff);
        }
        cases++;
      });
  }
  for (const profile of controls) {
    const prefix =
      [mov(1, 0x10n, profile), mov(0, 0xffffffffn, profile), mov(2, 0xffffffffn, profile)]
        .map((op) => op.code)
        .join('') + '0f300f31';
    const suffix =
      [mov(0, 3n, profile), mov(2, 0n, profile)].map((op) => op.code).join('') + '0f300f31';
    await using(side, prefix + suffix, profile, async (cpu) => {
      for (const first of partitions(5))
        for (const second of partitions(4)) {
          cpu.setState(input(profile));
          cpu.setTimeState({ tsc: 100n, tscAux: AUX });
          for (const budget of first)
            equal(
              (await cpu.run({ budget: BigInt(budget) })).retired,
              BigInt(budget),
              'first TSC write reached trace',
            );
          equal(sample(cpu), MAX, 'first same-CPU TSC write sample MAX');
          clock(cpu, 0n);
          for (const budget of second)
            equal(
              (await cpu.run({ budget: BigInt(budget) })).retired,
              BigInt(budget),
              'second TSC write reached trace',
            );
          equal(sample(cpu), 3n, 'second same-CPU backward write sample');
          clock(cpu, 4n);
          cases++;
        }
    });
    await using(side, '0f30', profile, async (cpu) => {
      const state = input(profile);
      state.registers[1] = 0x10n;
      state.registers[0] = 3n;
      state.registers[2] = 0n;
      state.flags! |= 0x100n;
      cpu.setState(state);
      cpu.setTimeState({ tsc: 100n, tscAux: AUX });
      const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
      equal(result.retired, 1n, 'TSC write retires before TF');
      equal(result.state.event.kind, 'pending', 'TSC write TF source captured');
      clock(cpu, 3n);
      cases++;
    });
  }
  for (const opcode of ['0f30', '0f32'])
    await using(
      side,
      '90' + opcode,
      { mode: 'virtual8086', bits: 16, family: 'pg0' },
      async (cpu) => {
        const state = cpu.readState();
        state.registers[1] = 0xc0000103n;
        cpu.setState(state);
        cpu.setTimeState({ tsc: 100n, tscAux: AUX });
        const result = await cpu.run({ budget: 2n });
        equal(result.protectionFault?.phase, 'privilege', 'v86 MSR refused regardless of IOPL');
        equal(result.retired, 1n, 'v86 MSR prefix only');
        clock(cpu, 101n);
        cases++;
      },
    );
  for (const opcode of ['0f30', '0f32'])
    await using(side, opcode, { mode: 'protected', bits: 32, family: 'pg0' }, async (cpu) => {
      const state = cpu.readState();
      state.registers[1] = 0x11n;
      cpu.setState(state);
      cpu.setTimeState({ tsc: 100n, tscAux: AUX });
      const result = await cpu.run({ budget: 1n });
      equal(result.reason, 'unsupported', 'unselected MSR frontier retained');
      equal(result.retired, 0n, 'unselected MSR no retirement');
      clock(cpu, 100n);
      cases++;
    });
  for (const cpl of [1, 2, 3])
    for (const opcode of ['0f30', '0f32'])
      await using(
        side,
        '90' + opcode,
        { mode: 'protected', bits: 32, cpl, family: 'pg0' },
        async (cpu) => {
          const state = cpu.readState();
          state.registers[1] = 0x10n;
          cpu.setState(state);
          cpu.setTimeState({ tsc: 100n, tscAux: AUX });
          const result = await cpu.run({ budget: 2n });
          equal(result.protectionFault?.phase, 'privilege', 'MSR CPL guard before semantic owner');
          equal(result.retired, 1n, 'privileged MSR failure prefix');
          clock(cpu, 101n);
          cases++;
        },
      );
  for (const opcode of ['0f30', '0f32'])
    await using(side, opcode, { mode: 'long64', bits: 64 }, async (cpu) => {
      const state = cpu.readState();
      state.registers[1] = 0x10n;
      cpu.setState(state);
      cpu.setTimeState({ tsc: 100n, tscAux: AUX });
      const result = await cpu.run({ budget: 1n });
      equal(result.reason, 'unsupported', 'linear MSR frontier unchanged');
      equal(result.retired, 0n, 'linear MSR no retirement');
      clock(cpu, 100n);
      cases++;
    });
  return cases;
}
async function accounting(side: Side): Promise<number> {
  let cases = 0;
  const profile: Profile = { mode: 'long64', bits: 64 };
  await using(side, '9090900f31', profile, async (cpu) => {
    cpu.setTimeState({ tsc: 100n, tscAux: AUX });
    await cpu.run({ budget: 0n });
    clock(cpu, 100n);
    await cpu.run({ budget: 4n, stop: ENTRY });
    clock(cpu, 100n);
    await cpu.run({ budget: 3n });
    clock(cpu, 103n);
    const snapshot = cpu.readState();
    cpu.setState(snapshot);
    clock(cpu, 103n);
    await cpu.run({ budget: 1n });
    equal(sample(cpu), 103n, 'no-clock work and scalar import credit exactly once');
    clock(cpu, 104n);
    cases++;
  });
  for (const code of ['f3a4', 'f36c', 'f36e'])
    await using(
      side,
      '90' + code + '0f31',
      profile,
      async (cpu) => {
        const state = input(profile);
        state.registers[1] = 3n;
        state.registers[2] = 0x80n;
        state.registers[6] = 0x5000n;
        state.registers[7] = 0x5100n;
        cpu.setState(state);
        cpu.setTimeState({ tsc: 100n, tscAux: AUX });
        const first = await cpu.run({ budget: 3n, repeatBudget: 1n });
        equal(first.reason, 'repeat-budget', 'partial REP boundary');
        equal(first.retired, 1n, 'partial REP prefix only');
        equal(first.repeatIterations, 1n, 'one committed element');
        clock(cpu, 101n);
        const second = await cpu.run({ budget: 2n, repeatBudget: 2n });
        equal(second.retired, 2n, 'complete REP and timestamp');
        equal(sample(cpu), 102n, 'REP completion has one tick');
        clock(cpu, 103n);
        cases++;
        state.registers[1] = 0n;
        cpu.setState(state);
        cpu.setTimeState({ tsc: 100n, tscAux: AUX });
        const zero = await cpu.run({ budget: 3n, repeatBudget: 0n });
        equal(zero.retired, 3n, 'zero REP one retirement');
        equal(sample(cpu), 102n, 'zero REP clock');
        clock(cpu, 103n);
        cases++;
      },
      {
        io: {
          read() {
            return 0x5a;
          },
          write() {},
        },
      },
    );
  await using(
    side,
    '90ec900f31',
    profile,
    async (cpu) => {
      cpu.setTimeState({ tsc: 100n, tscAux: AUX });
      const result = await cpu.run({ budget: 4n });
      equal(result.retired, 4n, 'scalar I/O known trace');
      equal(sample(cpu), 103n, 'mid-unit I/O clear_fault does not settle twice');
      clock(cpu, 104n);
      cases++;
    },
    {
      io: {
        read() {
          return 0x5a;
        },
        write() {},
      },
    },
  );
  await using(side, '9090f00f31', profile, async (cpu) => {
    cpu.setTimeState({ tsc: 100n, tscAux: AUX });
    const result = await cpu.run({ budget: 3n });
    equal(result.reason, 'invalid-encoding', 'later guest fault');
    equal(result.retired, 2n, 'independent completed prefix');
    clock(cpu, 102n);
    cases++;
  });
  return cases;
}
async function debug(side: Side): Promise<number> {
  let cases = 0;
  for (const code of ['0f31', '0f01f9'])
    await using(side, code, { mode: 'long64', bits: 64 }, async (cpu) => {
      cpu.setTimeState({ tsc: 100n, tscAux: AUX });
      const state = cpu.readState();
      state.flags |= 0x100n;
      cpu.setState(state);
      const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
      equal(result.state.event.kind, 'pending', 'TF captured completion');
      equal(result.retired, 1n, 'TF completed read');
      equal(sample(cpu), 100n, 'TF sees read outputs');
      clock(cpu, 101n);
      await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
      clock(cpu, 101n);
      cases++;
    });
  await using(side, '0f31', { mode: 'long64', bits: 64 }, async (cpu) => {
    cpu.setDebugState({ addresses: [ENTRY, 0n, 0n, 0n], dr6: 0n, dr7: 0x401n });
    cpu.setTimeState({ tsc: 100n, tscAux: AUX });
    const before = cpu.readState();
    const result = await cpu.run({ budget: 1n });
    equal(result.reason, 'debug-exception', 'execute breakpoint precedes sample');
    equal(result.retired, 0n, 'execute breakpoint no retirement');
    equal(result.state.registers, before.registers, 'execute breakpoint leaves outputs');
    clock(cpu, 100n);
    cases++;
  });
  await using(side, 'f4', { mode: 'protected', bits: 32, family: 'pg0' }, async (cpu) => {
    cpu.setTimeState({ tsc: 100n, tscAux: AUX });
    equal((await cpu.run({ budget: 1n })).retired, 1n, 'HLT retires once');
    clock(cpu, 101n);
    await cpu.run({ budget: 10n });
    clock(cpu, 101n);
    cases++;
  });
  return cases;
}
async function lifetime(side: Side): Promise<number> {
  let cases = 0;
  await using(side, '900f01f9', { mode: 'long64', bits: 64 }, async (cpu) => {
    equal(cpu.readTimeState(), { tsc: 0n, tscAux: 0 }, 'default bank');
    const bank = { tsc: 100n, tscAux: AUX };
    cpu.setTimeState(bank);
    bank.tsc = 999n;
    clock(cpu, 100n);
    const detached = cpu.readTimeState();
    detached.tsc = 888n;
    clock(cpu, 100n);
    const before = cpu.readState();
    const malformed: unknown[] = [
      null,
      undefined,
      [],
      1,
      {},
      { tsc: 0n },
      { tsc: 0, tscAux: 0 },
      { tsc: -1n, tscAux: 0 },
      { tsc: MAX + 1n, tscAux: 0 },
      { tsc: Object(1n), tscAux: 0 },
      ...[undefined, null, '1', 0n, NaN, Infinity, -1, 0.5, 0x100000000, Object(1)].map(
        (tscAux) => ({ tsc: 0n, tscAux }),
      ),
    ];
    for (const value of malformed) {
      let error: unknown;
      try {
        cpu.setTimeState(value as { tsc: bigint; tscAux: number });
      } catch (caught) {
        error = caught;
      }
      equal(error instanceof TypeError, true, 'malformed bank TypeError');
      clock(cpu, 100n);
      equal(cpu.readState(), before, 'rejected import full scalar atomicity');
      cases++;
    }
    const sentinel = new Error('time accessor sentinel');
    let caught: unknown;
    try {
      cpu.setTimeState({
        get tsc(): bigint {
          throw sentinel;
        },
        tscAux: 0,
      });
    } catch (error) {
      caught = error;
    }
    equal(caught === sentinel, true, 'input accessor exception identity');
    clock(cpu, 100n);
    let captures = 0;
    cpu.setTimeState({
      get tsc() {
        captures++;
        return 100n;
      },
      get tscAux() {
        captures++;
        return -0;
      },
    });
    equal(captures, 2, 'capture fields once');
    clock(cpu, 100n, 0);
    const checkpoint = cpu.readState();
    cpu.setTimeState({ tsc: 100n, tscAux: AUX });
    await cpu.run({ budget: 2n });
    clock(cpu, 102n);
    cpu.setState(checkpoint);
    clock(cpu, 102n);
    await cpu.run({ budget: 2n });
    clock(cpu, 104n);
    cpu.setContext(cpu.readContext());
    clock(cpu, 104n);
    const warm = cpu.readState();
    warm.rip = ENTRY + 1n;
    cpu.setState(warm);
    cpu.setTimeState({ tsc: 777n, tscAux: 7 });
    const result = await cpu.run({ budget: 1n });
    equal(result.resources.compilations, 0, 'host time import preserves warm code');
    equal(sample(cpu), 777n, 'cached time live');
    equal(result.state.registers[1], 7n, 'cached AUX live');
    clock(cpu, 778n, 7);
    cases++;
  });
  await using(side, '90', { mode: 'long64', bits: 64 }, async (cpu) => {
    cpu.setTimeState({ tsc: 100n, tscAux: AUX });
    let completed: Promise<unknown> | undefined;
    let caught: unknown;
    try {
      cpu.setTimeState({
        get tsc() {
          completed = cpu.run({ budget: 1n });
          return 500n;
        },
        tscAux: 7,
      });
    } catch (error) {
      caught = error;
    }
    equal(caught instanceof Error, true, 'run during capture rejects stale setter');
    await completed;
    clock(cpu, 101n);
    cases++;
  });
  await using(side, '90', { mode: 'real', bits: 16, family: 'pg0' }, async (cpu) => {
    cpu.setTimeState({ tsc: 100n, tscAux: AUX });
    let caught: unknown;
    try {
      cpu.setTimeState({
        get tsc() {
          cpu.reset();
          return 500n;
        },
        tscAux: 7,
      });
    } catch (error) {
      caught = error;
    }
    equal(caught instanceof Error, true, 'reset during capture rejects setter');
    clock(cpu, 0n, 0);
    cases++;
  });
  return cases;
}
const runners: Record<Group, (side: Side) => Promise<number>> = {
  identity,
  ledger,
  raw,
  tsd,
  msr,
  accounting,
  debug,
  lifetime,
};
export async function checkIdentityTime(
  side: Side,
  selected: readonly Group[] = groups,
): Promise<{ groups: { name: Group; cases: number }[]; cases: number }> {
  const results = [];
  for (const name of selected) results.push({ name, cases: await runners[name](side) });
  return { groups: results, cases: results.reduce((total, row) => total + row.cases, 0) };
}
