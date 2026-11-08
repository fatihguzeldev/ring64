import type { Cpu, RunResult, X87State } from '../../../host/index.js';
import { equal } from '../../support/fixture.js';
import { banks, xmm } from '../simd/fixture.js';
export { LONG, context, input, changed, using, type Scenario } from '../modes/fixture.js';
export { outcome } from '../strings/fixture.js';
export { banks, xmm, bytes, profiles } from '../simd/fixture.js';
export { equal, hex, memory, fault, throws } from '../../support/fixture.js';

export const ONE = 0x3fff8000000000000000n;
export const INDEFINITE = 0xffffc000000000000000n;
export const NUMERIC_STATUS = 0xbaff;
export const OTHER_MXCSR = 0xffc5;

export function raw(exponent: number, significand = 0x8000000000000000n): bigint {
  return (BigInt(exponent) << 64n) | significand;
}
export function integer(value: bigint): bigint {
  if (value === 0n) return 0n;
  const magnitude = value < 0n ? -value : value,
    bits = magnitude.toString(2).length;
  return raw((value < 0n ? 0x8000 : 0) | (0x3fff + bits - 1), magnitude << BigInt(64 - bits));
}
export function clone(state: X87State): X87State {
  return { ...state, registers: state.registers.slice() };
}
export function slot(state: X87State, physical: number, value: bigint): void {
  state.registers[physical] = value;
  const exponent = Number((value >> 64n) & 0x7fffn),
    fraction = value & ((1n << 64n) - 1n);
  const tag =
    exponent === 0 && fraction === 0n
      ? 1
      : exponent === 0 || exponent === 0x7fff || !(fraction & (1n << 63n))
        ? 2
        : 0;
  state.tagWord = (state.tagWord & ~(3 << (physical * 2))) | (tag << (physical * 2));
}
export function stack(
  values: Record<number, bigint> = {},
  top = 0,
  controlWord = 0x37f,
  status = 0,
): X87State {
  const state: X87State = {
    registers: Array.from({ length: 8 }, (_, i) => 0x12340000000000000000n + BigInt(i)),
    controlWord,
    statusWord: status | (top << 11),
    tagWord: 0xffff,
    instructionPointer: 0x777788889999aaaan,
    dataPointer: 0x1111222233334444n,
    opcode: 0x345,
  };
  for (const [index, value] of Object.entries(values))
    slot(state, (top + Number(index)) & 7, value);
  return state;
}
export function pop(state: X87State, count = 1): void {
  for (let i = 0; i < count; i++) {
    const top = (state.statusWord >> 11) & 7;
    state.tagWord |= 3 << (top * 2);
    state.statusWord = (state.statusWord & ~0x3800) | (((top + 1) & 7) << 11);
  }
}
export function environment(
  state: X87State,
  pc = 0x1000n,
  data?: bigint,
  opcode?: number,
): X87State {
  const result = clone(state);
  result.instructionPointer = pc;
  if (data !== undefined) result.dataPointer = data;
  if (opcode !== undefined) result.opcode = opcode;
  return result;
}
export function x87(cpu: Cpu, expected: X87State, statusMask = 0xffff): void {
  const actual = cpu.readX87State();
  equal(actual.registers.length, 8, 'x87 physical banks');
  for (let i = 0; i < 8; i++) equal(actual.registers[i], expected.registers[i], `x87 R${i}`);
  equal(actual.controlWord, expected.controlWord, 'x87 CW');
  equal(actual.statusWord & statusMask, expected.statusWord & statusMask, 'x87 SW');
  equal(actual.tagWord, expected.tagWord, 'x87 physical tags');
  equal(actual.instructionPointer, expected.instructionPointer, 'x87 FIP');
  equal(actual.dataPointer, expected.dataPointer, 'x87 FDP');
  equal(actual.opcode, expected.opcode, 'x87 FOP');
}
export function seed(cpu: Cpu, state: X87State): void {
  cpu.setX87State(state);
  cpu.setXmmState(banks());
  cpu.setMxcsr(OTHER_MXCSR);
}
export function other(cpu: Cpu): void {
  xmm(cpu, banks());
  equal(cpu.readMxcsr(), OTHER_MXCSR, 'independent MXCSR');
}
export function noFault(result: RunResult): void {
  for (const field of [
    'fault',
    'segmentFault',
    'alignmentFault',
    'simdException',
    'generalProtectionFault',
    'x87Exception',
  ] as const)
    equal(result[field], undefined, `no ${field}`);
}
export function pending(result: RunResult, state: X87State, pc: bigint): void {
  const actual = result.x87Exception;
  equal(actual !== undefined, true, 'pending x87 record');
  const expected = {
    instructionPc: pc,
    vector: 16,
    pending: state.statusWord & ~state.controlWord & 0x3f,
    controlWord: state.controlWord,
    statusWord: state.statusWord,
    instructionPointer: state.instructionPointer,
    dataPointer: state.dataPointer,
    opcode: state.opcode,
  };
  for (const key of Object.keys(expected) as (keyof typeof expected)[])
    equal(actual?.[key], expected[key], `x87 fault ${key}`);
  for (const field of [
    'fault',
    'segmentFault',
    'alignmentFault',
    'simdException',
    'generalProtectionFault',
  ] as const)
    equal(result[field], undefined, `exclusive ${field}`);
}
