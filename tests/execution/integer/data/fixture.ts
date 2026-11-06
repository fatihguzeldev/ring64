import type { RunResult, State } from '../../../../host/index.js';
import {
  CODE,
  changed,
  createFixture,
  equal,
  exit,
  initial,
  memory,
} from '../../../support/fixture.js';

export const RAM = 'a5'.repeat(64);
export const setup = { ramBase: 0x4000n, ram: RAM };

export function input(rip = CODE, registers: Record<number, bigint> = {}, flags = 0x8d7n) {
  return initial(
    rip,
    { 0: 0x1122334455667788n, 3: 0x4010n, 4: 0xaabbccddeeff0011n, ...registers },
    flags,
  );
}

export function little(value: bigint, bytes: number): string {
  return Array.from({ length: bytes }, (_, index) =>
    Number((BigInt.asUintN(bytes * 8, value) >> BigInt(index * 8)) & 255n)
      .toString(16)
      .padStart(2, '0'),
  ).join('');
}

export function patch(ram: string, offset: number, value: bigint, bytes: number) {
  return ram.slice(0, offset * 2) + little(value, bytes) + ram.slice((offset + bytes) * 2);
}

export function byte(value: number) {
  return value.toString(16).padStart(2, '0');
}

// These packets select low byte views; high-byte forms use literal encodings.
export function prefix(width: number, register = 0, rm = 0, force = false) {
  const rex = (width === 64 ? 8 : 0) | (register >= 8 ? 4 : 0) | (rm >= 8 ? 1 : 0);
  const lowByte = width === 8 && ((register & 7) >= 4 || (rm & 7) >= 4);
  return (width === 16 ? '66' : '') + (rex || lowByte || force ? byte(0x40 | rex) : '');
}

export function modrm(register: number, rm: number, mode = 3) {
  return byte((mode << 6) | ((register & 7) << 3) | (rm & 7));
}

export function view(value: bigint, width: number, high = false) {
  return BigInt.asUintN(width, high ? value >> 8n : value);
}

export function written(old: bigint, value: bigint, width: number, high = false) {
  const bits = BigInt.asUintN(width, value);
  if (width >= 32) return bits;
  const shift = high ? 8n : 0n;
  const mask = ((1n << BigInt(width)) - 1n) << shift;
  return (old & ~mask) | (bits << shift);
}

export function arithmetic(a: bigint, b: bigint, width: number, subtract = false) {
  a = view(a, width);
  b = view(b, width);
  const raw = subtract ? a - b : a + b;
  const result = view(raw, width);
  const signed = subtract
    ? BigInt.asIntN(width, a) - BigInt.asIntN(width, b)
    : BigInt.asIntN(width, a) + BigInt.asIntN(width, b);
  const bound = 1n << BigInt(width - 1);
  const carry = subtract ? a < b : raw >= 1n << BigInt(width);
  const auxiliary = subtract ? (a & 15n) < (b & 15n) : (a & 15n) + (b & 15n) > 15n;
  const overflow = signed < -bound || signed >= bound;
  return {
    result,
    flags:
      logicalFlags(result, width) |
      (carry ? 1n : 0n) |
      (auxiliary ? 0x10n : 0n) |
      (overflow ? 0x800n : 0n),
  };
}

export function logicalFlags(value: bigint, width: number) {
  const result = view(value, width);
  const ones = (result & 255n).toString(2).replaceAll('0', '').length;
  return (
    2n |
    (ones % 2 === 0 ? 4n : 0n) |
    (result === 0n ? 0x40n : 0n) |
    (result >= 1n << BigInt(width - 1) ? 0x80n : 0n)
  );
}

export function noFault(result: RunResult) {
  equal(result.fault, undefined, 'unexpected access fault metadata');
}

export function logicalExit(result: RunResult, expected: State) {
  exit(result, 'budget', 1n, 1n, { ...expected, flags: result.state.flags });
  equal(result.state.flags & ~0x8d7n, 0n, 'logical flags admit no extra bits');
  equal(result.state.flags & 2n, 2n, 'logical flags retain reserved bit one');
  equal(result.state.flags & 0x8c7n, expected.flags, 'defined logical flags');
}

export interface Packet {
  code: string;
  registers?: Record<number, bigint>;
  flags?: bigint;
  writes?: Record<number, bigint>;
  outputFlags?: bigint;
  logical?: boolean;
  ram?: string;
  ramBase?: bigint;
  ramAfter?: string;
  codeBase?: bigint;
}

export async function one(using: ReturnType<typeof createFixture>, packet: Packet) {
  const codeBase = packet.codeBase ?? CODE;
  const ramBase = packet.ramBase ?? setup.ramBase;
  const ram = packet.ram ?? RAM;
  try {
    await using(
      packet.code,
      async (cpu) => {
        const before = input(codeBase, packet.registers, packet.flags);
        cpu.setState(before);
        const result = await cpu.run({ budget: 1n });
        const expected = changed(
          before,
          BigInt.asUintN(64, codeBase + BigInt(packet.code.length / 2)),
          packet.writes,
          packet.outputFlags ?? before.flags,
        );
        if (packet.logical) logicalExit(result, expected);
        else exit(result, 'budget', 1n, 1n, expected);
        noFault(result);
        memory(cpu, ramBase, packet.ramAfter ?? ram);
        memory(cpu, codeBase, packet.code);
      },
      { codeBase, ramBase, ram },
    );
  } catch (cause) {
    throw new Error(`scalar packet ${packet.code}`, { cause });
  }
}
