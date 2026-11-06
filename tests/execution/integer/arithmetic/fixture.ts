import type { Cpu, RunResult, State } from '../../../../host/index.js';
import { CODE, changed, createFixture, equal, exit, memory } from '../../../support/fixture.js';
import { input, RAM, setup, view, written } from '../data/fixture.js';

export {
  byte,
  input,
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

export interface Packet {
  code: string;
  registers?: Record<number, bigint>;
  flags?: bigint;
  writes?: Record<number, bigint>;
  outputFlags?: bigint;
  flagMask?: bigint;
  undefinedWord?: number;
  ram?: string;
  ramBase?: bigint;
  ramAfter?: string;
  codeBase?: bigint;
}

export function seed(value: bigint, width: number, old = 0xfedcba9876543210n) {
  const mask = 2n ** BigInt(width) - 1n;
  return (old & ~mask) | view(value, width);
}

export function completed(
  result: RunResult,
  expected: State,
  mask = 0x8d7n,
  undefinedWord?: number,
) {
  const registers = [...expected.registers];
  if (undefinedWord !== undefined)
    registers[undefinedWord] = written(
      registers[undefinedWord]!,
      view(result.state.registers[undefinedWord]!, 16),
      16,
    );
  exit(result, 'budget', 1n, 1n, { ...expected, registers, flags: result.state.flags });
  equal(result.state.flags & ~0x8d7n, 0n, 'flags contain no unsupported bits');
  equal(result.state.flags & 2n, 2n, 'fixed flag bit one');
  equal(result.state.flags & mask, expected.flags & mask, 'defined and preserved flags');
  equal(result.fault, undefined, 'successful operation has no fault');
}

export async function runPacket(cpu: Cpu, packet: Packet) {
  const codeBase = packet.codeBase ?? CODE;
  const before = input(codeBase, packet.registers, packet.flags);
  cpu.setState(before);
  const result = await cpu.run({ budget: 1n });
  completed(
    result,
    changed(
      before,
      BigInt.asUintN(64, codeBase + BigInt(packet.code.length / 2)),
      packet.writes,
      packet.outputFlags ?? before.flags,
    ),
    packet.flagMask,
    packet.undefinedWord,
  );
  memory(cpu, packet.ramBase ?? setup.ramBase, packet.ramAfter ?? packet.ram ?? RAM);
  memory(cpu, codeBase, packet.code);
  return result;
}

export async function one(using: ReturnType<typeof createFixture>, packet: Packet) {
  try {
    await using(
      packet.code,
      async (cpu) => {
        await runPacket(cpu, packet);
      },
      {
        codeBase: packet.codeBase ?? CODE,
        ramBase: packet.ramBase ?? setup.ramBase,
        ram: packet.ram ?? RAM,
      },
    );
  } catch (cause) {
    throw new Error(`integer arithmetic packet ${packet.code}`, { cause });
  }
}
