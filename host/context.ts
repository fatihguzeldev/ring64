import { byteLength, unsigned64 } from './core.js';

export type SegmentName = 'cs' | 'ss' | 'ds' | 'es' | 'fs' | 'gs';
export type SegmentType =
  | 'code'
  | 'readable-code'
  | 'read-only'
  | 'read-write'
  | 'expand-down-read-only'
  | 'expand-down-read-write';
export interface LoadedSegment {
  base: bigint;
  limit: number;
  default32: boolean;
  usable: boolean;
  type: SegmentType;
}
export type ExecutionContext =
  | { mode: 'long64'; fsBase: bigint; gsBase: bigint }
  | {
      mode: 'real' | 'virtual8086' | 'protected' | 'compatibility';
      segments: Record<SegmentName, LoadedSegment>;
    };

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
const TYPES: readonly SegmentType[] = [
  'code',
  'readable-code',
  'read-only',
  'read-write',
  'expand-down-read-only',
  'expand-down-read-write',
];

export function defaultContext(): ExecutionContext {
  return { mode: 'long64', fsBase: 0n, gsBase: 0n };
}

function captureSegment(segment: LoadedSegment): LoadedSegment {
  const base = segment.base;
  const limit = segment.limit;
  const default32 = segment.default32;
  const usable = segment.usable;
  const type = segment.type;
  unsigned64(base, 'segment base');
  if (base > 0xffffffffn) throw new TypeError('segment base must fit u32');
  byteLength(limit, 'segment limit');
  if (typeof default32 !== 'boolean' || typeof usable !== 'boolean')
    throw new TypeError('segment default32 and usable must be booleans');
  if (!TYPES.includes(type)) throw new TypeError('invalid segment type');
  return { base, limit, default32, usable, type };
}

export function captureContext(context: ExecutionContext): ExecutionContext {
  const mode = context.mode;
  if (mode === 'long64') {
    const fsBase = context.fsBase;
    const gsBase = context.gsBase;
    for (const base of [fsBase, gsBase]) {
      unsigned64(base, 'FS/GS base');
      if (base > 0x7fffffffffffn && base < 0xffff800000000000n)
        throw new TypeError('FS/GS base must be canonical48');
    }
    return { mode, fsBase, gsBase };
  }
  if (!['real', 'virtual8086', 'protected', 'compatibility'].includes(mode))
    throw new TypeError('invalid execution mode');
  const source = context.segments;
  const segments = {} as Record<SegmentName, LoadedSegment>;
  for (const name of SEGMENTS) segments[name] = captureSegment(source[name]);
  return { mode, segments };
}

export type ContextInfo =
  | { mode: 'long64'; fsBase: string; gsBase: string }
  | {
      mode: Exclude<ExecutionContext['mode'], 'long64'>;
      segments: Record<SegmentName, Omit<LoadedSegment, 'base'> & { base: string }>;
    };

// Rust publishes normalized owned JSON; convert only its address representation.
export function contextFromJson(value: ContextInfo): ExecutionContext {
  if (value.mode === 'long64')
    return captureContext({ ...value, fsBase: BigInt(value.fsBase), gsBase: BigInt(value.gsBase) });
  const segments = {} as Record<SegmentName, LoadedSegment>;
  for (const name of SEGMENTS)
    segments[name] = { ...value.segments[name], base: BigInt(value.segments[name].base) };
  return captureContext({ mode: value.mode, segments });
}
