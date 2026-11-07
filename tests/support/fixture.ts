import { createCpu, type Cpu, type Limits, type RunResult, type State } from '../../host/index.js';

type Execution = RunResult;

export interface Scenario {
  name: string;
  run(): Promise<void>;
}

export const CODE = 0x1000n;
export const DATA = 0x100004000n;
export const LIMITS: Limits = {
  maxInstructions: 128,
  maxSourceBytes: 2048,
  maxArtifactBytes: 262144,
  maxCachedArtifacts: 32,
  maxCachedBytes: 4 * 1024 * 1024,
  maxTranslationsPerRun: 32,
};
export const FRAME = '10111213141516178877665544332211f0f1f2f3f4f5f6f7';

export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function equal(actual: unknown, expected: unknown, label: string): void {
  check(actual === expected, `${label}: expected ${String(expected)}, received ${String(actual)}`);
}

export function hex(source: string): Uint8Array {
  check(source.length % 2 === 0 && /^[0-9a-f]*$/.test(source), 'malformed literal bytes');
  return Uint8Array.from(source.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function byteString(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function memory(cpu: Cpu, base: bigint, expected: string): void {
  equal(
    byteString(cpu.readMemory(base, expected.length / 2)),
    expected,
    `memory at ${base.toString(16)}`,
  );
}

export function initial(rip = CODE, registers: Record<number, bigint> = {}, flags = 2n): State {
  const banks = Array.from({ length: 16 }, (_, index) => 0x1122334400000000n + BigInt(index));
  banks[3] = DATA;
  for (const [index, value] of Object.entries(registers)) banks[Number(index)] = value;
  return { registers: banks, flags, rip };
}

export function changed(
  input: State,
  rip: bigint,
  registers: Record<number, bigint> = {},
  flags = input.flags,
): State {
  const banks = [...input.registers];
  for (const [index, value] of Object.entries(registers)) banks[Number(index)] = value;
  return { registers: banks, flags, rip };
}

export function state(actual: State, expected: State): void {
  equal(actual.registers.length, 16, 'register count');
  for (let index = 0; index < 16; index++)
    equal(actual.registers[index], expected.registers[index], `register ${index}`);
  equal(actual.flags, expected.flags, 'flags');
  equal(actual.rip, expected.rip, 'rip');
}

export function exit(
  actual: Execution,
  reason: Execution['reason'],
  budget: bigint,
  retired: bigint,
  expected: State,
): void {
  equal(actual.reason, reason, 'exit reason');
  equal(actual.retired, retired, 'retired');
  equal(actual.remaining, budget - retired, 'remaining');
  state(actual.state, expected);
}

type FaultExpectation = Omit<NonNullable<Execution['fault']>, 'segment'> & {
  segment?: NonNullable<Execution['fault']>['segment'];
};

export function fault(actual: Execution, expected: FaultExpectation): void {
  check(actual.fault, 'missing access failure metadata');
  equal(actual.segmentFault, undefined, 'exclusive access diagnostic');
  check(
    ['cs', 'ss', 'ds', 'es', 'fs', 'gs'].includes(actual.fault.segment),
    'missing selected segment',
  );
  if (expected.segment !== undefined)
    equal(actual.fault.segment, expected.segment, 'fault segment');
  for (const key of [
    'instructionPc',
    'address',
    'width',
    'access',
    'cause',
    'failingAddress',
  ] as const) {
    equal(actual.fault[key], expected[key], `fault ${key}`);
  }
}

export function throws(action: () => unknown, label: string): void {
  let failed = false;
  try {
    action();
  } catch {
    failed = true;
  }
  check(failed, `${label} must reject`);
}

export async function rejects(action: () => Promise<unknown>, label: string): Promise<void> {
  let failed = false;
  try {
    await action();
  } catch {
    failed = true;
  }
  check(failed, `${label} must reject`);
}

type Setup = { codeBase?: bigint; ramBase?: bigint; ram?: string; limits?: Partial<Limits> };

export function createFixture(core: WebAssembly.Module) {
  const using = async (
    code: string,
    run: (cpu: Cpu) => Promise<void>,
    setup: Setup = {},
  ): Promise<void> => {
    const cpu = await createCpu({
      compiler: core,
      code: { base: setup.codeBase ?? CODE, bytes: hex(code) },
      ram: { base: setup.ramBase ?? DATA - 8n, bytes: hex(setup.ram ?? FRAME) },
      limits: { ...LIMITS, ...setup.limits },
    });
    try {
      await run(cpu);
    } finally {
      cpu.dispose();
    }
  };
  return using;
}
