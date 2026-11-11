import {
  createCpu,
  type Cpu,
  type ExecutionContext,
  type ExecutionContextSnapshot,
  type Limits,
} from '../../../host/index.js';
import { longSnapshot } from '../../support/context.js';
import { LIMITS, hex } from '../../support/fixture.js';
export {
  check,
  equal,
  hex,
  initial,
  changed,
  throws,
  type Scenario,
} from '../../support/fixture.js';
export { same, preserveNumeric, loadedCode, loadedData } from '../far-control/fixture.js';
export { longSnapshot, protectedSnapshot } from '../../support/context.js';
export { gate, tssDescriptor, encoded, image } from '../software-events/fixture.js';
export type { Cpu, ExecutionContextSnapshot, State, RunResult } from '../../../host/index.js';
export type Factory = typeof createCpu;

export async function linear(
  compiler: WebAssembly.Module,
  make: Factory,
  code: string,
  context: ExecutionContext,
  run: (cpu: Cpu) => Promise<void>,
  setup: { base?: bigint; bytes?: Uint8Array; limits?: Partial<Limits> } = {},
): Promise<void> {
  const cpu = await make({
    compiler,
    context,
    code: { base: 0x1000n, bytes: hex(code) },
    ram: { base: setup.base ?? 0x4000n, bytes: setup.bytes ?? new Uint8Array(0x3000).fill(0xa5) },
    limits: { ...LIMITS, ...setup.limits },
  });
  try {
    await run(cpu);
  } finally {
    cpu.dispose();
  }
}

export function little(value: bigint, width = 8): Uint8Array {
  return Uint8Array.from({ length: width }, (_, i) => Number((value >> BigInt(i * 8)) & 255n));
}

export function codePair(source: string, target: string): string {
  const bytes = new Uint8Array(0x1000 + target.length / 2 + 1).fill(0x82);
  bytes.set(hex(source));
  bytes.set(hex(target), 0x1000);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function importedProfiles(): ExecutionContextSnapshot[] {
  const result: ExecutionContextSnapshot[] = [];
  for (const mode of ['real', 'protected', 'compatibility'] as const)
    for (const code32 of [false, true])
      for (const stack32 of [false, true]) {
        const value = longSnapshot();
        value.mode = mode;
        value.segments.cs.long = false;
        value.segments.cs.default32 = code32;
        value.segments.ss.default32 = stack32;
        result.push(value);
      }
  const vm = longSnapshot();
  vm.mode = 'virtual8086';
  vm.cpl = 3;
  for (const segment of Object.values(vm.segments)) {
    segment.base = 0n;
    segment.selector = 0;
    segment.limit = 0xffff;
    segment.default32 = false;
    segment.type = 'read-write';
    segment.dpl = 3;
    segment.long = false;
    segment.granularity = false;
  }
  result.push(vm, longSnapshot());
  return result;
}

export async function noCompilation(run: () => Promise<void>): Promise<void> {
  const compile = WebAssembly.compile;
  const Instance = WebAssembly.Instance;
  let compilations = 0;
  let instantiations = 0;
  WebAssembly.compile = async (...args) => {
    compilations++;
    return compile(...args);
  };
  WebAssembly.Instance = class extends Instance {
    constructor(module: WebAssembly.Module, imports?: WebAssembly.Imports) {
      super(module, imports);
      instantiations++;
    }
  };
  try {
    await run();
  } finally {
    WebAssembly.compile = compile;
    WebAssembly.Instance = Instance;
  }
  if (compilations !== 0 || instantiations !== 0)
    throw new Error(`warm execution compiled${compilations}/instantiated${instantiations} modules`);
}
