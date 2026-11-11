import {
  createCpu,
  type Cpu,
  type ExecutionContext,
  type Limits,
  type PagingState,
  type IoProvider,
} from '../../../host/index.js';
import { LIMITS, hex } from '../../support/fixture.js';
export { check, equal, hex, initial, type Scenario } from '../../support/fixture.js';
export { same } from '../far-control/fixture.js';
export type { Cpu, PagingState } from '../../../host/index.js';
export const PC = 0x400000n;
export const BANK: PagingState = {
  cr0: 0x80000033n,
  cr2: 0n,
  cr3: 0x1000n,
  cr4: 0x628n,
  efer: 0x500n,
};

export function little(words: readonly bigint[], width = 8): Uint8Array {
  return Uint8Array.from(
    words.flatMap((word) =>
      Array.from({ length: width }, (_, i) => Number((word >> BigInt(8 * i)) & 255n)),
    ),
  );
}

export function word(cpu: Cpu, physical: bigint): bigint {
  const bytes = cpu.readPhysicalMemory(physical, 8);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true);
}

export interface PagedSetup {
  io?: IoProvider;
  code?: string;
  words?: readonly (readonly [bigint, bigint])[];
  spans?: readonly {
    physical: bigint;
    bytes: Uint8Array;
    read?: boolean;
    write?: boolean;
    execute?: boolean;
  }[];
  context?: ExecutionContext;
  bank?: PagingState;
  limits?: Partial<Limits>;
  tableWindows?: readonly { physical: bigint; offset: number; length: number; write: boolean }[];
}

export async function usingPaged(
  compiler: WebAssembly.Module,
  setup: PagedSetup,
  run: (cpu: Cpu) => Promise<void>,
): Promise<void> {
  const tables = new Uint8Array(0x4000);
  for (const [address, value] of [
    [0x1000n, 0x2007n],
    [0x2000n, 0x3007n],
    [0x3010n, 0x4007n],
    [0x4000n, 0x9007n],
    ...(setup.words ?? []),
  ] as const)
    tables.set(little([value]), Number(address - 0x1000n));
  const code = new Uint8Array(0x1000).fill(0x82);
  code.set(hex(setup.code ?? '90'));
  const spans = [
    { physical: 0x9000n, bytes: code, read: true, write: true, execute: true },
    ...(setup.spans ?? []),
  ];
  const backings = [
    { id: 'tables', bytes: tables },
    ...spans.map((span, index) => ({ id: `span${index}`, bytes: span.bytes })),
  ];
  const mappings = [
    ...(setup.tableWindows ?? [{ physical: 0x1000n, offset: 0, length: 0x4000, write: true }]).map(
      (window) => ({
        base: window.physical,
        backing: 'tables',
        offset: window.offset,
        length: window.length,
        permissions: { read: true, write: window.write, execute: false },
      }),
    ),
    ...spans.map((span, index) => ({
      base: span.physical,
      backing: `span${index}`,
      offset: 0,
      length: span.bytes.length,
      permissions: {
        read: span.read ?? true,
        write: span.write ?? true,
        execute: span.execute ?? false,
      },
    })),
  ];
  const cpu = await createCpu({
    compiler,
    ...(setup.io === undefined ? {} : { io: setup.io }),
    memoryModel: 'ia32e-paged',
    paging: setup.bank ?? BANK,
    memory: { backings, mappings },
    entry: PC,
    memoryLimits: {
      maxBackings: backings.length + 4,
      maxMappings: mappings.length + 8,
      maxBackingBytes: backings.reduce((sum, b) => sum + b.bytes.length, 0) + 0x10000,
    },
    limits: { ...LIMITS, ...setup.limits },
    ...(setup.context === undefined ? {} : { context: setup.context }),
  });
  try {
    await run(cpu);
  } finally {
    cpu.dispose();
  }
}
