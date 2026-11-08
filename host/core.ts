import {
  contextFromJson,
  type ContextInfo,
  type ExecutionContext,
  type SegmentFault,
  type SegmentName,
} from './context.js';
import type { InitialMemory, MemoryBackingInput, MemoryMapping } from './memory.js';
import {
  captureX87State,
  readX87,
  writeX87,
  validateX87Layout,
  type X87State,
  type X87Exception,
  type X87Layout,
} from './x87.js';

export interface State {
  registers: bigint[];
  flags: bigint;
  rip: bigint;
}

export interface Fault {
  segment: SegmentName;
  instructionPc: bigint;
  address: bigint;
  width: number;
  access: 'read' | 'write' | 'execute';
  cause: 'address-range' | 'noncanonical' | 'unmapped' | 'permission';
  failingAddress: bigint;
}

export interface AlignmentFault {
  segment: SegmentName;
  instructionPc: bigint;
  offset: bigint;
  address: bigint;
  width: number;
  access: 'read' | 'write';
  alignment: number;
}

export interface SimdException {
  instructionPc: bigint;
  vector: 19;
  stage: 'pre-computation' | 'post-computation';
  raised: number;
  unmasked: number;
  mxcsrBefore: number;
  mxcsrAfter: number;
}

export interface GeneralProtectionFault {
  instructionPc: bigint;
  vector: 13;
  errorCode: 0;
  cause: 'mxcsr-reserved-bits';
  loadedValue: number;
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
  contextVersion: bigint;
  dependencies: { start: bigint; length: number }[];
  byteLength: number;
}

interface Layout {
  size: number;
  scalarSize: number;
  xmm: number;
  xmmBytes: number;
  vectorScratch: number;
  mxcsr: number;
  mxcsrBytes: number;
  x87: X87Layout;
  registers: number;
  flags: number;
  rip: number;
  remaining: number;
  repeatRemaining: number;
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
  core_context_info(): void;
  core_context_version(): bigint;
  core_set_context(): number;
  core_segmented_load(offset: bigint, width: number, segment: number): bigint;
  core_segmented_load_for_write(offset: bigint, width: number, segment: number): bigint;
  core_segmented_store(offset: bigint, width: number, value: bigint, segment: number): number;
  core_segmented_access_failed(): number;
  core_access_reason(): number;
  core_target_check(target: bigint): number;
  core_state_ptr(): number;
  core_import_state(): number;
  core_import_xmm(): number;
  core_import_mxcsr(): number;
  core_import_x87(): number;
  core_mmx(operation: number, operand: bigint, segment: number): number;
  core_numeric_image(operation: number, offset: bigint, segment: number): number;
  core_masked_store(
    offset: bigint,
    width: number,
    data: number,
    mask: number,
    segment: number,
  ): number;
  core_clflush(offset: bigint, segment: number): number;
  core_x87(
    operation: number,
    offset: bigint,
    segment: number,
    pc: bigint,
    flags: bigint,
    rax: bigint,
  ): number;
  core_float(
    operation: number,
    leftLo: bigint,
    leftHi: bigint,
    rightLo: bigint,
    rightHi: bigint,
  ): number;
  core_load_mxcsr(offset: bigint, segment: number): number;
  core_store_mxcsr(offset: bigint, segment: number): number;
  core_vector_load(offset: bigint, width: number, segment: number, alignment: number): number;
  core_vector_store(
    offset: bigint,
    width: number,
    segment: number,
    alignment: number,
    value: number,
  ): number;
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

export function captureMxcsr(value: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffff)
    throw new TypeError('MXCSR must be an unsigned 16-bit integer number');
  return value === 0 ? 0 : value;
}

export function captureXmmState(input: bigint[]): bigint[] {
  if (!Array.isArray(input) || input.length !== 16)
    throw new TypeError('XMM state requires sixteen registers');
  const bank: bigint[] = [];
  for (let index = 0; index < 16; index++) {
    const value = input[index];
    if (typeof value !== 'bigint' || value < 0n || value >= 1n << 128n)
      throw new TypeError('XMM register must be an unsigned 128-bit bigint');
    bank.push(value);
  }
  return bank;
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
  if (length > 0xffffffff) throw new RangeError('mapped input exceeds wasm32 capacity');
  // Wasm i32 results carry unsigned wasm32 pointers as signed JS numbers.
  const pointer = exports.core_input(length) >>> 0;
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
    this.#statePointer = exports.core_state_ptr() >>> 0;
    for (const name of [
      'size',
      'scalarSize',
      'xmm',
      'xmmBytes',
      'vectorScratch',
      'mxcsr',
      'mxcsrBytes',
      'registers',
      'flags',
      'rip',
      'remaining',
      'repeatRemaining',
    ] as const) {
      if (
        !Number.isSafeInteger(this.#layout[name]) ||
        this.#layout[name] < 0 ||
        this.#layout[name] > 0xffffffff
      ) {
        throw new Error('core returned an invalid transport layout');
      }
    }
    if (
      !Array.isArray(this.#layout.reasons) ||
      this.#layout.reasons.some((reason) => typeof reason !== 'string')
    ) {
      throw new Error('core returned invalid exit names');
    }
    const layout = this.#layout;
    if (
      layout.scalarSize !== 176 ||
      layout.registers !== 0 ||
      layout.flags !== 128 ||
      layout.rip !== 136 ||
      layout.remaining !== 144 ||
      layout.repeatRemaining !== 168 ||
      layout.xmm < layout.scalarSize ||
      layout.xmmBytes !== 256 ||
      layout.xmm + layout.xmmBytes > layout.size ||
      layout.vectorScratch < layout.xmm + layout.xmmBytes ||
      layout.vectorScratch + 16 > layout.size ||
      layout.mxcsr < 448 ||
      layout.mxcsr < layout.vectorScratch + 16 ||
      layout.mxcsrBytes !== 4 ||
      layout.mxcsr + layout.mxcsrBytes > layout.size
    )
      throw new Error('core returned an incompatible transport layout');
    validateX87Layout(layout.x87, layout.size, layout.mxcsr + layout.mxcsrBytes);
    this.stateView();
  }

  static async create(
    compiler: Uint8Array | WebAssembly.Module,
    memory: InitialMemory,
    context?: ExecutionContext,
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
      'core_context_info',
      'core_context_version',
      'core_set_context',
      'core_segmented_load',
      'core_segmented_load_for_write',
      'core_segmented_store',
      'core_segmented_access_failed',
      'core_access_reason',
      'core_target_check',
      'core_state_ptr',
      'core_import_state',
      'core_import_xmm',
      'core_import_mxcsr',
      'core_import_x87',
      'core_x87',
      'core_mmx',
      'core_numeric_image',
      'core_masked_store',
      'core_clflush',
      'core_float',
      'core_load_mxcsr',
      'core_store_mxcsr',
      'core_vector_load',
      'core_vector_store',
      'core_clear_fault',
      'core_probe',
      'core_compile',
      'core_load',
      'core_load_for_write',
      'core_store',
      'core_access_failed',
      'core_multiply_high',
      'core_divide',
      'core_divide_failed',
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
        new Uint8Array(
          exports.memory.buffer,
          exports.core_info_ptr() >>> 0,
          exports.core_info_len() >>> 0,
        ),
      );
      exports.core_dispose();
      const error = (JSON.parse(text) as { error: string }).error;
      if (status === 1) throw new TypeError(error);
      if (status === 2) throw new RangeError(error);
      throw new Error('mapped initialization returned an invalid status');
    }
    try {
      const core = new Core(exports);
      if (context !== undefined) core.setContext(context);
      return core;
    } catch (error) {
      exports.core_dispose();
      throw error;
    }
  }

  private info<T>(): T {
    const bytes = new Uint8Array(
      this.#exports.memory.buffer,
      this.#exports.core_info_ptr() >>> 0,
      this.#exports.core_info_len() >>> 0,
    );
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  }

  private output(): Uint8Array {
    return new Uint8Array(
      this.#exports.memory.buffer,
      this.#exports.core_output_ptr() >>> 0,
      this.#exports.core_output_len() >>> 0,
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
    const pointer = this.#exports.core_input(this.#layout.scalarSize) >>> 0;
    const view = new DataView(this.#exports.memory.buffer, pointer, this.#layout.scalarSize);
    for (let index = 0; index < 16; index++) {
      view.setBigUint64(this.#layout.registers + index * 8, input.registers[index]!, true);
    }
    view.setBigUint64(this.#layout.flags, input.flags, true);
    view.setBigUint64(this.#layout.rip, input.rip, true);
    if (this.#exports.core_import_state() !== 0)
      throw new TypeError(this.info<{ error: string }>().error);
  }

  readXmmState(): bigint[] {
    const view = this.stateView();
    return Array.from({ length: 16 }, (_, index) => {
      const offset = this.#layout.xmm + index * 16;
      return view.getBigUint64(offset, true) | (view.getBigUint64(offset + 8, true) << 64n);
    });
  }

  setXmmState(state: bigint[]): void {
    const bank = captureXmmState(state);
    const pointer = this.#exports.core_input(this.#layout.xmmBytes) >>> 0;
    const view = new DataView(this.#exports.memory.buffer, pointer, this.#layout.xmmBytes);
    for (let index = 0; index < 16; index++) {
      const value = bank[index]!;
      view.setBigUint64(index * 16, value & U64_MAX, true);
      view.setBigUint64(index * 16 + 8, value >> 64n, true);
    }
    if (this.#exports.core_import_xmm() !== 0)
      throw new TypeError(this.info<{ error: string }>().error);
  }

  readMxcsr(): number {
    return this.stateView().getUint32(this.#layout.mxcsr, true);
  }

  readX87State(): X87State {
    const layout = this.#layout.x87;
    return readX87(
      new DataView(this.#exports.memory.buffer, this.#statePointer + layout.offset, layout.bytes),
      layout,
    );
  }

  setX87State(value: X87State): void {
    const input = captureX87State(value),
      layout = this.#layout.x87;
    const pointer = this.#exports.core_input(layout.bytes) >>> 0;
    writeX87(new DataView(this.#exports.memory.buffer, pointer, layout.bytes), layout, input);
    if (this.#exports.core_import_x87() !== 0)
      throw new TypeError(this.info<{ error: string }>().error);
  }

  setMxcsr(value: number): void {
    const input = captureMxcsr(value);
    const pointer = this.#exports.core_input(this.#layout.mxcsrBytes) >>> 0;
    new DataView(this.#exports.memory.buffer, pointer, this.#layout.mxcsrBytes).setUint32(
      0,
      input,
      true,
    );
    if (this.#exports.core_import_mxcsr() !== 0)
      throw new TypeError(this.info<{ error: string }>().error);
  }

  current(): { rip: bigint; remaining: bigint; repeatRemaining: bigint } {
    const view = this.stateView();
    return {
      rip: view.getBigUint64(this.#layout.rip, true),
      remaining: view.getBigUint64(this.#layout.remaining, true),
      repeatRemaining: view.getBigUint64(this.#layout.repeatRemaining, true),
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
      Omit<UnitMetadata, 'entries' | 'byteLength' | 'owner' | 'dependencies' | 'contextVersion'> & {
        entries: string[];
        owner: string;
        contextVersion: string;
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
        contextVersion: BigInt(metadata.contextVersion),
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
        segmented_load: this.#exports.core_segmented_load,
        segmented_load_for_write: this.#exports.core_segmented_load_for_write,
        segmented_store: this.#exports.core_segmented_store,
        segmented_access_failed: this.#exports.core_segmented_access_failed,
        access_reason: this.#exports.core_access_reason,
        vector_load: this.#exports.core_vector_load,
        vector_store: this.#exports.core_vector_store,
        float: this.#exports.core_float,
        load_mxcsr: this.#exports.core_load_mxcsr,
        store_mxcsr: this.#exports.core_store_mxcsr,
        x87: this.#exports.core_x87,
        mmx: this.#exports.core_mmx,
        numeric_image: this.#exports.core_numeric_image,
        masked_store: this.#exports.core_masked_store,
        clflush: this.#exports.core_clflush,
        target_check: this.#exports.core_target_check,
        multiply_high: this.#exports.core_multiply_high,
        divide: this.#exports.core_divide,
        divide_failed: this.#exports.core_divide_failed,
      },
    });
    if (typeof instance.exports.run !== 'function')
      throw new Error('generated module must export run');
    return instance.exports.run as GeneratedRun;
  }

  execute(
    run: GeneratedRun,
    entryIndex: number,
    budget: bigint,
    stop: bigint | undefined,
    repeatBudget: bigint,
  ): string {
    this.stateView().setBigUint64(this.#layout.repeatRemaining, repeatBudget, true);
    return this.reason(
      run(this.#statePointer, budget, stop ?? 0n, stop === undefined ? 0 : 1, entryIndex),
    );
  }

  fault(reason: string): Fault | undefined {
    if (
      reason === 'segment-fault' ||
      reason === 'alignment-fault' ||
      reason === 'simd-exception' ||
      reason === 'x87-exception' ||
      reason === 'general-protection'
    )
      return undefined;
    this.#exports.core_fault_info(this.#layout.reasons.indexOf(reason));
    const raw = this.info<null | {
      address: string;
      width: number;
      access: Fault['access'];
      cause: Fault['cause'];
      failingAddress: string;
      segment: SegmentName;
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

  readContext(): ExecutionContext {
    this.#exports.core_context_info();
    return contextFromJson(this.info<ContextInfo>());
  }

  setContext(context: ExecutionContext): void {
    writeInput(this.#exports, context);
    const status = this.#exports.core_set_context();
    if (status === 1) throw new TypeError(this.info<{ error: string }>().error);
    if (status !== 0) throw new Error('invalid context mutation status');
  }

  contextVersion(): bigint {
    return BigInt.asUintN(64, this.#exports.core_context_version());
  }

  segmentFault(reason: string): SegmentFault | undefined {
    if (reason !== 'segment-fault') return undefined;
    this.#exports.core_fault_info(this.#layout.reasons.indexOf(reason));
    const raw = this.info<
      Omit<SegmentFault, 'instructionPc' | 'offset' | 'failingOffset'> & {
        offset: string;
        failingOffset: string;
      }
    >();
    return {
      ...raw,
      instructionPc: this.current().rip,
      offset: BigInt(raw.offset),
      failingOffset: BigInt(raw.failingOffset),
    };
  }

  alignmentFault(reason: string): AlignmentFault | undefined {
    if (reason !== 'alignment-fault') return undefined;
    this.#exports.core_fault_info(this.#layout.reasons.indexOf(reason));
    const raw = this.info<
      Omit<AlignmentFault, 'instructionPc' | 'offset' | 'address'> & {
        offset: string;
        address: string;
      }
    >();
    return {
      ...raw,
      instructionPc: this.current().rip,
      offset: BigInt(raw.offset),
      address: BigInt(raw.address),
    };
  }

  simdException(reason: string): SimdException | undefined {
    if (reason !== 'simd-exception') return undefined;
    this.#exports.core_fault_info(this.#layout.reasons.indexOf(reason));
    return {
      ...this.info<Omit<SimdException, 'instructionPc'>>(),
      instructionPc: this.current().rip,
    };
  }

  generalProtectionFault(reason: string): GeneralProtectionFault | undefined {
    if (reason !== 'general-protection') return undefined;
    this.#exports.core_fault_info(this.#layout.reasons.indexOf(reason));
    return {
      ...this.info<Omit<GeneralProtectionFault, 'instructionPc'>>(),
      instructionPc: this.current().rip,
    };
  }

  x87Exception(reason: string): X87Exception | undefined {
    if (reason !== 'x87-exception') return undefined;
    this.#exports.core_fault_info(this.#layout.reasons.indexOf(reason));
    const raw = this.info<
      Omit<X87Exception, 'instructionPc' | 'instructionPointer' | 'dataPointer'> & {
        instructionPointer: string;
        dataPointer: string;
      }
    >();
    return {
      ...raw,
      instructionPc: this.current().rip,
      instructionPointer: BigInt(raw.instructionPointer),
      dataPointer: BigInt(raw.dataPointer),
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
    const pointer = this.#exports.core_input(input.length) >>> 0;
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
