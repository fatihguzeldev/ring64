export interface DebugState {
  addresses: bigint[];
  dr6: bigint;
  dr7: bigint;
}
export interface DebugContinuation {
  breakpoints: number;
  originPc: bigint;
}
export type DebugSource =
  | { class: 'fault'; cause: 'execution-breakpoint'; breakpoints: number }
  | { class: 'fault'; cause: 'general-detect' }
  | {
      class: 'trap';
      cause: 'data-breakpoint';
      breakpoints: number;
      singleStep: boolean;
      instructionCompleted: boolean;
      deferredOriginPc?: bigint;
    };
interface SourceLayout {
  bytes: number;
  kind: number;
  slots: number;
  singleStep: number;
  completed: number;
  origin: number;
  hasOrigin: number;
  reserved: number;
}
interface ContinuationLayout {
  bytes: number;
  slots: number;
  origin: number;
  reserved: number;
}
export interface DebugLayout {
  offset: number;
  layout: {
    bytes: number;
    addresses: number;
    dr6: number;
    dr7: number;
    sourceOffset: number;
    source: SourceLayout;
    continuationOffset: number;
    continuation: ContinuationLayout;
  };
}
function record(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('debug input must be a record');
}
function wide(value: unknown, bits: number): bigint {
  if (typeof value !== 'bigint' || value < 0n || value >= 1n << BigInt(bits))
    throw new TypeError(`debug value must be an unsigned ${bits}-bit bigint`);
  return value;
}
function slots(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 15)
    throw new TypeError('debug mask must be an integer in1..15');
  return value;
}
export function captureDebugState(input: DebugState): DebugState {
  record(input);
  const source = input.addresses;
  if (!Array.isArray(source) || source.length !== 4)
    throw new TypeError('debug state requires four addresses');
  const addresses: bigint[] = [];
  for (let i = 0; i < 4; i++) addresses.push(wide(source[i], 64));
  return { addresses, dr6: wide(input.dr6, 32), dr7: wide(input.dr7, 32) };
}
export function captureDebugContinuation(input: DebugContinuation): DebugContinuation {
  record(input);
  return { breakpoints: slots(input.breakpoints), originPc: wide(input.originPc, 64) };
}
export function captureDebugSource(input: DebugSource): DebugSource {
  record(input);
  const kind = input.class,
    cause = input.cause;
  if (kind === 'fault' && (cause === 'execution-breakpoint' || cause === 'general-detect')) {
    if (
      'singleStep' in input ||
      'instructionCompleted' in input ||
      'deferredOriginPc' in input ||
      (cause === 'general-detect' && 'breakpoints' in input)
    )
      throw new TypeError('incompatible debug source fields');
    return cause === 'general-detect'
      ? { class: kind, cause }
      : { class: kind, cause, breakpoints: slots(input.breakpoints) };
  }
  if (kind === 'trap' && cause === 'data-breakpoint') {
    const breakpoints = slots(input.breakpoints),
      singleStep = input.singleStep,
      instructionCompleted = input.instructionCompleted;
    if (typeof singleStep !== 'boolean' || typeof instructionCompleted !== 'boolean')
      throw new TypeError('debug trap requires boolean completion and singleStep');
    return {
      class: kind,
      cause,
      breakpoints,
      singleStep,
      instructionCompleted,
      ...('deferredOriginPc' in input
        ? { deferredOriginPc: wide(input.deferredOriginPc, 64) }
        : {}),
    };
  }
  throw new TypeError('invalid debug source variant');
}
function bounds(bytes: number, fields: [number, number][]): void {
  const sorted = fields.slice().sort((a, b) => a[0] - b[0]);
  let end = 0;
  for (const [at, width] of sorted) {
    if (!Number.isSafeInteger(at) || at < end || at + width > bytes)
      throw new Error('invalid debug layout');
    end = at + width;
  }
}
export function validateDebugLayout(value: DebugLayout, size: number, after: number): void {
  if (!value || !value.layout || !Number.isSafeInteger(value.offset) || value.offset < after)
    throw new Error('invalid debug layout');
  const d = value.layout,
    s = d.source,
    c = d.continuation;
  if (
    d.bytes !== 96 ||
    !s ||
    s.bytes !== 32 ||
    !c ||
    c.bytes !== 16 ||
    value.offset + d.bytes > size
  )
    throw new Error('incompatible debug layout');
  // The debug-bank import is the prefix preceding the captured source.
  // Reject otherwise disjoint layouts that put bank fields in the checkpoint tail.
  if (d.continuationOffset < d.sourceOffset + s.bytes)
    throw new Error('invalid debug layout ordering');
  bounds(d.sourceOffset, [
    [d.addresses, 32],
    [d.dr6, 8],
    [d.dr7, 8],
  ]);
  bounds(d.bytes, [
    [d.addresses, 32],
    [d.dr6, 8],
    [d.dr7, 8],
    [d.sourceOffset, s.bytes],
    [d.continuationOffset, c.bytes],
  ]);
  bounds(s.bytes, [
    [s.kind, 4],
    [s.slots, 4],
    [s.singleStep, 4],
    [s.completed, 4],
    [s.origin, 8],
    [s.hasOrigin, 4],
    [s.reserved, 4],
  ]);
  bounds(c.bytes, [
    [c.slots, 4],
    [c.reserved, 4],
    [c.origin, 8],
  ]);
}
export function readDebugSource(
  view: DataView,
  s: SourceLayout,
  base = 0,
): DebugSource | undefined {
  const kind = view.getUint32(base + s.kind, true);
  if (kind === 0) return undefined;
  const mask = view.getUint32(base + s.slots, true);
  if (kind === 1) return { class: 'fault', cause: 'execution-breakpoint', breakpoints: mask };
  if (kind === 2) return { class: 'fault', cause: 'general-detect' };
  if (kind !== 3) throw new Error('invalid debug source tag');
  return {
    class: 'trap',
    cause: 'data-breakpoint',
    breakpoints: mask,
    singleStep: view.getUint32(base + s.singleStep, true) !== 0,
    instructionCompleted: view.getUint32(base + s.completed, true) !== 0,
    ...(view.getUint32(base + s.hasOrigin, true) !== 0
      ? { deferredOriginPc: view.getBigUint64(base + s.origin, true) }
      : {}),
  };
}
export function writeDebugSource(
  view: DataView,
  s: SourceLayout,
  input: DebugSource | undefined,
): void {
  new Uint8Array(view.buffer, view.byteOffset, view.byteLength).fill(0);
  if (!input) return;
  view.setUint32(
    s.kind,
    input.cause === 'execution-breakpoint' ? 1 : input.cause === 'general-detect' ? 2 : 3,
    true,
  );
  if ('breakpoints' in input) view.setUint32(s.slots, input.breakpoints, true);
  if (input.class === 'trap') {
    view.setUint32(s.singleStep, Number(input.singleStep), true);
    view.setUint32(s.completed, Number(input.instructionCompleted), true);
    if (input.deferredOriginPc !== undefined) {
      view.setBigUint64(s.origin, input.deferredOriginPc, true);
      view.setUint32(s.hasOrigin, 1, true);
    }
  }
}
export function readDebugContinuation(
  view: DataView,
  c: ContinuationLayout,
  base = 0,
): DebugContinuation | undefined {
  const breakpoints = view.getUint32(base + c.slots, true);
  return breakpoints
    ? { breakpoints, originPc: view.getBigUint64(base + c.origin, true) }
    : undefined;
}
export function writeDebugContinuation(
  view: DataView,
  c: ContinuationLayout,
  input: DebugContinuation | undefined,
): void {
  new Uint8Array(view.buffer, view.byteOffset, view.byteLength).fill(0);
  if (input) {
    view.setUint32(c.slots, input.breakpoints, true);
    view.setBigUint64(c.origin, input.originPc, true);
  }
}
