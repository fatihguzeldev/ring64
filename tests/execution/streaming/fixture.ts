import {
  createCpu,
  type Cpu,
  type ExecutionContext,
  type MemoryBackingInput,
  type MemoryMapping,
  type X87State,
} from '../../../host/index.js';
import { LIMITS, hex } from '../../support/fixture.js';
export * from '../x87/fixture.js';
export { segment } from '../modes/fixture.js';

export const DATA = 0x1f1e1d1c1b1a19181716151413121110n;
export const MASK64 = (1n << 64n) - 1n;
export const R = { read: true, write: false, execute: false };
export const W = { read: false, write: true, execute: false };
export const RX = { read: true, write: false, execute: true };

export function map(
  base: bigint,
  backing: string,
  length: number,
  permissions = R,
  offset = 0,
): MemoryMapping {
  return { base, backing, length, permissions, offset };
}

export async function mapped(
  compiler: WebAssembly.Module,
  code: string,
  backings: MemoryBackingInput[],
  mappings: MemoryMapping[],
  run: (cpu: Cpu) => Promise<void>,
  execution: ExecutionContext = { mode: 'long64', fsBase: 0n, gsBase: 0n },
): Promise<void> {
  const cpu = await createCpu({
    compiler,
    context: execution,
    entry: 0x1000n,
    limits: LIMITS,
    memoryLimits: { maxBackings: 32, maxMappings: 64, maxBackingBytes: 8192 },
    memory: {
      backings: [{ id: 'code', bytes: hex(code) }, ...backings],
      mappings: [map(0x1000n, 'code', code.length / 2, RX), ...mappings],
    },
  });
  try {
    await run(cpu);
  } finally {
    cpu.dispose();
  }
}

export function transition(before: X87State): X87State {
  return {
    ...before,
    registers: [...before.registers],
    statusWord: before.statusWord & ~0x3800,
    tagWord: 0,
  };
}
