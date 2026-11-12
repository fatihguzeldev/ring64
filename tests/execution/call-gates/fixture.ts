import {
  createCpu,
  type Cpu,
  type ExecutionContextSnapshot,
  type Limits,
  type Options,
  type PagingState,
  type RunResult,
} from '../../../host/index.js';
import { loadedCode, loadedData, snapshot } from '../far-control/fixture.js';
import { LIMITS, equal, hex } from '../../support/fixture.js';

export {
  check,
  equal,
  hex,
  initial,
  changed,
  state,
  type Scenario,
} from '../../support/fixture.js';
export { bytes, same, preserveNumeric, operandPrefix } from '../far-control/fixture.js';
export type { Cpu, ExecutionContextSnapshot, RunResult } from '../../../host/index.js';

export type Family = 'linear' | 'pg0' | 'legacy32' | 'pae' | 'ia32e' | 'fixed-ia32e';
export const SOURCE = 0x1000n;
export const TARGET = 0x2000n;
export const GDT = 0x6000n;
export const TSS = 0x7000n;
export const OLD_SP = 0x4000n;
export const NEW_SP = 0x9000n;
export const GATE = 0x3b;
export const RAM_SIZE = 0x20000;

export function little(value: bigint, width: number): Uint8Array {
  return Uint8Array.from({ length: width }, (_, index) =>
    Number((value >> BigInt(index * 8)) & 255n),
  );
}

export function put(bytes: Uint8Array, offset: number, value: bigint, width: number): void {
  bytes.set(little(value, width), offset);
}

export function codeDescriptor(
  width: 16 | 32 | 64,
  cpl: number,
  conforming = false,
  accessed = true,
): Uint8Array {
  return hex(
    'ffff000000' +
      (0x9a | (cpl << 5) | (conforming ? 4 : 0) | Number(accessed)).toString(16) +
      (width === 64 ? 'af' : width === 32 ? 'cf' : '00') +
      '00',
  );
}

export function dataDescriptor(width: 16 | 32, cpl: number, accessed = true): Uint8Array {
  return hex(
    'ffff000000' +
      (0x92 | (cpl << 5) | Number(accessed)).toString(16) +
      (width === 32 ? 'cf' : '00') +
      '00',
  );
}

export function gateDescriptor(
  width: 16 | 32 | 64,
  count = 0,
  offset = TARGET,
  selector = 8,
  dpl = 3,
  present = true,
): Uint8Array {
  const bytes = new Uint8Array(width === 64 ? 16 : 8);
  put(bytes, 0, offset, 2);
  put(bytes, 2, BigInt(selector), 2);
  bytes[4] = count;
  bytes[5] = (present ? 0x80 : 0) | (dpl << 5) | (width === 16 ? 4 : 12);
  put(bytes, 6, offset >> 16n, 2);
  if (width === 64) put(bytes, 8, offset >> 32n, 4);
  return bytes;
}

export interface Setup {
  family?: Family;
  mode?: 'protected' | 'compatibility' | 'long64';
  source32?: boolean;
  oldStack32?: boolean;
  newStack32?: boolean;
  tss32?: boolean;
  cpl?: number;
  targetCpl?: number;
  targetWidth?: 16 | 32 | 64;
  gateWidth?: 16 | 32 | 64;
  count?: number;
  code?: string;
  targetCode?: string;
  newSp?: bigint;
  conforming?: boolean;
  gateDpl?: number;
  gatePresent?: boolean;
  codeAccessed?: boolean;
  stackAccessed?: boolean;
  gateSelector?: number;
  pointerWidth?: 16 | 32 | 64;
  entry?: bigint;
  limit?: Partial<Limits>;
  prepare?: (bytes: Uint8Array, context: ExecutionContextSnapshot) => void;
}

export function contextFor(setup: Setup = {}): ExecutionContextSnapshot {
  const mode = setup.mode ?? 'protected';
  const cpl = setup.cpl ?? 3;
  const execution = snapshot(mode, cpl, setup.source32 ?? true, setup.oldStack32 ?? true);
  execution.segments.cs = loadedCode(
    mode === 'long64' ? 64 : (setup.source32 ?? true) ? 32 : 16,
    0x18 | cpl,
    cpl,
  );
  execution.segments.ss = loadedData((setup.oldStack32 ?? true) ? 32 : 16, 0x20 | cpl, cpl);
  execution.gdtr = { base: GDT, limit: 0x7f };
  execution.tr = {
    selector: 0x28,
    valid: true,
    base: TSS,
    limit: 0x100,
    attributes:
      mode === 'long64' || mode === 'compatibility' || (setup.tss32 ?? true) ? 0x8b : 0x83,
  };
  return execution;
}

export function fixtureOptions(compiler: WebAssembly.Module, setup: Setup = {}): Options {
  const family = setup.family ?? 'linear';
  const execution = contextFor(setup);
  const bytes = new Uint8Array(RAM_SIZE).fill(0xa5);
  bytes.fill(0, Number(GDT), Number(GDT) + 0x80);
  bytes.fill(0, Number(TSS), Number(TSS) + 0x100);
  const ia32e = execution.mode === 'compatibility' || execution.mode === 'long64';
  const gateWidth = setup.gateWidth ?? (ia32e ? 64 : 32);
  const targetWidth = setup.targetWidth ?? (ia32e ? 64 : 32);
  const targetCpl = setup.targetCpl ?? 0;
  const gateSelector = setup.gateSelector ?? GATE;
  const instruction =
    setup.code ??
    (execution.mode === 'long64'
      ? 'ff1b'
      : (setup.source32 ?? true)
        ? '9a00000000' +
          Number(gateSelector & 255)
            .toString(16)
            .padStart(2, '0') +
          Number(gateSelector >> 8)
            .toString(16)
            .padStart(2, '0')
        : '9a0000' +
          Number(gateSelector & 255)
            .toString(16)
            .padStart(2, '0') +
          Number(gateSelector >> 8)
            .toString(16)
            .padStart(2, '0'));
  bytes.set(hex(instruction), Number(setup.entry ?? SOURCE));
  bytes.set(
    hex(
      setup.targetCode ??
        (gateWidth === 64 ? '48cb' : (gateWidth === targetWidth ? '' : '66') + 'cb'),
    ),
    Number(TARGET),
  );
  if (execution.mode === 'long64') {
    const pointerWidth = (setup.pointerWidth ?? 32) / 8;
    put(bytes, 0x5000, 0n, pointerWidth);
    put(bytes, 0x5000 + pointerWidth, BigInt(gateSelector), 2);
  }
  bytes.set(
    codeDescriptor(targetWidth, targetCpl, setup.conforming ?? false, setup.codeAccessed ?? true),
    Number(GDT) + 8,
  );
  bytes.set(
    dataDescriptor((setup.newStack32 ?? true) ? 32 : 16, targetCpl, setup.stackAccessed ?? true),
    Number(GDT) + 0x10,
  );
  bytes.set(
    codeDescriptor(
      execution.mode === 'long64' ? 64 : (setup.source32 ?? true) ? 32 : 16,
      execution.cpl,
    ),
    Number(GDT) + 0x18,
  );
  bytes.set(
    dataDescriptor((setup.oldStack32 ?? true) ? 32 : 16, execution.cpl),
    Number(GDT) + 0x20,
  );
  bytes.set(
    gateDescriptor(
      gateWidth,
      setup.count ?? 0,
      TARGET,
      8,
      setup.gateDpl ?? 3,
      setup.gatePresent ?? true,
    ),
    Number(GDT) + ((setup.gateSelector ?? GATE) & 0xfff8),
  );
  const newSp = setup.newSp ?? NEW_SP;
  if (ia32e) put(bytes, Number(TSS) + 4 + targetCpl * 8, newSp, 8);
  else {
    const wide = setup.tss32 ?? true;
    const offset = (wide ? 4 : 2) + targetCpl * (wide ? 8 : 4);
    put(bytes, Number(TSS) + offset, newSp, wide ? 4 : 2);
    put(bytes, Number(TSS) + offset + (wide ? 4 : 2), BigInt(0x10 | targetCpl), 2);
  }
  for (let index = 0; index < 31; index++)
    put(bytes, Number(OLD_SP) + index * (gateWidth / 8), BigInt(0xa100 + index), gateWidth / 8);
  let paging: PagingState | undefined;
  if (family === 'pg0') paging = { cr0: 0x33n, cr2: 0xdeadn, cr3: 0x18000n, cr4: 0x608n, efer: 0n };
  else if (family === 'legacy32') {
    bytes.fill(0, 0x18000, 0x1a000);
    put(bytes, 0x18000, 0x19027n, 4);
    for (let index = 0; index < RAM_SIZE / 4096; index++)
      put(
        bytes,
        0x19000 + index * 4,
        BigInt(index * 4096) | (index === 6 || index === 7 || index === 8 ? 0x63n : 0x67n),
        4,
      );
    paging = { cr0: 0x80000033n, cr2: 0xdeadn, cr3: 0x18000n, cr4: 0x608n, efer: 0n };
  } else if (family === 'pae') {
    bytes.fill(0, 0x18000, 0x1a000);
    put(bytes, 0x18000, 0x19027n, 8);
    for (let index = 0; index < RAM_SIZE / 4096; index++)
      put(
        bytes,
        0x19000 + index * 8,
        BigInt(index * 4096) | (index === 6 || index === 7 || index === 8 ? 0x63n : 0x67n),
        8,
      );
    paging = {
      cr0: 0x80000033n,
      cr2: 0xdeadn,
      cr3: 0x17000n,
      cr4: 0x628n,
      efer: 0n,
      pdpte: [0x18001n, 0n, 0n, 0n],
    };
  } else if (family === 'ia32e' || family === 'fixed-ia32e') {
    bytes.fill(0, 0x14000, 0x18000);
    put(bytes, 0x14000, 0x15027n, 8);
    put(bytes, 0x15000, 0x16027n, 8);
    put(bytes, 0x16000, 0x17027n, 8);
    for (let index = 0; index < RAM_SIZE / 4096; index++)
      put(
        bytes,
        0x17000 + index * 8,
        BigInt(index * 4096) | (index === 6 || index === 7 || index === 8 ? 0x63n : 0x67n),
        8,
      );
    paging = { cr0: 0x80000033n, cr2: 0xdeadn, cr3: 0x14000n, cr4: 0x628n, efer: 0x500n };
  }
  setup.prepare?.(bytes, execution);
  const common = {
    compiler,
    context: execution,
    entry: setup.entry ?? SOURCE,
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
    memoryLimits: { maxBackings: 4, maxMappings: 16, maxBackingBytes: RAM_SIZE * 2 },
    limits: { ...LIMITS, ...setup.limit },
  };
  if (family === 'linear') return common;
  if (family === 'fixed-ia32e') return { ...common, memoryModel: 'ia32e-paged', paging: paging! };
  return { ...common, memoryModel: 'physical', paging: paging! };
}

export async function usingGate(
  compiler: WebAssembly.Module,
  setup: Setup,
  run: (cpu: Cpu) => Promise<void>,
): Promise<void> {
  const cpu = await createCpu(fixtureOptions(compiler, setup));
  try {
    await run(cpu);
  } finally {
    cpu.dispose();
  }
}

export function read(
  cpu: Cpu,
  address: bigint,
  length: number,
  family: Family = 'linear',
): Uint8Array {
  return family === 'linear'
    ? cpu.readMemory(address, length)
    : cpu.readPhysicalMemory(address, length);
}
export function write(
  cpu: Cpu,
  address: bigint,
  bytes: Uint8Array,
  family: Family = 'linear',
): void {
  if (family === 'linear') cpu.writeMemory(address, bytes);
  else cpu.writePhysicalMemory(address, bytes);
}
export function scalar(
  cpu: Cpu,
  address: bigint,
  width: number,
  family: Family = 'linear',
): bigint {
  const bytes = read(cpu, address, width, family);
  return bytes.reduceRight((value, byte) => (value << 8n) | BigInt(byte), 0n);
}
export function complete(result: RunResult, retired = 1n): void {
  equal(result.reason, 'budget', 'completed selected gate');
  equal(result.retired, retired, 'retired instruction count');
  equal(result.repeatIterations, 0n, 'no copied REP elements');
}
