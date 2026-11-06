import type { Cpu, Limits, RunResult } from '../../../host/index.js';
import { CODE, createFixture, initial } from '../fixture.js';

export const RAM = 'a5'.repeat(64);
export const FLAGS = [2n, 3n, 6n, 0x12n, 0x42n, 0x82n, 0x802n, 0x8d7n];
export const PROGRAM = 'e80b000000b901000000eb1400000000ba02000000c3';

export function input(rip = CODE, registers: Record<number, bigint> = {}, flags = 0x8d7n) {
  return initial(rip, { 4: 0x4020n, ...registers }, flags);
}

export function word(value: bigint): string {
  return Array.from({ length: 8 }, (_, index) =>
    Number((value >> BigInt(index * 8)) & 255n)
      .toString(16)
      .padStart(2, '0'),
  ).join('');
}

export function stack(value: bigint, offset = 32, length = 64): string {
  return 'a5'.repeat(offset) + word(value) + 'a5'.repeat(length - offset - 8);
}

export function noFault(result: RunResult) {
  if (result.fault !== undefined) throw new Error('unexpected access fault metadata');
}

export function createStackFixture(core: WebAssembly.Module) {
  const using = createFixture(core);
  return (
    code: string,
    run: (cpu: Cpu) => Promise<void>,
    setup: { codeBase?: bigint; ramBase?: bigint; ram?: string; limits?: Partial<Limits> } = {},
  ) => using(code, run, { ramBase: 0x4000n, ram: RAM, ...setup });
}
