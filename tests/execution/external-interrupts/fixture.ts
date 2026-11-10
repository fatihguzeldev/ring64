import { initial, snapshot, loadedCode, loadedData } from '../software-events/fixture.js';
import type { Data } from '../modes/fixture.js';

export {
  using,
  gate,
  image,
  encoded,
  CODE16,
  CODE32,
  CODE64,
  DATA16,
  DATA32,
  same,
  equal,
  check,
  throws,
  preserveNumeric,
  noDeliveryFault,
  type Cpu,
  type Scenario,
} from '../software-events/fixture.js';
export { snapshot, loadedCode, loadedData };
export type { Data };
export const EMPTY = { irq: null, nmiPending: false, nmiBlocked: false };
export const STACK = 0x7f00n;
export const FILL = 'a5'.repeat(256);
export const DESCRIPTORS = { base: 0x4008n, bytes: 'ffff0000009bcf00ffff00000093cf00' };

export function execution() {
  const value = snapshot('protected');
  value.segments.cs = loadedCode(32);
  value.segments.ss = loadedData(32);
  value.idtr = { base: 0x8000n, limit: 0x7ff };
  return value;
}

export function input(
  rip = 0x1000n,
  registers: Record<number, bigint> = { 4: 0x8000n },
  flags = 2n,
  interruptibility = { sti: false, ss: false },
) {
  return { ...initial(rip, registers, flags, interruptibility), interrupts: { ...EMPTY } };
}
