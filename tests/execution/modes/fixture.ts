import {
  createCpu,
  type Cpu,
  type ExecutionContext,
  type LoadedSegment,
  type Limits,
  type State,
} from '../../../host/index.js';
import { LIMITS, hex, type Scenario } from '../../support/fixture.js';
export type { Scenario };
export const LONG: ExecutionContext = { mode: 'long64', fsBase: 0n, gsBase: 0n };
export function segment(
  type: LoadedSegment['type'] = 'read-write',
  base = 0n,
  limit = 0xffffffff,
  default32 = true,
): LoadedSegment {
  return { base, limit, default32, usable: true, type };
}
export function context(
  mode: 'real' | 'virtual8086' | 'protected' | 'compatibility' = 'protected',
  code32 = true,
  stack32 = true,
): Extract<ExecutionContext, { segments: unknown }> {
  const value: Extract<ExecutionContext, { segments: unknown }> = {
    mode,
    segments: {
      cs: segment('readable-code', 0n, 0xffffffff, code32),
      ss: segment('read-write', 0n, 0xffffffff, stack32),
      ds: segment(),
      es: segment(),
      fs: segment(),
      gs: segment(),
    },
  };
  if (mode === 'virtual8086')
    for (const name of ['cs', 'ss', 'ds', 'es', 'fs', 'gs'] as const)
      value.segments[name] = segment('read-write', 0n, 0xffff, false);
  return value;
}
export function input(
  rip = 0x1000n,
  registers: Record<number, bigint> = {},
  flags = 0x8d7n,
): State {
  const banks = Array.from({ length: 16 }, (_, index) => 0x1122334400000000n + BigInt(index));
  banks[0] = 0x1122334455667788n;
  for (const [index, value] of Object.entries(registers)) banks[Number(index)] = value;
  return { registers: banks, flags, rip };
}
export function changed(
  state: State,
  rip: bigint,
  registers: Record<number, bigint> = {},
  flags = state.flags,
): State {
  const banks = [...state.registers];
  for (const [index, value] of Object.entries(registers)) banks[Number(index)] = value;
  return { registers: banks, flags, rip };
}
export type Data = {
  base: bigint;
  bytes: string;
  read?: boolean;
  write?: boolean;
  execute?: boolean;
};
export async function using(
  compiler: WebAssembly.Module,
  code: string,
  execution: ExecutionContext,
  run: (cpu: Cpu) => Promise<void>,
  setup: {
    entry?: bigint;
    codeBase?: bigint;
    data?: Data[];
    limits?: Partial<Limits>;
    codeWrite?: boolean;
  } = {},
): Promise<void> {
  const codeBytes = hex(code);
  const backings = [
    { id: 'code', bytes: codeBytes },
    ...(setup.data ?? []).map((d, i) => ({ id: `data${i}`, bytes: hex(d.bytes) })),
  ];
  const mappings = [
    {
      base: setup.codeBase ?? setup.entry ?? 0x1000n,
      backing: 'code',
      offset: 0,
      length: codeBytes.length,
      permissions: { read: true, write: setup.codeWrite ?? false, execute: true },
    },
    ...(setup.data ?? []).map((d, i) => ({
      base: d.base,
      backing: `data${i}`,
      offset: 0,
      length: d.bytes.length / 2,
      permissions: { read: d.read ?? true, write: d.write ?? true, execute: d.execute ?? false },
    })),
  ];
  const cpu = await createCpu({
    compiler,
    context: execution,
    memory: { backings, mappings },
    entry: setup.entry ?? 0x1000n,
    memoryLimits: {
      maxBackings: backings.length + 4,
      maxMappings: mappings.length + 4,
      maxBackingBytes: backings.reduce((sum, b) => sum + b.bytes.length, 0) + 256,
    },
    limits: { ...LIMITS, ...setup.limits },
  });
  try {
    await run(cpu);
  } finally {
    cpu.dispose();
  }
}
