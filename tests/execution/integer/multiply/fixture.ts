import type { Cpu, State } from '../../../../host/index.js';
import { CODE, changed, createFixture, exit, memory } from '../../../support/fixture.js';
import { completed } from '../arithmetic/fixture.js';
import { input as scalarInput, RAM, setup, view, written } from '../data/fixture.js';
import type { Pair } from './oracle.js';

export {
  byte,
  little,
  modrm,
  noFault,
  patch,
  prefix,
  RAM,
  setup,
  view,
  written,
} from '../data/fixture.js';
export { completed } from '../arithmetic/fixture.js';

export function input(pc = CODE, registers: Record<number, bigint> = {}, flags = 0x8d7n) {
  return scalarInput(pc, { 2: 0x99aabbccddeeff11n, ...registers }, flags);
}

export function dividend(before: State, width: number) {
  return width === 8
    ? view(before.registers[0]!, 16)
    : view(before.registers[2]!, width) * 2n ** BigInt(width) + view(before.registers[0]!, width);
}

export function paired(before: State, width: number, value: Pair) {
  return width === 8
    ? { 0: written(before.registers[0]!, value.low + value.high * 256n, 16) }
    : {
        0: written(before.registers[0]!, value.low, width),
        2: written(before.registers[2]!, value.high, width),
      };
}

export interface Packet {
  code: string;
  registers?: Record<number, bigint>;
  flags?: bigint;
  writes?: Record<number, bigint>;
  outputFlags?: bigint;
  flagMask?: bigint;
  divideError?: boolean;
  ram?: string;
  ramAfter?: string;
  ramBase?: bigint;
  codeBase?: bigint;
  nextPc?: bigint;
}

export async function runPacket(cpu: Cpu, packet: Packet) {
  const pc = packet.codeBase ?? CODE;
  const before = input(pc, packet.registers, packet.flags);
  cpu.setState(before);
  const result = await cpu.run({ budget: 1n });
  if (packet.divideError) {
    exit(result, 'divide-error', 1n, 0n, before);
    if (result.fault !== undefined) throw new Error('divide error contains access metadata');
  } else {
    completed(
      result,
      changed(
        before,
        packet.nextPc ?? BigInt.asUintN(64, pc + BigInt(packet.code.length / 2)),
        packet.writes,
        packet.outputFlags ?? 2n,
      ),
      packet.flagMask ?? 0x803n,
    );
  }
  memory(cpu, packet.ramBase ?? setup.ramBase, packet.ramAfter ?? packet.ram ?? RAM);
  memory(cpu, pc, packet.code);
  return result;
}

export async function one(using: ReturnType<typeof createFixture>, packet: Packet) {
  try {
    await using(packet.code, (cpu) => runPacket(cpu, packet).then(() => {}), {
      codeBase: packet.codeBase ?? CODE,
      ramBase: packet.ramBase ?? setup.ramBase,
      ram: packet.ram ?? RAM,
    });
  } catch (cause) {
    throw new Error(`multiply/divide packet ${packet.code}`, { cause });
  }
}
