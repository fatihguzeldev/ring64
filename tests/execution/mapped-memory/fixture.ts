import {
  createCpu,
  type Cpu,
  type Limits,
  type MemoryBackingInput,
  type MemoryMapping,
  type MemoryPermissions,
  type State,
} from '../../../host/index.js';
import { LIMITS, hex } from '../../support/fixture.js';

export const BASE = 0x1000n;
export const RX: MemoryPermissions = { read: true, write: false, execute: true };
export const RW: MemoryPermissions = { read: true, write: true, execute: false };
export const RWX: MemoryPermissions = { read: true, write: true, execute: true };
export const X: MemoryPermissions = { read: false, write: false, execute: true };

export function mapping(
  base: bigint,
  backing: string,
  length: number,
  permissions: MemoryPermissions,
  offset = 0,
): MemoryMapping {
  return { base, backing, offset, length, permissions: { ...permissions } };
}

export function input(registers: Record<number, bigint> = {}, rip = BASE, flags = 0x8d7n): State {
  const banks = Array.from({ length: 16 }, (_, i) => 0x1122334400000000n + BigInt(i));
  banks[0] = 0x1122334455667788n;
  for (const [index, value] of Object.entries(registers)) banks[Number(index)] = value;
  return { registers: banks, flags, rip };
}

export async function using(
  compiler: WebAssembly.Module,
  backings: MemoryBackingInput[],
  mappings: MemoryMapping[],
  run: (cpu: Cpu) => Promise<void>,
  limits: Partial<Limits> = {},
  entry = BASE,
): Promise<void> {
  const cpu = await createCpu({
    compiler,
    memory: { backings, mappings },
    entry,
    memoryLimits: { maxBackings: 64, maxMappings: 256, maxBackingBytes: 1048576 },
    limits: { ...LIMITS, ...limits },
  });
  try {
    await run(cpu);
  } finally {
    cpu.dispose();
  }
}

export const backing = (id: string, bytes: string): MemoryBackingInput => ({
  id,
  bytes: hex(bytes),
});
