import { IoBridge, type IoBinding } from './io.js';
import {
  captureNumericFault,
  readNumericSource,
  writeNumericSource,
  validateNumericSourceLayout,
  type NumericSourceLayout,
  type NumericFault,
} from './numeric-controls.js';
import {
  captureDebugState,
  captureDebugContinuation,
  readDebugSource,
  writeDebugSource,
  readDebugContinuation,
  writeDebugContinuation,
  validateDebugLayout,
  type DebugState,
  type DebugContinuation,
  type DebugLayout,
} from './debug.js';
import {
  contextFromJson,
  type ContextInfo,
  type ExecutionContext,
  type ExecutionContextSnapshot,
  type SegmentFault,
  type SegmentName,
} from './context.js';
import type { InitialMemory, MemoryBackingInput, MemoryMapping } from './memory.js';
import { capturePagingState, pagingStateFromJson, type PagingState } from './paging.js';
import { captureTimeState, validateTimeLayout, type TimeLayout, type TimeState } from './time.js';
import {
  captureFastSystemState,
  fastSystemStateFromJson,
  zeroFastSystemState,
  type FastSystemState,
} from './fast-system.js';
import {
  captureEventState,
  captureInterruptState,
  eventKind,
  readEvent,
  readInterrupts,
  writePagingSource,
  validatePagingSourceLayout,
  validateEventLayout,
  validateInterruptLayout,
  writeEvent,
  writeInterrupts,
  type EventLayout,
  type EventState,
  type InterruptLayout,
  type InterruptState,
  type PagingSourceLayout,
} from './events.js';
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
  debugContinuation?: DebugContinuation;
  registers: bigint[];
  flags: bigint;
  rip: bigint;
  interruptibility?: Interruptibility;
  event?: EventState;
  interrupts?: InterruptState;
}

export interface Interruptibility {
  sti: boolean;
  ss: boolean;
}

export interface StateSnapshot extends State {
  interruptibility: Interruptibility;
  event: EventState;
  interrupts: InterruptState;
}

export interface DebugException {
  vector: 1;
  class: 'trap' | 'fault';
  cause: 'single-step' | 'execution-breakpoint' | 'general-detect' | 'data-breakpoint' | 'combined';
  breakpoints?: number;
  singleStep?: boolean;
  deferredOriginPc?: bigint;
  instructionPc: bigint;
  resumePc: bigint;
  instructionCompleted: boolean;
  resumeFlags: bigint;
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

export interface ProtectionFault {
  instructionPc: bigint;
  vector: 10 | 11 | 12 | 13;
  errorCode: number;
  phase: 'privilege' | 'selector' | 'descriptor' | 'target';
  selector?: number;
}

interface SystemMemoryAccess {
  instructionPc: bigint;
  address: bigint;
  width: number;
  access: 'read' | 'write';
  cause: 'address-range' | 'noncanonical' | 'unmapped' | 'permission';
  failingAddress: bigint;
}
type SystemMemoryReference =
  | {
      table: 'gdt' | 'ldt';
      selector: number;
      phase: 'descriptor-read' | 'descriptor-accessed-write' | 'descriptor-busy-write';
    }
  | { table: 'ivt' | 'idt'; vector: number; phase: 'gate-read' }
  | { table: 'tss'; selector: number; phase: 'tss-read' };
export type SystemMemoryFault = SystemMemoryAccess & SystemMemoryReference;

export interface PageFault {
  instructionPc: bigint;
  vector: 14;
  table?: 'gdt' | 'ldt' | 'idt' | 'tss';
  systemPhase?: string;
  selector?: number;
  referenceVector?: number;
  address: bigint;
  access: 'read' | 'write' | 'execute';
  errorCode: number;
}

export interface PhysicalAccessFault {
  instructionPc: bigint;
  address: bigint;
  access: 'read' | 'write' | 'execute';
  physicalAddress: bigint;
  width: number;
  failingPhysicalAddress: bigint;
  physicalAccess: 'read' | 'write' | 'execute';
  cause: 'unmapped' | 'permission' | 'address-range';
  phase: 'walk-read' | 'accessed-write' | 'dirty-write' | 'final-access';
  segment?: SegmentName;
  table?: 'gdt' | 'ldt' | 'idt' | 'tss';
  systemPhase?: string;
  selector?: number;
  referenceVector?: number;
}

export interface PdpteLoadFault {
  instructionPc: bigint;
  phase: 'pdpte-load';
  address?: never;
  access?: never;
  segment?: never;
  table?: never;
  systemPhase?: never;
  selector?: never;
  referenceVector?: never;
  control: 'cr0' | 'cr3' | 'cr4';
  slot: 0 | 1 | 2 | 3;
  physicalAddress: bigint;
  width: 8;
  failingPhysicalAddress: bigint;
  physicalAccess: 'read';
  cause: 'unmapped' | 'permission' | 'address-range';
}
export type PhysicalMemoryFault = PhysicalAccessFault | PdpteLoadFault;

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
  boundaryObserved?: boolean;
  dependencies: { start: bigint; length: number }[];
  byteLength: number;
}

interface Layout {
  time: TimeLayout;
  pagingSource?: PagingSourceLayout;
  numericSource?: NumericSourceLayout;
  debug: DebugLayout;
  size: number;
  scalarSize: number;
  xmm: number;
  xmmBytes: number;
  vectorScratch: number;
  mxcsr: number;
  mxcsrBytes: number;
  x87: X87Layout;
  event: EventLayout;
  interrupts: InterruptLayout;
  deliveryEnabled: number;
  registers: number;
  flags: number;
  rip: number;
  remaining: number;
  repeatRemaining: number;
  interruptibility: number;
  interruptibilityBytes: number;
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
  core_publish(owner: bigint): number;
  core_activate(owner: bigint): number;
  core_release(owner: bigint): void;
  core_context_info(): void;
  core_context_version(): bigint;
  core_boundary_observed(): number;
  core_set_context(): number;
  core_paging_state(): number;
  core_import_paging(): number;
  core_fast_system_state(): number;
  core_import_fast_system(): number;
  core_fast_system(
    kind: number,
    wide: number,
    next: bigint,
    sp: bigint,
    rcx: bigint,
    rdx: bigint,
    r11: bigint,
    flags: bigint,
  ): number;
  core_paging_control(
    kind: number,
    register: number,
    value: bigint,
    pc: bigint,
    flags: bigint,
    retired: bigint,
  ): number;
  core_processor(kind: number, eax: number, ecx: number, retired: bigint): number;
  core_io(
    descriptor: number,
    port: number,
    offset: bigint,
    value: bigint,
    segment: number,
    flags: bigint,
  ): number;
  core_io_observed: CoreExports['core_io'];
  core_io_configure(present: number): number;
  core_io_effect_active(): number;
  core_segmented_load(offset: bigint, width: number, segment: number): bigint;
  core_segmented_load_for_write(offset: bigint, width: number, segment: number): bigint;
  core_segmented_store(offset: bigint, width: number, value: bigint, segment: number): number;
  core_segmented_access_failed(): number;
  core_access_reason(): number;
  core_target_check(target: bigint): number;
  core_state_ptr(): number;
  core_import_state(): number;
  core_load_observed: CoreExports['core_load'];
  core_load_for_write_observed: CoreExports['core_load_for_write'];
  core_store_observed: CoreExports['core_store'];
  core_segmented_load_observed: CoreExports['core_segmented_load'];
  core_segmented_load_for_write_observed: CoreExports['core_segmented_load_for_write'];
  core_segmented_store_observed: CoreExports['core_segmented_store'];
  core_vector_load_observed: CoreExports['core_vector_load'];
  core_vector_store_observed: CoreExports['core_vector_store'];
  core_load_mxcsr_observed: CoreExports['core_load_mxcsr'];
  core_store_mxcsr_observed: CoreExports['core_store_mxcsr'];
  core_x87_observed: CoreExports['core_x87'];
  core_mmx_observed: CoreExports['core_mmx'];
  core_numeric_image_observed: CoreExports['core_numeric_image'];
  core_masked_store_observed: CoreExports['core_masked_store'];
  core_protection_observed: CoreExports['core_protection'];
  core_far_control_observed: CoreExports['core_far_control'];
  core_compound_stack_observed: CoreExports['core_compound_stack'];
  core_software_event_observed: CoreExports['core_software_event'];
  core_debug_finish(
    pc: bigint,
    resume: bigint,
    completed: number,
    flags: bigint,
    decision: number,
  ): number;
  core_debug_begin(pc: bigint, flags: bigint, shadow: number): number;
  core_debug_register(operation: number, input: bigint, pc: bigint, flags: bigint): number;
  core_import_debug(): number;
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
  core_far_control(
    descriptor: number,
    offset: bigint,
    selector: number,
    inputSp: bigint,
    nextPc: bigint,
    segment: number,
  ): number;
  core_compound_stack(descriptor: number): number;
  core_flags(operation: number, flags: bigint, input: bigint): number;
  core_software_event(operation: number, inputSp: bigint, flags: bigint, nextPc: bigint): number;
  core_debug_step(
    instructionPc: bigint,
    resumePc: bigint,
    instructionCompleted: number,
    flags: bigint,
  ): number;
  core_configure_delivery(enabled: number): number;
  core_stage_exception(reason: number): number;
  core_deliver_exception(): number;
  core_request_interrupt(vector: number): number;
  core_request_nmi(): number;
  core_external_boundary(): number;
  core_shutdown_can_wake(): number;
  core_external_step(pc: bigint, flags: bigint, shadow: number): number;
  core_halt(flags: bigint): number;
  core_protection(descriptor: number, offset: bigint, input: bigint, segment: number): number;
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
  core_clear_fault(): number;
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
  core_reset(): number;
  core_numeric_fault_info?(): void;
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

export function captureState(state: State): StateSnapshot {
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
  const boundary = state.interruptibility;
  let interruptibility: Interruptibility = { sti: false, ss: false };
  if (boundary !== undefined) {
    if (boundary === null || typeof boundary !== 'object' || Array.isArray(boundary))
      throw new TypeError('interruptibility must contain boolean sti and ss');
    const sti = boundary.sti;
    const ss = boundary.ss;
    if (typeof sti !== 'boolean' || typeof ss !== 'boolean')
      throw new TypeError('interruptibility must contain boolean sti and ss');
    interruptibility = { sti, ss };
  }
  const event = 'event' in state ? captureEventState(state.event!) : { kind: 'ready' as const };
  const interrupts =
    'interrupts' in state
      ? captureInterruptState(state.interrupts!)
      : { irq: null, nmiPending: false, nmiBlocked: false };
  const debugContinuation =
    'debugContinuation' in state ? captureDebugContinuation(state.debugContinuation!) : undefined;
  return {
    registers,
    flags,
    rip,
    interruptibility,
    event,
    interrupts,
    ...(debugContinuation ? { debugContinuation } : {}),
  };
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

const PAGED_HELPERS = {
  load: 'core_paged_load',
  load_for_write: 'core_paged_load_for_write',
  store: 'core_paged_store',
  segmented_load: 'core_paged_segmented_load',
  segmented_load_for_write: 'core_paged_segmented_load_for_write',
  segmented_store: 'core_paged_segmented_store',
  vector_load: 'core_paged_vector_load',
  vector_store: 'core_paged_vector_store',
  load_mxcsr: 'core_paged_load_mxcsr',
  store_mxcsr: 'core_paged_store_mxcsr',
  x87: 'core_paged_x87',
  mmx: 'core_paged_mmx',
  numeric_image: 'core_paged_numeric_image',
  masked_store: 'core_paged_masked_store',
  clflush: 'core_paged_clflush',
  protection: 'core_paged_protection',
  far_control: 'core_paged_far_control',
  compound_stack: 'core_paged_compound_stack',
  software_event: 'core_paged_software_event',
  access_failed: 'core_paged_access_failed',
  segmented_access_failed: 'core_paged_segmented_access_failed',
  access_reason: 'core_paged_access_reason',
  debug_begin: 'core_paged_debug_begin',
  debug_finish: 'core_paged_debug_finish',
} as const;

const PAGED_OBSERVED_HELPERS = {
  load: 'core_paged_load_observed',
  load_for_write: 'core_paged_load_for_write_observed',
  store: 'core_paged_store_observed',
  segmented_load: 'core_paged_segmented_load_observed',
  segmented_load_for_write: 'core_paged_segmented_load_for_write_observed',
  segmented_store: 'core_paged_segmented_store_observed',
  vector_load: 'core_paged_vector_load_observed',
  vector_store: 'core_paged_vector_store_observed',
  load_mxcsr: 'core_paged_load_mxcsr_observed',
  store_mxcsr: 'core_paged_store_mxcsr_observed',
  x87: 'core_paged_x87_observed',
  mmx: 'core_paged_mmx_observed',
  numeric_image: 'core_paged_numeric_image_observed',
  masked_store: 'core_paged_masked_store_observed',
  protection: 'core_paged_protection_observed',
  far_control: 'core_paged_far_control_observed',
  compound_stack: 'core_paged_compound_stack_observed',
  software_event: 'core_paged_software_event_observed',
} as const;

export class Core {
  readonly #exports: CoreExports;
  readonly #layout: Layout;
  readonly #statePointer: number;
  #stateDataView?: DataView;

  private constructor(
    exports: CoreExports,
    readonly isPaged = false,
    readonly physicalControls = false,
    private readonly io?: IoBridge,
  ) {
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
      'interruptibility',
      'interruptibilityBytes',
      'deliveryEnabled',
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
      layout.interruptibility !== 164 ||
      layout.interruptibilityBytes !== 4 ||
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
    validateEventLayout(layout.event, layout.size, layout.x87.offset + layout.x87.bytes);
    if (layout.deliveryEnabled < layout.event.offset + layout.event.bytes)
      throw new Error('core returned an overlapping delivery control');
    validateInterruptLayout(layout.interrupts, layout.size, layout.deliveryEnabled + 4);
    validateDebugLayout(
      layout.debug,
      layout.size,
      layout.interrupts.offset + layout.interrupts.bytes,
    );
    if (layout.pagingSource !== undefined)
      validatePagingSourceLayout(
        layout.pagingSource,
        layout.size,
        layout.debug.offset + layout.debug.layout.bytes,
      );
    if (isPaged && layout.pagingSource === undefined)
      throw new Error('paged core must describe its paging source transport');
    if (layout.numericSource !== undefined) {
      validateNumericSourceLayout(
        layout.numericSource,
        layout.size,
        (layout.pagingSource?.offset ?? layout.debug.offset + layout.debug.layout.bytes) +
          (layout.pagingSource?.bytes ?? 0),
      );
      if (typeof exports.core_numeric_fault_info !== 'function')
        throw new Error('core omitted numeric source export');
    }
    validateTimeLayout(
      layout.time,
      layout.size,
      layout.numericSource
        ? layout.numericSource.offset + layout.numericSource.bytes
        : layout.pagingSource
          ? layout.pagingSource.offset + layout.pagingSource.bytes
          : layout.debug.offset + layout.debug.layout.bytes,
    );
    this.stateView();
  }

  static async create(
    compiler: Uint8Array | WebAssembly.Module,
    memory: InitialMemory,
    context?: ExecutionContext,
    ioBinding?: IoBinding,
  ): Promise<Core> {
    const memoryModel = memory.memoryModel ?? 'linear';
    const isPaged = memoryModel !== 'linear';
    const physicalControls = memoryModel === 'physical';
    const paging = isPaged ? capturePagingState(memory.paging!) : undefined;
    const fastSystem = isPaged
      ? captureFastSystemState(memory.fastSystem ?? zeroFastSystemState())
      : undefined;
    const module =
      compiler instanceof WebAssembly.Module
        ? compiler
        : await WebAssembly.compile(new Uint8Array(compiler));
    const io = new IoBridge(ioBinding);
    try {
      const instance = await WebAssembly.instantiate(module, { io: io.imports });
      const exports = instance.exports as CoreExports;
      if (!(exports.memory instanceof WebAssembly.Memory))
        throw new Error('core must export memory');
      for (const name of [
        'core_io',
        'core_io_observed',
        'core_io_configure',
        'core_io_effect_active',
        'core_input',
        'core_init_mapped',
        'core_add_backing',
        'core_remove_backing',
        'core_set_mappings',
        'core_validity',
        'core_activate',
        'core_publish',
        'core_release',
        'core_context_info',
        'core_context_version',
        'core_boundary_observed',
        'core_set_context',
        'core_segmented_load',
        'core_segmented_load_for_write',
        'core_segmented_store',
        'core_segmented_access_failed',
        'core_access_reason',
        'core_target_check',
        'core_state_ptr',
        'core_import_state',
        'core_load_observed',
        'core_load_for_write_observed',
        'core_store_observed',
        'core_segmented_load_observed',
        'core_segmented_load_for_write_observed',
        'core_segmented_store_observed',
        'core_vector_load_observed',
        'core_vector_store_observed',
        'core_load_mxcsr_observed',
        'core_store_mxcsr_observed',
        'core_x87_observed',
        'core_mmx_observed',
        'core_numeric_image_observed',
        'core_masked_store_observed',
        'core_protection_observed',
        'core_far_control_observed',
        'core_compound_stack_observed',
        'core_software_event_observed',
        'core_debug_finish',
        'core_debug_begin',
        'core_debug_register',
        'core_import_debug',
        'core_import_xmm',
        'core_import_mxcsr',
        'core_import_x87',
        'core_x87',
        'core_mmx',
        'core_numeric_image',
        'core_masked_store',
        'core_clflush',
        'core_protection',
        'core_far_control',
        'core_compound_stack',
        'core_software_event',
        'core_flags',
        'core_debug_step',
        'core_configure_delivery',
        'core_stage_exception',
        'core_deliver_exception',
        'core_request_interrupt',
        'core_request_nmi',
        'core_external_boundary',
        'core_shutdown_can_wake',
        'core_external_step',
        'core_halt',
        'core_float',
        'core_load_mxcsr',
        'core_store_mxcsr',
        'core_vector_load',
        'core_vector_store',
        'core_clear_fault',
        'core_processor',
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
      if (physicalControls && typeof exports.core_reset !== 'function')
        throw new Error('core must export core_reset');
      if (isPaged)
        for (const name of [
          'core_paging_state',
          'core_import_paging',
          'core_paging_control',
          'core_fast_system_state',
          'core_import_fast_system',
          'core_fast_system',
          ...Object.values(PAGED_HELPERS),
          ...Object.values(PAGED_OBSERVED_HELPERS),
        ])
          if (typeof exports[name] !== 'function') throw new Error(`core must export ${name}`);
      const metadataLength = writeInput(
        exports,
        {
          ...(isPaged
            ? { memoryModel, paging, fastSystem, ...(physicalControls ? { context } : {}) }
            : {}),
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
        if (exports.core_io_configure(Number(io.present)) !== 0)
          throw new Error('core refused I/O configuration');
        io.effectActive = exports.core_io_effect_active;
        const core = new Core(exports, isPaged, physicalControls, io);
        if (context !== undefined && !physicalControls) core.setContext(context);
        return core;
      } catch (error) {
        exports.core_dispose();
        throw error;
      }
    } catch (error) {
      io.release();
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
    const buffer = this.#exports.memory.buffer;
    let view = this.#stateDataView;
    // memory.grow(0) can replace the buffer without changing its size.
    if (view === undefined || view.buffer !== buffer) {
      view = new DataView(buffer, this.#statePointer, this.#layout.size);
      this.#stateDataView = view;
    }
    return view;
  }

  snapshot(): StateSnapshot {
    const view = this.stateView();
    const interruptibility = view.getUint32(this.#layout.interruptibility, true);
    const event = readEvent(
      view,
      this.#layout.event,
      this.#layout.event.offset,
      this.#layout.pagingSource,
    );
    const d = this.#layout.debug,
      raw = d.layout;
    const source = readDebugSource(view, raw.source, d.offset + raw.sourceOffset);
    if (source) {
      if (event.kind !== 'pending' || event.exception.vector !== 1)
        throw new Error('core returned an incompatible debug source');
      event.exception.debug = source;
    }
    const numeric = this.#layout.numericSource
      ? readNumericSource(view, this.#layout.numericSource)
      : undefined;
    if (numeric) {
      if (
        event.kind !== 'pending' ||
        event.exception.vector !== numeric.vector ||
        event.exception.instructionPc !== numeric.instructionPc ||
        event.exception.returnPc !== numeric.instructionPc ||
        source
      )
        throw new Error('core returned incompatible numeric source');
      if (numeric.vector === 7) event.exception.deviceNotAvailable = numeric;
      else event.exception.numericControlFault = numeric;
    }
    const debugContinuation = readDebugContinuation(
      view,
      raw.continuation,
      d.offset + raw.continuationOffset,
    );
    return {
      ...(debugContinuation ? { debugContinuation } : {}),
      registers: Array.from({ length: 16 }, (_, i) =>
        view.getBigUint64(this.#layout.registers + i * 8, true),
      ),
      flags: view.getBigUint64(this.#layout.flags, true),
      rip: view.getBigUint64(this.#layout.rip, true),
      interruptibility: {
        sti: (interruptibility & 1) !== 0,
        ss: (interruptibility & 2) !== 0,
      },
      event,
      interrupts: readInterrupts(view, this.#layout.interrupts, this.#layout.interrupts.offset),
    };
  }

  setState(state: State): void {
    const input = captureState(state);
    if (input.event.kind === 'pending' && input.event.exception.vector === 14 && !this.isPaged)
      throw new TypeError('page fault source requires ia32e-paged memory');
    const baseSize =
      this.#layout.scalarSize + this.#layout.event.bytes + this.#layout.interrupts.bytes;
    const debug = this.#layout.debug.layout;
    const oldSize = baseSize + debug.source.bytes + debug.continuation.bytes;
    const pagingSource = this.#layout.pagingSource;
    const numericSource = this.#layout.numericSource;
    const size = oldSize + (pagingSource?.bytes ?? 0) + (numericSource?.bytes ?? 0);
    const numeric =
      input.event.kind === 'pending'
        ? (input.event.exception.deviceNotAvailable ?? input.event.exception.numericControlFault)
        : undefined;
    if (numeric && !numericSource) throw new TypeError('core does not support numeric source');
    const pointer = this.#exports.core_input(size) >>> 0;
    const view = new DataView(this.#exports.memory.buffer, pointer, size);
    for (let index = 0; index < 16; index++) {
      view.setBigUint64(this.#layout.registers + index * 8, input.registers[index]!, true);
    }
    view.setBigUint64(this.#layout.flags, input.flags, true);
    view.setBigUint64(this.#layout.rip, input.rip, true);
    view.setUint32(
      this.#layout.interruptibility,
      Number(input.interruptibility.sti) | (Number(input.interruptibility.ss) << 1),
      true,
    );
    writeEvent(
      new DataView(
        view.buffer,
        view.byteOffset + this.#layout.scalarSize,
        this.#layout.event.bytes,
      ),
      this.#layout.event,
      input.event,
    );
    writeInterrupts(
      new DataView(
        view.buffer,
        view.byteOffset + this.#layout.scalarSize + this.#layout.event.bytes,
        this.#layout.interrupts.bytes,
      ),
      this.#layout.interrupts,
      input.interrupts,
    );
    writeDebugSource(
      new DataView(view.buffer, view.byteOffset + baseSize, debug.source.bytes),
      debug.source,
      input.event.kind === 'pending' ? input.event.exception.debug : undefined,
    );
    writeDebugContinuation(
      new DataView(
        view.buffer,
        view.byteOffset + baseSize + debug.source.bytes,
        debug.continuation.bytes,
      ),
      debug.continuation,
      input.debugContinuation,
    );
    if (pagingSource)
      writePagingSource(
        new DataView(view.buffer, view.byteOffset + oldSize, pagingSource.bytes),
        pagingSource,
        input.event.kind === 'pending' && input.event.exception.vector === 14
          ? input.event.exception.pageFaultAddress
          : undefined,
      );
    if (numericSource)
      writeNumericSource(
        new DataView(
          view.buffer,
          view.byteOffset + oldSize + (pagingSource?.bytes ?? 0),
          numericSource.bytes,
        ),
        numericSource,
        numeric,
      );
    if (this.#exports.core_import_state() !== 0)
      throw new TypeError(this.info<{ error: string }>().error);
  }

  readDebugState(): DebugState {
    const view = this.stateView(),
      d = this.#layout.debug,
      l = d.layout;
    return {
      addresses: Array.from({ length: 4 }, (_, i) =>
        view.getBigUint64(d.offset + l.addresses + i * 8, true),
      ),
      dr6: view.getBigUint64(d.offset + l.dr6, true),
      dr7: view.getBigUint64(d.offset + l.dr7, true),
    };
  }
  setDebugState(state: DebugState): void {
    const input = captureDebugState(state);
    const d = this.#layout.debug.layout;
    const pointer = this.#exports.core_input(d.sourceOffset) >>> 0;
    const view = new DataView(this.#exports.memory.buffer, pointer, d.sourceOffset);
    input.addresses.forEach((a, i) => view.setBigUint64(d.addresses + i * 8, a, true));
    view.setBigUint64(d.dr6, input.dr6, true);
    view.setBigUint64(d.dr7, input.dr7, true);
    if (this.#exports.core_import_debug() !== 0)
      throw new TypeError(this.info<{ error: string }>().error);
  }
  readPagingState(): PagingState {
    if (!this.isPaged) throw new TypeError('method requires ia32e-paged memory');
    if (this.#exports.core_paging_state() !== 0)
      throw new TypeError(this.info<{ error: string }>().error);
    return pagingStateFromJson(this.info<unknown>());
  }
  setPagingState(state: PagingState): void {
    if (!this.isPaged) throw new TypeError('method requires ia32e-paged memory');
    writeInput(this.#exports, capturePagingState(state));
    if (this.#exports.core_import_paging() !== 0)
      throw new TypeError(this.info<{ error: string }>().error);
  }
  readFastSystemState(): FastSystemState {
    if (!this.isPaged) throw new TypeError('method requires ia32e-paged memory');
    if (this.#exports.core_fast_system_state() !== 0)
      throw new TypeError(this.info<{ error: string }>().error);
    return fastSystemStateFromJson(this.info<unknown>());
  }
  setFastSystemState(state: FastSystemState): void {
    if (!this.isPaged) throw new TypeError('method requires ia32e-paged memory');
    writeInput(this.#exports, captureFastSystemState(state));
    if (this.#exports.core_import_fast_system() !== 0)
      throw new TypeError(this.info<{ error: string }>().error);
  }
  readTimeState(): TimeState {
    const view = this.stateView(),
      layout = this.#layout.time;
    return {
      tsc: view.getBigUint64(layout.offset + layout.tsc, true),
      tscAux: view.getUint32(layout.offset + layout.tscAux, true),
    };
  }
  setTimeState(state: TimeState): void {
    const input = captureTimeState(state),
      view = this.stateView(),
      layout = this.#layout.time;
    view.setBigUint64(layout.offset + layout.tsc, input.tsc, true);
    view.setUint32(layout.offset + layout.tscAux, input.tscAux, true);
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

  private diagnosticPc(): bigint {
    const view = this.stateView();
    const event = this.#layout.event;
    return view.getBigUint64(
      view.getUint32(event.offset + event.kind, true) === 1
        ? event.offset + event.instructionPc
        : this.#layout.rip,
      true,
    );
  }

  clearFault(): void {
    this.#exports.core_clear_fault();
  }
  prepareEntry(): boolean {
    const value = this.#exports.core_clear_fault();
    if (value !== 0 && value !== 1) throw new Error('core returned an invalid boundary profile');
    return value === 1;
  }
  eventKind(): EventState['kind'] {
    return eventKind(
      this.stateView().getUint32(this.#layout.event.offset + this.#layout.event.kind, true),
    );
  }
  hasQueuedInterrupts(): boolean {
    const view = this.stateView();
    const layout = this.#layout.interrupts;
    return (
      view.getUint32(layout.offset + layout.irq, true) !== 0 ||
      view.getUint32(layout.offset + layout.nmiPending, true) !== 0
    );
  }
  configureDelivery(enabled: boolean): void {
    if (this.#exports.core_configure_delivery(Number(enabled)) !== 0)
      throw new Error('core returned an invalid delivery configuration status');
  }
  stageException(reason: string): boolean {
    const id = this.#layout.reasons.indexOf(reason);
    if (id < 0) throw new Error('cannot stage an unknown execution reason');
    const status = this.#exports.core_stage_exception(id);
    if (status !== 0 && status !== 1)
      throw new Error('core returned an invalid exception staging status');
    return status === 1;
  }
  deliverException(): string {
    return this.reason(this.#exports.core_deliver_exception());
  }
  requestInterrupt(vector: number): boolean {
    const result = this.#exports.core_request_interrupt(vector);
    if (result !== 0 && result !== 1) throw new Error('core returned an invalid IRQ intake status');
    return result === 0;
  }
  requestNmi(): void {
    if (this.#exports.core_request_nmi() !== 0)
      throw new Error('core returned an invalid NMI intake status');
  }
  externalBoundary(): string {
    const reason = this.reason(this.#exports.core_external_boundary());
    if (!['dispatch', 'pending-interrupt', 'halted', 'shutdown'].includes(reason))
      throw new Error('core returned an invalid external boundary status');
    return reason;
  }
  shutdownCanWake(): boolean {
    const result = this.#exports.core_shutdown_can_wake();
    if (result !== 0 && result !== 1)
      throw new Error('core returned an invalid shutdown wake status');
    return result === 1;
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
    if (typeof metadata.boundaryObserved !== 'boolean')
      throw new Error('core returned an invalid boundary profile');
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

  instantiate(module: WebAssembly.Module, observed = false): GeneratedRun {
    const operands = observed
      ? {
          core_io: this.#exports.core_io_observed,
          core_load: this.#exports.core_load_observed,
          core_load_for_write: this.#exports.core_load_for_write_observed,
          core_store: this.#exports.core_store_observed,
          core_segmented_load: this.#exports.core_segmented_load_observed,
          core_segmented_load_for_write: this.#exports.core_segmented_load_for_write_observed,
          core_segmented_store: this.#exports.core_segmented_store_observed,
          core_vector_load: this.#exports.core_vector_load_observed,
          core_vector_store: this.#exports.core_vector_store_observed,
          core_load_mxcsr: this.#exports.core_load_mxcsr_observed,
          core_store_mxcsr: this.#exports.core_store_mxcsr_observed,
          core_x87: this.#exports.core_x87_observed,
          core_mmx: this.#exports.core_mmx_observed,
          core_numeric_image: this.#exports.core_numeric_image_observed,
          core_masked_store: this.#exports.core_masked_store_observed,
          core_protection: this.#exports.core_protection_observed,
          core_far_control: this.#exports.core_far_control_observed,
          core_compound_stack: this.#exports.core_compound_stack_observed,
          core_software_event: this.#exports.core_software_event_observed,
        }
      : this.#exports;
    const env: Record<string, WebAssembly.ImportValue> = {
      memory: this.#exports.memory,
      io: operands.core_io,
      load: operands.core_load,
      load_for_write: operands.core_load_for_write,
      store: operands.core_store,
      access_failed: this.#exports.core_access_failed,
      segmented_load: operands.core_segmented_load,
      segmented_load_for_write: operands.core_segmented_load_for_write,
      segmented_store: operands.core_segmented_store,
      segmented_access_failed: this.#exports.core_segmented_access_failed,
      access_reason: this.#exports.core_access_reason,
      vector_load: operands.core_vector_load,
      vector_store: operands.core_vector_store,
      float: this.#exports.core_float,
      load_mxcsr: operands.core_load_mxcsr,
      store_mxcsr: operands.core_store_mxcsr,
      x87: operands.core_x87,
      mmx: operands.core_mmx,
      numeric_image: operands.core_numeric_image,
      masked_store: operands.core_masked_store,
      clflush: this.#exports.core_clflush,
      protection: operands.core_protection,
      far_control: operands.core_far_control,
      compound_stack: operands.core_compound_stack,
      software_event: operands.core_software_event,
      flags: this.#exports.core_flags,
      debug_step: this.#exports.core_debug_step,
      debug_finish: this.#exports.core_debug_finish,
      debug_register: this.#exports.core_debug_register,
      paging_control: this.#exports.core_paging_control,
      processor: this.#exports.core_processor,
      debug_begin: this.#exports.core_debug_begin,
      external_step: this.#exports.core_external_step,
      halt: this.#exports.core_halt,
      target_check: this.#exports.core_target_check,
      multiply_high: this.#exports.core_multiply_high,
      divide: this.#exports.core_divide,
      divide_failed: this.#exports.core_divide_failed,
    };
    if (this.isPaged) {
      env.fast_system = this.#exports.core_fast_system;
      for (const [name, key] of Object.entries({
        ...PAGED_HELPERS,
        ...(observed ? PAGED_OBSERVED_HELPERS : {}),
      }))
        env[name] = this.#exports[key]!;
    }
    const instance = new WebAssembly.Instance(module, { env });
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
    if (this.io) this.io.executing = true;
    try {
      return this.reason(
        run(this.#statePointer, budget, stop ?? 0n, stop === undefined ? 0 : 1, entryIndex),
      );
    } finally {
      if (this.io) this.io.executing = false;
    }
  }

  fault(reason: string): Fault | undefined {
    if (reason !== 'data-fault' && reason !== 'fetch-fault' && reason !== 'target-fault')
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
          instructionPc: this.diagnosticPc(),
          address: BigInt(raw.address),
          failingAddress: BigInt(raw.failingAddress),
        };
  }

  readContext(): ExecutionContextSnapshot {
    this.#exports.core_context_info();
    return contextFromJson(this.info<ContextInfo>(), this.physicalControls);
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

  boundaryObserved(): boolean {
    const value = this.#exports.core_boundary_observed();
    if (value !== 0 && value !== 1) throw new Error('core returned an invalid boundary profile');
    return value === 1;
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
      instructionPc: this.diagnosticPc(),
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
      instructionPc: this.diagnosticPc(),
      offset: BigInt(raw.offset),
      address: BigInt(raw.address),
    };
  }

  simdException(reason: string): SimdException | undefined {
    if (reason !== 'simd-exception') return undefined;
    this.#exports.core_fault_info(this.#layout.reasons.indexOf(reason));
    return {
      ...this.info<Omit<SimdException, 'instructionPc'>>(),
      instructionPc: this.diagnosticPc(),
    };
  }

  generalProtectionFault(reason: string): GeneralProtectionFault | undefined {
    if (reason !== 'general-protection') return undefined;
    this.#exports.core_fault_info(this.#layout.reasons.indexOf(reason));
    return {
      ...this.info<Omit<GeneralProtectionFault, 'instructionPc'>>(),
      instructionPc: this.diagnosticPc(),
    };
  }

  protectionFault(reason: string): ProtectionFault | undefined {
    if (reason !== 'protection-fault') return undefined;
    this.#exports.core_fault_info(this.#layout.reasons.indexOf(reason));
    return {
      ...this.info<Omit<ProtectionFault, 'instructionPc'>>(),
      instructionPc: this.diagnosticPc(),
    };
  }

  debugException(reason: string): DebugException | undefined {
    if (reason !== 'debug-exception') return undefined;
    this.#exports.core_fault_info(this.#layout.reasons.indexOf(reason));
    const raw = this.info<
      Omit<DebugException, 'instructionPc' | 'resumePc' | 'resumeFlags' | 'deferredOriginPc'> & {
        deferredOriginPc?: string;
        instructionPc: string;
        resumePc: string;
        resumeFlags: string;
      }
    >();
    const { deferredOriginPc, ...diagnostic } = raw;
    return {
      ...diagnostic,
      instructionPc: BigInt(raw.instructionPc),
      resumePc: BigInt(raw.resumePc),
      resumeFlags: BigInt(raw.resumeFlags),
      ...(deferredOriginPc === undefined ? {} : { deferredOriginPc: BigInt(deferredOriginPc) }),
    };
  }

  systemMemoryFault(reason: string): SystemMemoryFault | undefined {
    if (reason !== 'system-memory-fault') return undefined;
    this.#exports.core_fault_info(this.#layout.reasons.indexOf(reason));
    const raw = this.info<
      Omit<SystemMemoryAccess, 'instructionPc' | 'address' | 'failingAddress'> &
        SystemMemoryReference & {
          address: string;
          failingAddress: string;
        }
    >();
    return {
      ...raw,
      instructionPc: this.diagnosticPc(),
      address: BigInt(raw.address),
      failingAddress: BigInt(raw.failingAddress),
    };
  }

  pageFault(reason: string): PageFault | undefined {
    if (reason !== 'page-fault') return undefined;
    this.#exports.core_fault_info(this.#layout.reasons.indexOf(reason));
    const raw = this.info<Omit<PageFault, 'instructionPc' | 'address'> & { address: string }>();
    return { ...raw, instructionPc: this.diagnosticPc(), address: BigInt(raw.address) };
  }

  physicalMemoryFault(reason: string): PhysicalMemoryFault | undefined {
    if (reason !== 'physical-memory-fault') return undefined;
    this.#exports.core_fault_info(this.#layout.reasons.indexOf(reason));
    const raw = this.info<Record<string, unknown>>();
    if (raw.phase === 'pdpte-load') {
      if (
        !['cr0', 'cr3', 'cr4'].includes(raw.control as string) ||
        !Number.isInteger(raw.slot) ||
        (raw.slot as number) < 0 ||
        (raw.slot as number) > 3 ||
        raw.width !== 8 ||
        raw.physicalAccess !== 'read' ||
        [
          'address',
          'access',
          'segment',
          'table',
          'systemPhase',
          'selector',
          'referenceVector',
        ].some((key) => key in raw) ||
        !['unmapped', 'permission', 'address-range'].includes(raw.cause as string)
      )
        throw new Error('core returned invalid PDPTE-load fault');
      return {
        ...raw,
        instructionPc: this.diagnosticPc(),
        physicalAddress: BigInt(raw.physicalAddress as string),
        failingPhysicalAddress: BigInt(raw.failingPhysicalAddress as string),
      } as PdpteLoadFault;
    }
    return {
      ...raw,
      instructionPc: this.diagnosticPc(),
      address: BigInt(raw.address as string),
      physicalAddress: BigInt(raw.physicalAddress as string),
      failingPhysicalAddress: BigInt(raw.failingPhysicalAddress as string),
    } as PhysicalAccessFault;
  }

  numericFault(reason: string): NumericFault | undefined {
    if (
      !['invalid-encoding', 'device-not-available'].includes(reason) ||
      !this.#exports.core_numeric_fault_info
    )
      return undefined;
    this.#exports.core_numeric_fault_info();
    const raw = this.info<(Record<string, unknown> & { instructionPc: string }) | null>();
    if (!raw) return undefined;
    const fault = captureNumericFault({ ...raw, instructionPc: BigInt(raw.instructionPc) });
    if ((fault.vector === 7) !== (reason === 'device-not-available'))
      throw new Error('numeric reason differs');
    return fault;
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
      instructionPc: this.diagnosticPc(),
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

  publish(owner: bigint): boolean {
    return this.#exports.core_publish(owner) === 1;
  }

  release(owner: bigint): void {
    this.#exports.core_release(owner);
  }

  releaseIo(): void {
    this.io?.release();
  }

  reset(): void {
    if (!this.physicalControls) throw new TypeError('reset requires physical memory');
    if (this.#exports.core_reset() !== 0) throw new TypeError(this.info<{ error: string }>().error);
  }

  dispose(): void {
    this.releaseIo();
    this.#exports.core_dispose();
  }
}
