import { byteLength, unsigned64 } from './core.js';

export type SegmentName = 'cs' | 'ss' | 'ds' | 'es' | 'fs' | 'gs';
export type SegmentType =
  | 'code'
  | 'readable-code'
  | 'read-only'
  | 'read-write'
  | 'expand-down-read-only'
  | 'expand-down-read-write';
export type ExecutionMode = 'long64' | 'real' | 'virtual8086' | 'protected' | 'compatibility';
export interface LoadedSegment {
  base: bigint;
  limit: number;
  default32: boolean;
  usable: boolean;
  type: SegmentType;
}
export interface SegmentSnapshot extends LoadedSegment {
  selector: number;
  dpl: number;
  present: boolean;
  conforming: boolean;
  accessed: boolean;
  long: boolean;
  granularity: boolean;
  available: boolean;
}
export interface TableRegister {
  base: bigint;
  limit: number;
}
export interface LdtRegister {
  selector: number;
  valid: boolean;
  base: bigint;
  limit: number;
  attributes: number;
}
export interface TaskRegister {
  selector: number;
  valid: boolean;
  base: bigint;
  limit: number;
  attributes: number;
}
export interface ExecutionContextSnapshot {
  mode: ExecutionMode;
  cpl: number;
  segments: Record<SegmentName, SegmentSnapshot>;
  gdtr: TableRegister;
  idtr: TableRegister;
  ldtr: LdtRegister;
  tr: TaskRegister;
}
export type LegacyExecutionContext =
  | { mode: 'long64'; fsBase: bigint; gsBase: bigint }
  | {
      mode: Exclude<ExecutionMode, 'long64'>;
      segments: Record<SegmentName, LoadedSegment>;
    };
export type ExecutionContext =
  LegacyExecutionContext | (Omit<ExecutionContextSnapshot, 'tr'> & { tr?: TaskRegister });

export interface SegmentFault {
  instructionPc: bigint;
  segment: SegmentName;
  offset: bigint;
  width: number;
  access: 'read' | 'write' | 'execute';
  cause: 'unusable' | 'type' | 'limit';
  failingOffset: bigint;
}

const SEGMENTS: readonly SegmentName[] = ['cs', 'ss', 'ds', 'es', 'fs', 'gs'];
const MODES: readonly ExecutionMode[] = [
  'long64',
  'real',
  'virtual8086',
  'protected',
  'compatibility',
];
const TYPES: readonly SegmentType[] = [
  'code',
  'readable-code',
  'read-only',
  'read-write',
  'expand-down-read-only',
  'expand-down-read-write',
];
const EXTRA = [
  'selector',
  'dpl',
  'present',
  'conforming',
  'accessed',
  'long',
  'granularity',
  'available',
] as const;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('invalid execution context');
  return value as Record<string, unknown>;
}
function integer(value: unknown, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw new TypeError('invalid context integer');
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new TypeError('invalid context boolean');
  return value;
}
function canonical(base: bigint): boolean {
  return base <= 0x7fffffffffffn || base >= 0xffff800000000000n;
}
function systemBase(value: unknown, mode: ExecutionMode, raw = false): bigint {
  unsigned64(value, 'system base');
  if (!raw && mode !== 'long64' && mode !== 'compatibility' && value > 0xffffffffn)
    throw new TypeError('legacy system base must fit u32');
  return value;
}
function captureSegment(
  source: Record<string, unknown>,
  mode: ExecutionMode,
  name: SegmentName,
  full: boolean,
  raw: boolean,
): LoadedSegment {
  const base = source.base;
  const limit = source.limit;
  const default32 = source.default32;
  const usable = source.usable;
  const type = source.type;
  unsigned64(base, 'segment base');
  const wide = raw || mode === 'long64' || (full && mode === 'compatibility' && name !== 'cs');
  if (!wide && base > 0xffffffffn) throw new TypeError('segment base must fit u32');
  if (
    !raw &&
    (mode === 'long64' || mode === 'compatibility') &&
    (name === 'fs' || name === 'gs') &&
    !canonical(base)
  )
    throw new TypeError('FS/GS base must be canonical48');
  byteLength(limit, 'segment limit');
  if (typeof type !== 'string' || !TYPES.includes(type as SegmentType))
    throw new TypeError('invalid segment type');
  return {
    base,
    limit,
    default32: boolean(default32),
    usable: boolean(usable),
    type: type as SegmentType,
  };
}
function captureTable(value: unknown, mode: ExecutionMode, raw: boolean): TableRegister {
  const source = record(value);
  const base = source.base;
  const limit = source.limit;
  return { base: systemBase(base, mode, raw), limit: integer(limit, 0xffff) };
}
function captureSystemCache(
  value: unknown,
  mode: ExecutionMode,
  raw: boolean,
): LdtRegister | TaskRegister {
  const source = record(value);
  const selector = source.selector;
  const valid = source.valid;
  const base = source.base;
  const limit = source.limit;
  const attributes = source.attributes;
  return {
    selector: integer(selector, 0xffff),
    valid: boolean(valid),
    base: systemBase(base, mode, raw),
    limit: integer(limit, 0xffffffff),
    attributes: integer(attributes, 0xfff),
  };
}
function defaults(cache: LoadedSegment, selector: number, cpl: number): SegmentSnapshot {
  return {
    ...cache,
    selector,
    dpl: cpl,
    present: cache.usable,
    accessed: cache.usable,
    conforming: false,
    long: false,
    granularity: cache.limit > 0xfffff,
    available: false,
  };
}

export function captureContext(
  context: ExecutionContext,
  physical = false,
): ExecutionContextSnapshot {
  const source = record(context);
  const modeValue = source.mode;
  if (typeof modeValue !== 'string' || !MODES.includes(modeValue as ExecutionMode))
    throw new TypeError('invalid execution mode');
  const mode = modeValue as ExecutionMode;
  const hasTr = 'tr' in source;
  const hasSegments = 'segments' in source;
  const inputs = {} as Record<SegmentName, Record<string, unknown>>;
  if (mode !== 'long64' || hasSegments) {
    const segments = record(source.segments);
    for (const name of SEGMENTS) inputs[name] = record(segments[name]);
  }
  const full =
    ['cpl', 'gdtr', 'idtr', 'ldtr'].some((key) => key in source) ||
    hasTr ||
    (mode === 'long64' && hasSegments) ||
    SEGMENTS.some((name) => inputs[name] && EXTRA.some((key) => key in inputs[name]));
  const raw = physical && full;
  if (full && ('fsBase' in source || 'gsBase' in source))
    throw new TypeError('full snapshots cannot contain legacy FS/GS base aliases');
  const cpl = full ? integer(source.cpl, 3) : mode === 'virtual8086' ? 3 : 0;
  if ((mode === 'real' && cpl !== 0) || (mode === 'virtual8086' && cpl !== 3))
    throw new TypeError('invalid CPL for execution mode');
  const segments = {} as Record<SegmentName, SegmentSnapshot>;
  if (!full && mode === 'long64') {
    const fsBase = source.fsBase;
    const gsBase = source.gsBase;
    for (const base of [fsBase, gsBase]) {
      unsigned64(base, 'FS/GS base');
      if (!canonical(base)) throw new TypeError('FS/GS base must be canonical48');
    }
    for (const name of SEGMENTS) {
      segments[name] = defaults(
        {
          base: name === 'fs' ? (fsBase as bigint) : name === 'gs' ? (gsBase as bigint) : 0n,
          limit: 0xffffffff,
          usable: true,
          default32: name !== 'cs',
          type: name === 'cs' ? 'readable-code' : 'read-write',
        },
        name === 'cs' ? 8 : name === 'ss' ? 16 : 24,
        0,
      );
    }
    segments.cs.long = true;
  } else {
    for (const name of SEGMENTS) {
      const input = inputs[name];
      const cache = captureSegment(record(input), mode, name, full, raw);
      if (full) {
        segments[name] = {
          ...cache,
          selector: integer(input.selector, 0xffff),
          dpl: integer(input.dpl, 3),
          present: boolean(input.present),
          conforming: boolean(input.conforming),
          accessed: boolean(input.accessed),
          long: boolean(input.long),
          granularity: boolean(input.granularity),
          available: boolean(input.available),
        };
      } else {
        const selector =
          mode === 'real'
            ? 0
            : mode === 'virtual8086'
              ? Number(cache.base >> 4n)
              : name === 'cs'
                ? 8
                : name === 'ss'
                  ? 16
                  : 24;
        segments[name] = defaults(cache, selector, cpl);
      }
    }
  }
  if (mode === 'virtual8086') {
    for (const name of SEGMENTS) {
      const segment = segments[name];
      if (
        !segment.usable ||
        segment.type !== 'read-write' ||
        segment.base > 0xffff0n ||
        (segment.base & 15n) !== 0n ||
        segment.limit !== 0xffff ||
        segment.default32 ||
        segment.selector !== Number(segment.base >> 4n)
      )
        throw new TypeError('invalid virtual8086 segment');
    }
  } else if (mode !== 'long64') {
    const cs = segments.cs;
    const ss = segments.ss;
    if (
      !cs.usable ||
      !(
        ['code', 'readable-code'].includes(cs.type) ||
        (mode === 'real' && cs.type === 'read-write') ||
        (raw &&
          cpl === 0 &&
          (mode === 'protected' || mode === 'compatibility') &&
          cs.type === 'read-write')
      ) ||
      (!(raw || (full && mode === 'compatibility')) &&
        (!ss.usable || !['read-write', 'expand-down-read-write'].includes(ss.type)))
    )
      throw new TypeError('invalid loaded CS/SS');
  }
  return {
    mode,
    cpl,
    segments,
    gdtr: full ? captureTable(source.gdtr, mode, raw) : { base: 0n, limit: 0 },
    idtr: full ? captureTable(source.idtr, mode, raw) : { base: 0n, limit: 0 },
    ldtr: full
      ? captureSystemCache(source.ldtr, mode, raw)
      : { selector: 0, valid: false, base: 0n, limit: 0, attributes: 0 },
    tr: hasTr
      ? captureSystemCache(source.tr, mode, raw)
      : { selector: 0, valid: false, base: 0n, limit: 0, attributes: 0 },
  };
}

export type ContextInfo = Omit<
  ExecutionContextSnapshot,
  'segments' | 'gdtr' | 'idtr' | 'ldtr' | 'tr'
> & {
  segments: Record<SegmentName, Omit<SegmentSnapshot, 'base'> & { base: string }>;
  gdtr: Omit<TableRegister, 'base'> & { base: string };
  idtr: Omit<TableRegister, 'base'> & { base: string };
  ldtr: Omit<LdtRegister, 'base'> & { base: string };
  tr: Omit<TaskRegister, 'base'> & { base: string };
};

// Rust publishes normalized owned JSON; convert only its address representation.
export function contextFromJson(value: ContextInfo, physical = false): ExecutionContextSnapshot {
  const segments = {} as Record<SegmentName, SegmentSnapshot>;
  for (const name of SEGMENTS)
    segments[name] = { ...value.segments[name], base: BigInt(value.segments[name].base) };
  return captureContext(
    {
      ...value,
      segments,
      gdtr: { ...value.gdtr, base: BigInt(value.gdtr.base) },
      idtr: { ...value.idtr, base: BigInt(value.idtr.base) },
      ldtr: { ...value.ldtr, base: BigInt(value.ldtr.base) },
      tr: { ...value.tr, base: BigInt(value.tr.base) },
    },
    physical,
  );
}
