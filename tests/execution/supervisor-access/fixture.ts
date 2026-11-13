import type {
  Cpu,
  ExecutionContextSnapshot,
  IoProvider,
  Options,
  PagingState,
  State,
} from '../../../host/index.js';
import { longSnapshot, protectedSnapshot } from '../../support/context.js';
import { LIMITS, hex } from '../../support/fixture.js';

export { check, hex, type Scenario } from '../../support/fixture.js';
export type { Cpu, PagingState } from '../../../host/index.js';
export type Side = { createCpu(options: Options): Promise<Cpu>; compiler: WebAssembly.Module };
export type Family = 'non-pae' | 'pae' | 'ia32e' | 'fixed';
export const families: Family[] = ['non-pae', 'pae', 'ia32e', 'fixed'];
export const PC = 0x1000n;
export const DATA = 0x6000n;
export const AC = 0x40000n;
export const SMEP = 0x100000n;
export const SMAP = 0x200000n;
export const AUX = 0x89abcdef;

export function same(actual: unknown, expected: unknown, label: string): void {
  const encode = (value: unknown): string =>
    JSON.stringify(value, (_, item: unknown) =>
      typeof item === 'bigint'
        ? item.toString(16)
        : ArrayBuffer.isView(item)
          ? Array.from(item as Uint8Array)
          : item !== null && typeof item === 'object' && !Array.isArray(item)
            ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
            : item,
    );
  if (encode(actual) !== encode(expected))
    throw Error(`${label}: ${encode(actual)} != ${encode(expected)}`);
}

export function put(bytes: Uint8Array, at: number, value: bigint, width = 8): void {
  for (let i = 0; i < width; i++) bytes[at + i] = Number((value >> BigInt(8 * i)) & 255n);
}

export function word(cpu: Cpu, at: number, width = 8): bigint {
  const bytes = cpu.readPhysicalMemory(BigInt(at), width);
  return bytes.reduceRight((value, byte) => (value << 8n) | BigInt(byte), 0n);
}

export function state(flags = 2n, rip = PC): State {
  const registers = Array.from({ length: 16 }, (_, i) => 0x1122334400000000n + BigInt(i));
  registers[0] = 0x11223344cafebaben;
  registers[3] = DATA;
  registers[4] = 0x9ff0n;
  registers[6] = DATA;
  registers[7] = DATA;
  return {
    registers,
    flags,
    rip,
    interruptibility: { sti: false, ss: false },
    event: { kind: 'ready' },
    interrupts: { irq: null, nmiPending: false, nmiBlocked: false },
  };
}

export function context(family: Family, cpl = 0, bits?: 16 | 32 | 64): ExecutionContextSnapshot {
  const selectedBits = bits ?? (family === 'ia32e' || family === 'fixed' ? 64 : 32);
  const result = selectedBits === 64 ? longSnapshot() : protectedSnapshot();
  result.mode =
    selectedBits === 64
      ? 'long64'
      : family === 'ia32e' || family === 'fixed'
        ? 'compatibility'
        : 'protected';
  result.cpl = cpl;
  result.segments.cs.default32 = selectedBits === 32;
  for (const [name, segment] of Object.entries(result.segments)) {
    segment.dpl = cpl;
    segment.selector = (name === 'cs' ? 8 : 16) | cpl;
  }
  result.gdtr = { base: 0x7000n, limit: 0x3f };
  result.idtr = { base: 0x8000n, limit: 0x7ff };
  return result;
}

export interface Fixture {
  options: Options;
  bytes: Uint8Array;
  paging: PagingState;
  family: Family;
  bits: 16 | 32 | 64;
  width: 4 | 8;
  pt: number;
  upper: number;
  leaf(linear: number, value: bigint): void;
}

// These are authored page words and byte programs, not a production walker or permission oracle.
export function fixture(
  side: Side,
  family: Family,
  code: string,
  setup: { cpl?: number; bits?: 16 | 32 | 64; io?: IoProvider } = {},
): Fixture {
  const bits = setup.bits ?? (family === 'ia32e' || family === 'fixed' ? 64 : 32);
  const bytes = new Uint8Array(0x40000).fill(0xa5);
  bytes.fill(0, 0x1000, 0x6000);
  bytes.fill(0x90, 0x8000, 0x9000);
  bytes.set(hex(code), 0x8000);
  bytes.set(hex('12345678'), 0xa000);
  bytes.fill(0, 0xb000, 0x10000);
  bytes.set(
    hex('0000000000000000ffff0000009bcf00ffff00000093cf00ffff000000fbcf00ffff000000f3cf00'),
    0xb000,
  );
  const cpl = setup.cpl ?? 0;
  const width = family === 'non-pae' ? 4 : 8;
  const pt = family === 'non-pae' ? 0x2000 : family === 'pae' ? 0x3000 : 0x4000;
  const upper = family === 'non-pae' ? 0x1000 : family === 'pae' ? 0x2000 : 0x3000;
  const paging: PagingState = {
    cr0: 0x80000033n,
    cr2: 0xdeadn,
    cr3: 0x1000n,
    cr4: family === 'non-pae' ? 0x608n : 0x628n,
    efer: family === 'ia32e' || family === 'fixed' ? 0x500n : 0n,
    ...(family === 'pae'
      ? { pdpte: [0x2001n, 0n, 0n, 0n] as [bigint, bigint, bigint, bigint] }
      : {}),
  };
  if (family === 'pae') put(bytes, 0x1000, 0x2001n);
  else if (family === 'ia32e' || family === 'fixed') {
    put(bytes, 0x1000, 0x2027n);
    put(bytes, 0x2000, 0x3027n);
  }
  put(bytes, upper, BigInt(pt) | 0x27n, width);
  for (let page = 0; page < 32; page++)
    put(bytes, pt + page * width, BigInt(0x10000 + page * 0x1000) | 0x67n, width);
  for (const [page, physical] of [
    [0, 0x7000],
    [1, 0x8000],
    [4, 0x9000],
    [6, 0xa000],
    [7, 0xb000],
    [8, 0xc000],
    [9, 0xd000],
    [11, 0xf000],
  ] as const)
    put(bytes, pt + page * width, BigInt(physical) | 0x63n, width);
  put(bytes, pt + width, 0x8063n | (cpl === 3 ? 4n : 0n), width);
  const options: Options = {
    compiler: side.compiler,
    context: context(family, cpl, bits),
    memoryModel: family === 'fixed' ? 'ia32e-paged' : 'physical',
    paging,
    entry: PC,
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
    memoryLimits: { maxBackings: 8, maxMappings: 32, maxBackingBytes: 0x80000 },
    limits: { ...LIMITS },
    ...(setup.io === undefined ? {} : { io: setup.io }),
  };
  return {
    options,
    bytes,
    paging,
    family,
    bits,
    width,
    pt,
    upper,
    leaf(linear, value) {
      put(bytes, pt + Math.floor(linear / 4096) * width, value, width);
    },
  };
}

export async function using(
  side: Side,
  input: Fixture,
  run: (cpu: Cpu) => Promise<void>,
): Promise<void> {
  const cpu = await side.createCpu(input.options);
  try {
    await run(cpu);
  } finally {
    cpu.dispose();
  }
}

export function preserved(cpu: Cpu): () => void {
  const before = [cpu.readXmmState(), cpu.readMxcsr(), cpu.readX87State()];
  return () =>
    same([cpu.readXmmState(), cpu.readMxcsr(), cpu.readX87State()], before, 'numeric preservation');
}

export function memory(cpu: Cpu, expected: Uint8Array, label: string): void {
  const actual = cpu.readPhysicalMemory(0n, expected.length);
  if (actual.length !== expected.length) throw Error(`${label}: byte length`);
  for (let i = 0; i < expected.length; i++)
    if (actual[i] !== expected[i])
      throw Error(`${label}: physical ${i.toString(16)}: ${actual[i]} != ${expected[i]}`);
}

export function dwordMemory(bits: number, write = false): string {
  return (bits === 16 ? '6667' : '') + (write ? '8903' : '8b03');
}
