import { byteLength, unsigned64, type Span } from './core.js';
import type { ExecutionContext } from './context.js';
import type { PagingState } from './paging.js';
import type { FastSystemState } from './fast-system.js';

export type MemoryModel = 'linear' | 'ia32e-paged' | 'physical';

export interface MemoryBackingInput {
  id: string;
  bytes: Uint8Array;
}

export interface MemoryPermissions {
  read: boolean;
  write: boolean;
  execute: boolean;
}

export interface MemoryMapping {
  base: bigint;
  backing: string;
  offset: number;
  length: number;
  permissions: MemoryPermissions;
}

export interface MemoryLimits {
  maxBackingBytes: number;
  maxBackings: number;
  maxMappings: number;
}

export interface InitialMemory {
  memoryModel?: MemoryModel;
  paging?: PagingState;
  fastSystem?: FastSystemState;
  backings: MemoryBackingInput[];
  mappings: MemoryMapping[];
  memoryLimits: MemoryLimits;
  entry: bigint;
}

const typedArrayLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  'length',
)!.get!;
const setBytes = Uint8Array.prototype.set;

function actualLength(bytes: Uint8Array): number {
  return typedArrayLength.call(bytes) as number;
}

export function backingName(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id.length === 0)
    throw new TypeError('backing id must be a nonempty string');
}

export function captureMemoryLimits(input: MemoryLimits): MemoryLimits {
  const result = {
    maxBackingBytes: input.maxBackingBytes,
    maxBackings: input.maxBackings,
    maxMappings: input.maxMappings,
  };
  for (const value of Object.values(result)) {
    if (!Number.isInteger(value) || value <= 0 || value > 0xffffffff)
      throw new TypeError('memory capacities must be explicit positive wasm32 integers');
  }
  return result;
}

function capacity(bytes: number, count: number, limits: MemoryLimits): void {
  if (bytes > limits.maxBackingBytes || count > limits.maxBackings)
    throw new RangeError('backing capacity exceeded');
}

export function validateBackings(
  added: readonly MemoryBackingInput[],
  existing: ReadonlyMap<string, number>,
  limits: MemoryLimits,
): Map<string, number> {
  const lengths = new Map(existing);
  let bytes = 0;
  for (const length of existing.values()) bytes += length;
  for (const backing of added) {
    backingName(backing.id);
    if (lengths.has(backing.id)) throw new TypeError('duplicate backing id');
    lengths.set(backing.id, backing.bytes.length);
    bytes += backing.bytes.length;
  }
  capacity(bytes, lengths.size, limits);
  return lengths;
}

export function captureBackings(
  input: MemoryBackingInput[],
  limits: MemoryLimits,
  existing: ReadonlyMap<string, number> = new Map(),
): MemoryBackingInput[] {
  if (!Array.isArray(input)) throw new TypeError('backings must be an array');
  const count = input.length;
  byteLength(count, 'backing count');
  let total = 0;
  for (const length of existing.values()) total += length;
  capacity(total, existing.size + count, limits);
  const captured: { id: string; bytes: Uint8Array; length: number }[] = [];
  for (let index = 0; index < count; index++) {
    const backing = input[index]!;
    const id = backing.id;
    const bytes = backing.bytes;
    backingName(id);
    if (!(bytes instanceof Uint8Array)) throw new TypeError('backing bytes must be Uint8Array');
    const length = actualLength(bytes);
    byteLength(length, 'backing length');
    if (length === 0) throw new TypeError('backings must be nonempty');
    total += length;
    capacity(total, existing.size + count, limits);
    captured.push({ id, bytes, length });
  }
  // Allocate only after every declared length passed the capacity preflight.
  const result = captured.map(({ id, bytes, length }) => {
    const copy = new Uint8Array(length);
    if (actualLength(bytes) !== length)
      throw new TypeError('backing byte length changed during input capture');
    // Native typed-array copying rejects a source detached by a later accessor.
    setBytes.call(copy, bytes);
    return { id, bytes: copy };
  });
  validateBackings(result, existing, limits);
  return result;
}

export function captureMappings(
  input: MemoryMapping[],
  limits: MemoryLimits,
  memoryModel: MemoryModel = 'linear',
): MemoryMapping[] {
  if (memoryModel !== 'linear' && memoryModel !== 'ia32e-paged' && memoryModel !== 'physical')
    throw new TypeError('unsupported memory model');
  if (!Array.isArray(input)) throw new TypeError('mappings must be an array');
  const count = input.length;
  byteLength(count, 'mapping count');
  if (count > limits.maxMappings) throw new RangeError('mapping capacity exceeded');
  const result: MemoryMapping[] = [];
  for (let index = 0; index < count; index++) {
    const mapping = input[index]!;
    const base = mapping.base;
    const backing = mapping.backing;
    const offset = mapping.offset;
    const length = mapping.length;
    const permissions = mapping.permissions;
    const read = permissions.read;
    const write = permissions.write;
    const execute = permissions.execute;
    unsigned64(base, 'mapping base');
    backingName(backing);
    byteLength(offset, 'mapping offset');
    byteLength(length, 'mapping length');
    if (length === 0) throw new TypeError('mappings must be nonempty');
    if ([read, write, execute].some((permission) => typeof permission !== 'boolean'))
      throw new TypeError('mapping permissions must be booleans');
    const end = base + BigInt(length);
    const lowEnd = 0x800000000000n;
    const highStart = 0xffff800000000000n;
    if (memoryModel !== 'linear' && end > 1n << 52n)
      throw new TypeError('physical mapping must have a nonwrapping unsigned52 address range');
    if (memoryModel === 'linear' && (end > 1n << 64n || !(end <= lowEnd || base >= highStart)))
      throw new TypeError('mapping must have a nonwrapping canonical48 address range');
    result.push({ base, backing, offset, length, permissions: { read, write, execute } });
  }
  return result;
}

export function validateMappings(
  mappings: readonly MemoryMapping[],
  lengths: ReadonlyMap<string, number>,
): void {
  const sorted = [...mappings].sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : 0));
  let end = 0n;
  for (const mapping of sorted) {
    const backingLength = lengths.get(mapping.backing);
    if (backingLength === undefined || mapping.offset + mapping.length > backingLength)
      throw new TypeError('mapping must fit an existing backing');
    if (mapping.base < end) throw new TypeError('guest mappings overlap');
    end = mapping.base + BigInt(mapping.length);
  }
}

export type MemoryOptions =
  | {
      memoryModel?: 'linear';
      paging?: never;
      fastSystem?: never;
      code: Span;
      ram: Span;
      memoryLimits?: MemoryLimits;
      memory?: never;
      entry?: never;
    }
  | {
      memoryModel?: 'linear';
      paging?: never;
      fastSystem?: never;
      memory: { backings: MemoryBackingInput[]; mappings: MemoryMapping[] };
      entry: bigint;
      memoryLimits: MemoryLimits;
      code?: never;
      ram?: never;
    }
  | {
      memoryModel: 'ia32e-paged';
      paging: PagingState;
      fastSystem?: FastSystemState;
      memory: { backings: MemoryBackingInput[]; mappings: MemoryMapping[] };
      entry: bigint;
      memoryLimits: MemoryLimits;
      code?: never;
      ram?: never;
    }
  | {
      memoryModel: 'physical';
      context: ExecutionContext;
      paging: PagingState;
      fastSystem?: never;
      memory: { backings: MemoryBackingInput[]; mappings: MemoryMapping[] };
      entry: bigint;
      memoryLimits: MemoryLimits;
      code?: never;
      ram?: never;
    };

export function captureInitialMemory(options: MemoryOptions): InitialMemory {
  const memoryModel = 'memoryModel' in options ? options.memoryModel : 'linear';
  if (memoryModel !== 'linear' && memoryModel !== 'ia32e-paged' && memoryModel !== 'physical')
    throw new TypeError('memoryModel must be linear or ia32e-paged');
  if (memoryModel === 'linear' && 'paging' in options)
    throw new TypeError('linear memory cannot carry a paging state');
  if (memoryModel !== 'ia32e-paged' && 'fastSystem' in options)
    throw new TypeError('linear memory cannot carry a fast-system state');
  if (
    memoryModel !== 'linear' &&
    (!('memory' in options) ||
      !('entry' in options) ||
      !('memoryLimits' in options) ||
      !('paging' in options))
  )
    throw new TypeError('paged memory requires explicit memory, entry, limits and paging state');
  if (memoryModel === 'physical' && !('context' in options))
    throw new TypeError('physical memory requires an explicit context');
  let backings: MemoryBackingInput[];
  let mappings: MemoryMapping[];
  let memoryLimits: MemoryLimits;
  let entry: bigint;
  if ('memory' in options || 'entry' in options) {
    if ('code' in options || 'ram' in options || !('memory' in options))
      throw new TypeError('mixed or incomplete memory forms');
    const memory = options.memory;
    entry = options.entry;
    unsigned64(entry, 'entry');
    memoryLimits = captureMemoryLimits(options.memoryLimits);
    const backingInput = memory.backings;
    const mappingInput = memory.mappings;
    // Both record counts are bounded before either table is captured.
    if (!Array.isArray(mappingInput)) throw new TypeError('mappings must be an array');
    const mappingCount = mappingInput.length;
    byteLength(mappingCount, 'mapping count');
    if (mappingCount > memoryLimits.maxMappings) throw new RangeError('mapping capacity exceeded');
    backings = captureBackings(backingInput, memoryLimits);
    mappings = captureMappings(mappingInput, memoryLimits, memoryModel);
  } else {
    const code = options.code;
    const ram = options.ram;
    const codeBase = code.base;
    const ramBase = ram.base;
    unsigned64(codeBase, 'code base');
    unsigned64(ramBase, 'ram base');
    const codeBytes = code.bytes;
    const ramBytes = ram.bytes;
    if (!(codeBytes instanceof Uint8Array) || !(ramBytes instanceof Uint8Array))
      throw new TypeError('code and ram must contain Uint8Array bytes');
    const supplied = options.memoryLimits;
    memoryLimits = captureMemoryLimits(
      supplied ?? {
        maxBackingBytes: actualLength(codeBytes) + actualLength(ramBytes),
        maxBackings: 2,
        maxMappings: 2,
      },
    );
    if (memoryLimits.maxMappings < 2) throw new RangeError('mapping capacity exceeded');
    backings = captureBackings(
      [
        { id: 'code', bytes: codeBytes },
        { id: 'ram', bytes: ramBytes },
      ],
      memoryLimits,
    );
    mappings = captureMappings(
      [
        {
          base: codeBase,
          backing: 'code',
          offset: 0,
          length: backings[0]!.bytes.length,
          permissions: { read: true, write: false, execute: true },
        },
        {
          base: ramBase,
          backing: 'ram',
          offset: 0,
          length: backings[1]!.bytes.length,
          permissions: { read: true, write: true, execute: false },
        },
      ],
      memoryLimits,
    );
    entry = codeBase;
  }
  validateMappings(mappings, validateBackings(backings, new Map(), memoryLimits));
  return { backings, mappings, memoryLimits, entry, memoryModel };
}
