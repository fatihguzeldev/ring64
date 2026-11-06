import type { InitialMemory, MemoryBackingInput, MemoryMapping } from './memory.js';

export interface State {
  registers: bigint[];
  flags: bigint;
  rip: bigint;
}

export interface Fault {
  instructionPc: bigint;
  address: bigint;
  width: number;
  access: 'read' | 'write' | 'execute';
  cause: 'address-range' | 'noncanonical' | 'unmapped' | 'permission';
  failingAddress: bigint;
}

export interface Span {
  base: bigint;
  bytes: Uint8Array;
}

export interface CompileLimits {
  maxInstructions: number;
  maxSourceBytes: number;
  maxArtifactBytes: number;
}

export interface UnitMetadata {
  // Array positions are the generated entry indices supplied by Rust.
  entries: bigint[];
  instructionCount: number;
  blockCount: number;
  sourceBytes: number;
  owner: bigint;
  dependencies: { start: bigint; length: number }[];
  byteLength: number;
}

interface Layout {
  size: number;
  registers: number;
  flags: number;
  rip: number;
  remaining: number;
  reasons: string[];
}

type CoreExports = WebAssembly.Exports & {
  memory: WebAssembly.Memory;
  core_input(length: number): number;
  core_init(codeBase: bigint, codeLen: number, ramBase: bigint, ramLen: number): number;
  core_init_mapped(entry: bigint, metadataLength: number): number;
  core_add_backing(metadataLength: number): number;
  core_remove_backing(): number;
  core_set_mappings(): number;
  core_validity(owner: bigint): number;
  core_activate(owner: bigint): number;
  core_release(owner: bigint): void;
  core_state_ptr(): number;
  core_import_state(): number;
  core_clear_fault(): void;
  core_probe(pc: bigint): number;
  core_compile(
    pc: bigint,
    maxInstructions: number,
    maxSourceBytes: number,
    maxArtifactBytes: number,
  ): number;
  core_load(address: bigint, width: number): bigint;
  core_load_for_write(address: bigint, width: number): bigint;
  core_store(address: bigint, width: number, value: bigint): number;
  core_access_failed(): number;
  core_multiply_high(left: bigint, right: bigint, signed: number): bigint;
  core_divide(high: bigint, low: bigint, divisor: bigint, signed: number): bigint;
  core_divide_failed(): number;
  core_fault_info(reason: number): void;
  core_read_memory(address: bigint, length: number): number;
  core_write_memory(address: bigint): number;
  core_output_ptr(): number;
  core_output_len(): number;
  core_info_ptr(): number;
  core_info_len(): number;
  core_dispose(): void;
};

export type GeneratedRun = (
  state: number,
  budget: bigint,
  stop: bigint,
  hasStop: number,
  entryIndex: number,
) => number;

const U64_MAX = (1n << 64n) - 1n;

export function unsigned64(value: unknown, name: string): asserts value is bigint {
  if (typeof value !== 'bigint' || value < 0n || value > U64_MAX) {
    throw new TypeError(`${name} must be an unsigned 64-bit bigint`);
  }
}

export function byteLength(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new TypeError(`${name} must be an unsigned wasm32 byte length`);
  }
}

export function captureState(state: State): State {
  const source = state.registers;
  if (!Array.isArray(source) || source.length !== 16)
    throw new TypeError('state requires sixteen registers');
  const registers: bigint[] = [];
  for (let index = 0; index < 16; index++) {
    const register = source[index];
    unsigned64(register, 'register');
    registers.push(register);
  }
  const flags = state.flags;
  unsigned64(flags, 'flags');
  const rip = state.rip;
  unsigned64(rip, 'rip');
  return { registers, flags, rip };
}

export function copyMemoryInput(bytes: Uint8Array): Uint8Array {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('memory input must be Uint8Array');
  const copy = new Uint8Array(bytes);
  byteLength(copy.length, 'length');
  return copy;
}

function backingKey(name: string): string {
  // JSON's Unicode strings cannot carry lone UTF-16 surrogates into Rust.
  let key = '';
  for (let index = 0; index < name.length; index++)
    key += name.charCodeAt(index).toString(16).padStart(4, '0');
  return key;
}

function mappingInput(mappings: readonly MemoryMapping[]): MemoryMapping[] {
  return mappings.map((mapping) => ({ ...mapping, backing: backingKey(mapping.backing) }));
}

function writeInput(
  exports: CoreExports,
  metadata: unknown,
  backings: readonly Uint8Array[] = [],
): number {
  const header = new TextEncoder().encode(
    JSON.stringify(metadata, (_key, value: unknown) =>
      typeof value === 'bigint' ? `0x${value.toString(16)}` : value,
    ),
  );
  let length = header.length;
  for (const bytes of backings) length += bytes.length;
  byteLength(length, 'mapped input length');
  const pointer = exports.core_input(length);
  const input = new Uint8Array(exports.memory.buffer, pointer, length);
  input.set(header);
  let offset = header.length;
  for (const bytes of backings) {
    input.set(bytes, offset);
    offset += bytes.length;
  }
  return header.length;
}

export class Core {
  readonly #exports: CoreExports;
  readonly #layout: Layout;
  readonly #statePointer: number;

  private constructor(exports: CoreExports) {
    this.#exports = exports;
    this.#layout = this.info<Layout>();
    this.#statePointer = exports.core_state_ptr();
    for (const name of ['size', 'registers', 'flags', 'rip', 'remaining'] as const) {
      if (!Number.isInteger(this.#layout[name]) || this.#layout[name] < 0) {
        throw new Error('core returned an invalid transport layout');
      }
    }
    if (
      !Array.isArray(this.#layout.reasons) ||
      this.#layout.reasons.some((reason) => typeof reason !== 'string')
    ) {
      throw new Error('core returned invalid exit names');
    }
    this.stateView();
  }

  static async create(
    compiler: Uint8Array | WebAssembly.Module,
    memory: InitialMemory,
  ): Promise<Core> {
    const module =
      compiler instanceof WebAssembly.Module
        ? compiler
        : await WebAssembly.compile(new Uint8Array(compiler));
    const instance = await WebAssembly.instantiate(module, {});
    const exports = instance.exports as CoreExports;
    if (!(exports.memory instanceof WebAssembly.Memory)) throw new Error('core must export memory');
    for (const name of [
      'core_input',
      'core_init_mapped',
      'core_add_backing',
      'core_remove_backing',
      'core_set_mappings',
      'core_validity',
      'core_activate',
      'core_release',
      'core_state_ptr',
      'core_import_state',
      'core_clear_fault',
      'core_probe',
      'core_compile',
      'core_load',
      'core_load_for_write',
      'core_store',
      'core_access_failed',
      'core_fault_info',
      'core_read_memory',
      'core_write_memory',
      'core_output_ptr',
      'core_output_len',
      'core_info_ptr',
      'core_info_len',
      'core_dispose',
    ]) {
      if (typeof exports[name] !== 'function') throw new Error(`core must export ${name}`);
    }
    const metadataLength = writeInput(
      exports,
      {
        memoryLimits: memory.memoryLimits,
        backings: memory.backings.map(({ id, bytes }) => ({
          id: backingKey(id),
          length: bytes.length,
        })),
        mappings: mappingInput(memory.mappings),
      },
      memory.backings.map(({ bytes }) => bytes),
    );
    const status = exports.core_init_mapped(memory.entry, metadataLength);
    if (status !== 0) {
      const text = new TextDecoder().decode(
        new Uint8Array(exports.memory.buffer, exports.core_info_ptr(), exports.core_info_len()),
      );
      exports.core_dispose();
      const error = (JSON.parse(text) as { error: string }).error;
      if (status === 1) throw new TypeError(error);
      if (status === 2) throw new RangeError(error);
      throw new Error('mapped initialization returned an invalid status');
    }
    return new Core(exports);
  }

  private info<T>(): T {
    const bytes = new Uint8Array(
      this.#exports.memory.buffer,
      this.#exports.core_info_ptr(),
      this.#exports.core_info_len(),
    );
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  }

  private output(): Uint8Array {
    return new Uint8Array(
      this.#exports.memory.buffer,
      this.#exports.core_output_ptr(),
      this.#exports.core_output_len(),
    ).slice();
  }

  private stateView(): DataView {
    return new DataView(this.#exports.memory.buffer, this.#statePointer, this.#layout.size);
  }

  snapshot(): State {
    const view = this.stateView();
    return {
      registers: Array.from({ length: 16 }, (_, i) =>
        view.getBigUint64(this.#layout.registers + i * 8, true),
      ),
      flags: view.getBigUint64(this.#layout.flags, true),
      rip: view.getBigUint64(this.#layout.rip, true),
    };
  }

  setState(state: State): void {
    const input = captureState(state);
    const pointer = this.#exports.core_input(this.#layout.size);
    const view = new DataView(this.#exports.memory.buffer, pointer, this.#layout.size);
    for (let index = 0; index < 16; index++) {
      view.setBigUint64(this.#layout.registers + index * 8, input.registers[index]!, true);
    }
    view.setBigUint64(this.#layout.flags, input.flags, true);
    view.setBigUint64(this.#layout.rip, input.rip, true);
    if (this.#exports.core_import_state() !== 0)
      throw new TypeError(this.info<{ error: string }>().error);
  }

  current(): { rip: bigint; remaining: bigint } {
    const view = this.stateView();
    return {
      rip: view.getBigUint64(this.#layout.rip, true),
      remaining: view.getBigUint64(this.#layout.remaining, true),
    };
  }

  clearFault(): void {
    this.#exports.core_clear_fault();
  }
  probe(pc: bigint): string {
    return this.reason(this.#exports.core_probe(pc));
  }

  reason(value: number): string {
    const reason = this.#layout.reasons[value];
    if (!Number.isInteger(value) || reason === undefined)
      throw new Error('generated execution returned an invalid reason');
    return reason;
  }

  compile(
    pc: bigint,
    limits: CompileLimits,
  ): { bytes: Uint8Array; metadata: UnitMetadata } | undefined {
    const status = this.#exports.core_compile(
      pc,
      limits.maxInstructions,
      limits.maxSourceBytes,
      limits.maxArtifactBytes,
    );
    if (this.reason(status) === 'resource-limit') return undefined;
    if (status !== 0) throw new Error('translator returned an unexpected result');
    const metadata = this.info<
      Omit<UnitMetadata, 'entries' | 'byteLength' | 'owner' | 'dependencies'> & {
        entries: string[];
        owner: string;
        dependencies: { start: string; length: number }[];
      }
    >();
    const bytes = this.output();
    return {
      bytes,
      metadata: {
        ...metadata,
        entries: metadata.entries.map((pc) => BigInt(pc)),
        owner: BigInt(metadata.owner),
        dependencies: metadata.dependencies.map(({ start, length }) => ({
          start: BigInt(start),
          length,
        })),
        byteLength: bytes.length,
      },
    };
  }

  instantiate(module: WebAssembly.Module): GeneratedRun {
    const instance = new WebAssembly.Instance(module, {
      env: {
        memory: this.#exports.memory,
        load: this.#exports.core_load,
        load_for_write: this.#exports.core_load_for_write,
        store: this.#exports.core_store,
        access_failed: this.#exports.core_access_failed,
        multiply_high: this.#exports.core_multiply_high,
        divide: this.#exports.core_divide,
        divide_failed: this.#exports.core_divide_failed,
      },
    });
    if (typeof instance.exports.run !== 'function')
      throw new Error('generated module must export run');
    return instance.exports.run as GeneratedRun;
  }

  execute(run: GeneratedRun, entryIndex: number, budget: bigint, stop: bigint | undefined): string {
    return this.reason(
      run(this.#statePointer, budget, stop ?? 0n, stop === undefined ? 0 : 1, entryIndex),
    );
  }

  fault(reason: string): Fault | undefined {
    this.#exports.core_fault_info(this.#layout.reasons.indexOf(reason));
    const raw = this.info<null | {
      address: string;
      width: number;
      access: Fault['access'];
      cause: Fault['cause'];
      failingAddress: string;
    }>();
    return raw === null
      ? undefined
      : {
          ...raw,
          instructionPc: this.current().rip,
          address: BigInt(raw.address),
          failingAddress: BigInt(raw.failingAddress),
        };
  }

  readMemory(address: bigint, length: number): Uint8Array {
    unsigned64(address, 'address');
    byteLength(length, 'length');
    if (this.#exports.core_read_memory(address, length) !== 0)
      throw new RangeError(JSON.stringify(this.info()));
    return this.output();
  }

  writeOwnedMemory(address: bigint, input: Uint8Array): void {
    // The host copies caller bytes before its final lifecycle check.
    unsigned64(address, 'address');
    const pointer = this.#exports.core_input(input.length);
    new Uint8Array(this.#exports.memory.buffer, pointer, input.length).set(input);
    if (this.#exports.core_write_memory(address) !== 0)
      throw new RangeError(JSON.stringify(this.info()));
  }

  private memoryResult(status: number): void {
    if (status === 0) return;
    const { error } = this.info<{ error: string }>();
    if (status === 1) throw new TypeError(error);
    if (status === 2) throw new RangeError(error);
    throw new Error('memory mutation returned an invalid status');
  }

  addBacking(input: MemoryBackingInput): void {
    const length = writeInput(this.#exports, { id: backingKey(input.id) }, [input.bytes]);
    this.memoryResult(this.#exports.core_add_backing(length));
  }

  removeBacking(id: string): void {
    writeInput(this.#exports, backingKey(id));
    this.memoryResult(this.#exports.core_remove_backing());
  }

  setMappings(mappings: MemoryMapping[]): void {
    writeInput(this.#exports, mappingInput(mappings));
    this.memoryResult(this.#exports.core_set_mappings());
  }

  valid(owner: bigint): boolean {
    return this.#exports.core_validity(owner) === 1;
  }

  activate(owner: bigint): boolean {
    return this.#exports.core_activate(owner) === 1;
  }

  release(owner: bigint): void {
    this.#exports.core_release(owner);
  }

  dispose(): void {
    this.#exports.core_dispose();
  }
}
