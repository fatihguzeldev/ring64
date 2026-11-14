import type { Cpu, ExecutionContext, State } from '../../../host/index.js';
import { initial, exit, equal, hex, type Scenario } from '../../support/fixture.js';
import { LONG, context, using, type Data } from '../modes/fixture.js';

export { equal, hex, type Scenario };
export { same, put, preserved } from '../supervisor-access/fixture.js';
export const PC = 0x1000n;
export const RAM_BASE = 0x4000n;
export const RAM_SIZE = 0x4000;
export interface CompoundProfile {
  name: string;
  execution: ExecutionContext;
  codeBits: 16 | 32 | 64;
  stackBits: 16 | 32 | 64;
}
export const compoundProfiles: CompoundProfile[] = [
  ...(['real', 'protected', 'compatibility'] as const).flatMap((mode) =>
    ([16, 32] as const).flatMap((codeBits) =>
      ([16, 32] as const).map((stackBits) => ({
        name: `${mode}/${codeBits}/${stackBits}`,
        execution: context(mode, codeBits === 32, stackBits === 32),
        codeBits,
        stackBits,
      })),
    ),
  ),
  {
    name: 'virtual8086/16/16',
    execution: context('virtual8086', false, false),
    codeBits: 16,
    stackBits: 16,
  },
  { name: 'long64/64/64', execution: LONG, codeBits: 64, stackBits: 64 },
];
export const mask = (bits: number): bigint => (1n << BigInt(bits)) - 1n;
export const wrap = (value: bigint, bits: number): bigint => value & mask(bits);
// Legacy raw high banks are preserved; Long64 word writes preserve upper48.
export const merge = (old: bigint, value: bigint, bits: number): bigint =>
  (old & ~mask(bits)) | (value & mask(bits));
export const bytes = (value: bigint, width: number): string =>
  Array.from({ length: width }, (_, index) =>
    Number((value >> BigInt(index * 8)) & 255n)
      .toString(16)
      .padStart(2, '0'),
  ).join('');
export const byteString = (value: Uint8Array): string =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
export function input(
  profile: CompoundProfile,
  registers: Record<number, bigint> = {},
  flags = 0xcd7n,
): State {
  return initial(
    PC,
    {
      4: profile.codeBits === 64 ? 0x5000n : 0x1122334400005000n,
      5: profile.codeBits === 64 ? 0x6000n : 0x5566778800006000n,
      ...registers,
    },
    flags,
  );
}
export function expected(
  before: State,
  rip: bigint,
  registers: Record<number, bigint> = {},
): State {
  const result = structuredClone(before);
  result.rip = rip;
  for (const [bank, value] of Object.entries(registers)) result.registers[Number(bank)] = value;
  return result;
}
export function operandPrefix(profile: CompoundProfile, width: number): string {
  return width * 8 === profile.codeBits ? '' : '66';
}
export function enterBytes(
  profile: CompoundProfile,
  width: number,
  allocation: number,
  nesting: number,
): string {
  return (
    operandPrefix(profile, width) + 'c8' + bytes(BigInt(allocation), 2) + bytes(BigInt(nesting), 1)
  );
}
export async function linear(
  compiler: WebAssembly.Module,
  code: string,
  profile: CompoundProfile,
  run: (cpu: Cpu) => Promise<void>,
  setup: {
    ram?: Uint8Array;
    data?: Data[];
    codeWrite?: boolean;
    entry?: bigint;
    codeBase?: bigint;
  } = {},
): Promise<void> {
  return using(compiler, code, profile.execution, run, {
    data: setup.data ?? [
      { base: RAM_BASE, bytes: byteString(setup.ram ?? new Uint8Array(RAM_SIZE).fill(0xa5)) },
    ],
    ...(setup.codeWrite === undefined ? {} : { codeWrite: setup.codeWrite }),
    ...(setup.entry === undefined ? {} : { entry: setup.entry }),
    ...(setup.codeBase === undefined ? {} : { codeBase: setup.codeBase }),
  });
}
export function memory(cpu: Cpu, base: bigint, wanted: Uint8Array, label: string): void {
  const actual = cpu.readMemory(base, wanted.length);
  equal(actual.length, wanted.length, `${label} length`);
  for (let index = 0; index < wanted.length; index++)
    if (actual[index] !== wanted[index])
      throw Error(
        `${label} byte ${(base + BigInt(index)).toString(16)}: ${actual[index]} != ${wanted[index]}`,
      );
}
export function completed(
  cpu: Cpu,
  result: Awaited<ReturnType<Cpu['run']>>,
  before: State,
  rip: bigint,
  registers: Record<number, bigint>,
  retired = 1n,
): void {
  exit(result, 'budget', retired, retired, expected(before, rip, registers));
  equal(result.repeatIterations, 0n, 'compound never consumes repeated elements');
  equal(result.remainingRepeatBudget, 0n, 'compound retains repetition budget');
  equal(cpu.readTimeState().tsc, 100n + retired, 'compound counts one virtual instruction');
}
