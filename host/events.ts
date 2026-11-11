import { captureDebugSource, type DebugSource } from './debug.js';
interface ExceptionBoundary {
  instructionPc: bigint;
  returnPc: bigint;
  savedFlags: bigint;
}

export type ExceptionEvent = ExceptionBoundary &
  (
    | { vector: 14; errorCode: number; pageFaultAddress: bigint; debug?: never }
    | {
        vector: 0 | 1 | 6 | 8 | 10 | 11 | 12 | 13 | 16 | 19;
        errorCode?: number;
        debug?: DebugSource;
        pageFaultAddress?: never;
      }
  );

export interface InterruptEvent {
  source: { kind: 'irq'; vector: number } | { kind: 'nmi' };
  returnPc: bigint;
  savedFlags: bigint;
}

export interface InterruptState {
  irq: number | null;
  nmiPending: boolean;
  nmiBlocked: boolean;
}

export type EventState =
  | { kind: 'ready' }
  | { kind: 'pending'; exception: ExceptionEvent }
  | { kind: 'pending-interrupt'; interrupt: InterruptEvent }
  | { kind: 'halted' }
  | { kind: 'shutdown' };

export interface InterruptLayout {
  offset: number;
  bytes: number;
  irq: number;
  nmiPending: number;
  nmiBlocked: number;
}

export interface EventLayout {
  offset: number;
  bytes: number;
  kind: number;
  vector: number;
  instructionPc: number;
  returnPc: number;
  savedFlags: number;
  errorCode: number;
  hasErrorCode: number;
}

export interface PagingSourceLayout {
  offset: number;
  bytes: number;
  address: number;
  hasAddress: number;
  reserved: number;
}

function word(value: number, maximum: number, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > maximum)
    throw new TypeError(`${name} is outside its unsigned integer range`);
  return value === 0 ? 0 : value;
}

function unsigned64(value: bigint, name: string): bigint {
  if (typeof value !== 'bigint' || value < 0n || value >= 1n << 64n)
    throw new TypeError(`${name} must be an unsigned 64-bit bigint`);
  return value;
}

function pageFaultAddress(value: bigint): bigint {
  const address = unsigned64(value, 'page fault address');
  if (address > 0x7fffffffffffn && address < 0xffff800000000000n)
    throw new TypeError('page fault address must be canonical48');
  return address;
}

export function captureEventState(input: EventState): EventState {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new TypeError('event must be a record');
  const kind = input.kind;
  if (kind === 'ready' || kind === 'halted' || kind === 'shutdown') return { kind };
  if (kind === 'pending-interrupt') {
    if ('exception' in input || 'errorCode' in input || 'pageFaultAddress' in input)
      throw new TypeError('an interrupt is not a processor exception');
    const value = input.interrupt;
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new TypeError('pending interrupt must contain an interrupt record');
    if ('exception' in value || 'errorCode' in value || 'pageFaultAddress' in value)
      throw new TypeError('an external interrupt has no exception error code');
    const source = value.source;
    if (typeof source !== 'object' || source === null || Array.isArray(source))
      throw new TypeError('pending interrupt requires a source');
    if ('exception' in source || 'errorCode' in source || 'pageFaultAddress' in source)
      throw new TypeError('an external source has no exception error code');
    const sourceKind = source.kind;
    let captured: InterruptEvent['source'];
    if (sourceKind === 'irq')
      captured = { kind: 'irq', vector: word(source.vector, 255, 'IRQ vector') };
    else if (sourceKind === 'nmi' && !('vector' in source)) captured = { kind: 'nmi' };
    else throw new TypeError('interrupt source must be irq with a vector or nmi without one');
    const returnPc = unsigned64(value.returnPc, 'interrupt return PC');
    const savedFlags = unsigned64(value.savedFlags, 'interrupt saved FLAGS');
    return { kind, interrupt: { source: captured, returnPc, savedFlags } };
  }
  if (kind !== 'pending') throw new TypeError('invalid event kind');
  const source = input.exception;
  if (typeof source !== 'object' || source === null || Array.isArray(source))
    throw new TypeError('pending event must contain an exception record');
  const vector = word(source.vector, 0xff, 'event vector') as ExceptionEvent['vector'];
  if (![0, 1, 6, 8, 10, 11, 12, 13, 14, 16, 19].includes(vector))
    throw new TypeError('event vector is outside the supported exception set');
  const instructionPc = unsigned64(source.instructionPc, 'event instruction PC');
  const returnPc = unsigned64(source.returnPc, 'event return PC');
  const savedFlags = unsigned64(source.savedFlags, 'event saved FLAGS');
  if (vector === 14) {
    if ('debug' in source) throw new TypeError('page fault cannot contain a debug source');
    const address = pageFaultAddress(source.pageFaultAddress!);
    const errorCode = word(source.errorCode!, 31, 'page fault error code');
    if (
      ((errorCode & 8) !== 0 && (errorCode & 1) === 0) ||
      ((errorCode & 2) !== 0 && (errorCode & 16) !== 0)
    )
      throw new TypeError('incompatible page fault error bits');
    return {
      kind,
      exception: {
        vector,
        instructionPc,
        returnPc,
        savedFlags,
        errorCode,
        pageFaultAddress: address,
      },
    };
  }
  if ('pageFaultAddress' in source) throw new TypeError('page fault address requires vector14');
  const exception: ExceptionEvent = { vector, instructionPc, returnPc, savedFlags };
  if ('debug' in source) exception.debug = captureDebugSource(source.debug!);
  if ('errorCode' in source)
    exception.errorCode = word(source.errorCode!, 0xffff, 'event error code');
  return { kind, exception };
}

export function captureInterruptState(input: InterruptState): InterruptState {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new TypeError('interrupts must be a record');
  const irq = input.irq;
  const nmiPending = input.nmiPending;
  const nmiBlocked = input.nmiBlocked;
  if (typeof nmiPending !== 'boolean' || typeof nmiBlocked !== 'boolean')
    throw new TypeError('NMI pending and blocked fields must be booleans');
  return { irq: irq === null ? null : word(irq, 255, 'IRQ vector'), nmiPending, nmiBlocked };
}

export function validateInterruptLayout(value: InterruptLayout, size: number, after: number): void {
  if (typeof value !== 'object' || value === null)
    throw new Error('core returned an invalid interrupt layout');
  for (const name of ['offset', 'bytes', 'irq', 'nmiPending', 'nmiBlocked'] as const)
    if (!Number.isSafeInteger(value[name]) || value[name] < 0 || value[name] > 0xffffffff)
      throw new Error('core returned an invalid interrupt layout');
  if (value.offset < after || value.bytes !== 12 || value.offset + value.bytes > size)
    throw new Error('core returned an incompatible interrupt layout');
  if (
    [value.irq, value.nmiPending, value.nmiBlocked]
      .sort((a, b) => a - b)
      .some((at, i) => at !== i * 4)
  )
    throw new Error('core returned overlapping interrupt layout fields');
}

export function readInterrupts(
  view: DataView,
  layout: InterruptLayout,
  offset = 0,
): InterruptState {
  const irq = view.getUint32(offset + layout.irq, true);
  const nmiPending = view.getUint32(offset + layout.nmiPending, true);
  const nmiBlocked = view.getUint32(offset + layout.nmiBlocked, true);
  if (irq > 256 || nmiPending > 1 || nmiBlocked > 1)
    throw new Error('core returned invalid interrupt state');
  return {
    irq: irq === 0 ? null : irq - 1,
    nmiPending: nmiPending === 1,
    nmiBlocked: nmiBlocked === 1,
  };
}

export function writeInterrupts(
  view: DataView,
  layout: InterruptLayout,
  input: InterruptState,
): void {
  view.setUint32(layout.irq, input.irq === null ? 0 : input.irq + 1, true);
  view.setUint32(layout.nmiPending, Number(input.nmiPending), true);
  view.setUint32(layout.nmiBlocked, Number(input.nmiBlocked), true);
}

export function validateEventLayout(value: EventLayout, size: number, after: number): void {
  if (typeof value !== 'object' || value === null)
    throw new Error('core returned an invalid event layout');
  for (const name of [
    'offset',
    'bytes',
    'kind',
    'vector',
    'instructionPc',
    'returnPc',
    'savedFlags',
    'errorCode',
    'hasErrorCode',
  ] as const)
    if (!Number.isSafeInteger(value[name]) || value[name] < 0 || value[name] > 0xffffffff)
      throw new Error('core returned an invalid event layout');
  if (value.offset < after || value.bytes !== 40 || value.offset + value.bytes > size)
    throw new Error('core returned an incompatible event layout');
  const spans = [
    [value.kind, 4],
    [value.vector, 4],
    [value.instructionPc, 8],
    [value.returnPc, 8],
    [value.savedFlags, 8],
    [value.errorCode, 4],
    [value.hasErrorCode, 4],
  ].sort((a, b) => a[0]! - b[0]!);
  let end = 0;
  for (const [start, length] of spans) {
    if (start !== end) throw new Error('core returned overlapping event layout fields');
    end = start! + length!;
  }
  if (end !== value.bytes) throw new Error('core returned an invalid event layout extent');
}

export function validatePagingSourceLayout(
  value: PagingSourceLayout,
  size: number,
  after: number,
): void {
  if (typeof value !== 'object' || value === null)
    throw new Error('core returned an invalid paging source layout');
  for (const name of ['offset', 'bytes', 'address', 'hasAddress', 'reserved'] as const)
    if (!Number.isSafeInteger(value[name]) || value[name] < 0 || value[name] > 0xffffffff)
      throw new Error('core returned an invalid paging source layout');
  if (value.bytes !== 16 || value.offset < after || value.offset + value.bytes > size)
    throw new Error('core returned an incompatible paging source layout');
  let end = 0;
  for (const [start, width] of [
    [value.address, 8],
    [value.hasAddress, 4],
    [value.reserved, 4],
  ].sort((a, b) => a[0]! - b[0]!)) {
    if (start !== end) throw new Error('core returned overlapping paging source fields');
    end += width!;
  }
  if (end !== value.bytes) throw new Error('core returned an invalid paging source extent');
}

export function readPagingSource(
  view: DataView,
  layout: PagingSourceLayout,
  offset = 0,
): bigint | undefined {
  const address = view.getBigUint64(offset + layout.address, true);
  const hasAddress = view.getUint32(offset + layout.hasAddress, true);
  const reserved = view.getUint32(offset + layout.reserved, true);
  if (
    hasAddress > 1 ||
    reserved !== 0 ||
    (!hasAddress && address !== 0n) ||
    (hasAddress && address > 0x7fffffffffffn && address < 0xffff800000000000n)
  )
    throw new Error('core returned an invalid paging source');
  return hasAddress ? address : undefined;
}

export function writePagingSource(
  view: DataView,
  layout: PagingSourceLayout,
  input: bigint | undefined,
): void {
  const address = input === undefined ? undefined : pageFaultAddress(input);
  new Uint8Array(view.buffer, view.byteOffset, layout.bytes).fill(0);
  if (address !== undefined) {
    view.setBigUint64(layout.address, address, true);
    view.setUint32(layout.hasAddress, 1, true);
  }
}

export function eventKind(value: number): EventState['kind'] {
  switch (value) {
    case 0:
      return 'ready';
    case 1:
      return 'pending';
    case 2:
      return 'shutdown';
    case 3:
      return 'halted';
    case 4:
    case 5:
      return 'pending-interrupt';
    default:
      throw new Error('core returned an invalid event kind');
  }
}

export function readEvent(
  view: DataView,
  layout: EventLayout,
  offset = 0,
  pagingSource?: PagingSourceLayout,
): EventState {
  const rawKind = view.getUint32(offset + layout.kind, true);
  const kind = eventKind(rawKind);
  if (kind === 'pending-interrupt') {
    const vector = view.getUint32(offset + layout.vector, true);
    if (
      vector > 255 ||
      (rawKind === 5 && vector !== 2) ||
      view.getBigUint64(offset + layout.instructionPc, true) !== 0n ||
      view.getUint32(offset + layout.errorCode, true) !== 0 ||
      view.getUint32(offset + layout.hasErrorCode, true) !== 0
    )
      throw new Error('core returned an invalid pending interrupt');
    return {
      kind,
      interrupt: {
        source: rawKind === 4 ? { kind: 'irq', vector } : { kind: 'nmi' },
        returnPc: view.getBigUint64(offset + layout.returnPc, true),
        savedFlags: view.getBigUint64(offset + layout.savedFlags, true),
      },
    };
  }
  if (kind !== 'pending') return { kind };
  const vector = view.getUint32(offset + layout.vector, true) as ExceptionEvent['vector'];
  const boundary = {
    instructionPc: view.getBigUint64(offset + layout.instructionPc, true),
    returnPc: view.getBigUint64(offset + layout.returnPc, true),
    savedFlags: view.getBigUint64(offset + layout.savedFlags, true),
  };
  const hasErrorCode = view.getUint32(offset + layout.hasErrorCode, true);
  if (hasErrorCode > 1) throw new Error('core returned an invalid event error-code tag');
  if (vector === 14) {
    if (!pagingSource) throw new Error('core omitted a pending page fault source layout');
    const address = readPagingSource(view, pagingSource, pagingSource.offset);
    if (address === undefined || hasErrorCode !== 1)
      throw new Error('core omitted a pending page fault source');
    try {
      return captureEventState({
        kind,
        exception: {
          vector,
          ...boundary,
          errorCode: view.getUint32(offset + layout.errorCode, true),
          pageFaultAddress: address,
        },
      });
    } catch (cause) {
      throw new Error('core returned an invalid pending page fault', { cause });
    }
  }
  const exception: ExceptionEvent = { vector, ...boundary };
  if (hasErrorCode) exception.errorCode = view.getUint32(offset + layout.errorCode, true);
  return { kind, exception };
}

export function writeEvent(view: DataView, layout: EventLayout, input: EventState): void {
  new Uint8Array(view.buffer, view.byteOffset, layout.bytes).fill(0);
  view.setUint32(
    layout.kind,
    input.kind === 'pending'
      ? 1
      : input.kind === 'shutdown'
        ? 2
        : input.kind === 'halted'
          ? 3
          : input.kind === 'pending-interrupt'
            ? input.interrupt.source.kind === 'irq'
              ? 4
              : 5
            : 0,
    true,
  );
  if (input.kind === 'pending-interrupt') {
    const source = input.interrupt;
    view.setUint32(layout.vector, source.source.kind === 'irq' ? source.source.vector : 2, true);
    view.setBigUint64(layout.returnPc, source.returnPc, true);
    view.setBigUint64(layout.savedFlags, source.savedFlags, true);
    return;
  }
  if (input.kind !== 'pending') return;
  const source = input.exception;
  view.setUint32(layout.vector, source.vector, true);
  view.setBigUint64(layout.instructionPc, source.instructionPc, true);
  view.setBigUint64(layout.returnPc, source.returnPc, true);
  view.setBigUint64(layout.savedFlags, source.savedFlags, true);
  if (source.errorCode !== undefined) {
    view.setUint32(layout.errorCode, source.errorCode, true);
    view.setUint32(layout.hasErrorCode, 1, true);
  }
}
