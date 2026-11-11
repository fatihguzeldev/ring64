export interface NumericControls {
  mp: boolean;
  em: boolean;
  ts: boolean;
  osfxsr: boolean;
  osxmmexcpt: boolean;
}
export type NumericFamily = 'x87' | 'wait' | 'mmx' | 'simd' | 'bridge' | 'fx-image';
interface NumericBoundary {
  instructionPc: bigint;
  family: NumericFamily;
  controls: NumericControls;
}
export interface DeviceNotAvailable extends NumericBoundary {
  vector: 7;
}
export type NumericControlFault = NumericBoundary & { vector: 6 } & (
    | { phase: 'admission'; cause: 'em' | 'osfxsr' }
    | {
        phase: 'numeric';
        cause: 'osxmmexcpt';
        stage: 'pre-computation' | 'post-computation';
        raised: number;
        unmasked: number;
        mxcsrBefore: number;
        mxcsrAfter: number;
      }
  );
export type NumericFault = DeviceNotAvailable | NumericControlFault;
const FAMILIES: NumericFamily[] = ['x87', 'wait', 'mmx', 'simd', 'bridge', 'fx-image'];
const CONTROLS = ['mp', 'em', 'ts', 'osfxsr', 'osxmmexcpt'] as const;
function record(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new TypeError('numeric source must be a record');
  return input as Record<string, unknown>;
}
function word(input: unknown, max: number): number {
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 0 || input > max)
    throw new TypeError('invalid numeric source word');
  return input;
}
export function captureNumericFault(input: unknown): NumericFault {
  const source = record(input),
    pc = source.instructionPc,
    family = source.family,
    vector = source.vector;
  if (
    typeof pc !== 'bigint' ||
    pc < 0n ||
    pc >= 1n << 64n ||
    !FAMILIES.includes(family as NumericFamily)
  )
    throw new TypeError('invalid numeric source boundary');
  const controlsSource = record(source.controls),
    controls = {} as NumericControls;
  for (const key of CONTROLS) {
    const value = controlsSource[key];
    if (typeof value !== 'boolean') throw new TypeError('numeric controls must be booleans');
    controls[key] = value;
  }
  const { mp, em, ts, osfxsr, osxmmexcpt } = controls;
  const base: NumericBoundary = { instructionPc: pc, family: family as NumericFamily, controls };
  if (vector === 7) {
    const allowed =
      family === 'x87' || family === 'fx-image'
        ? em || ts
        : family === 'wait'
          ? mp && ts
          : !em && ts && (family === 'mmx' || osfxsr);
    if (
      !allowed ||
      ['phase', 'cause', 'stage', 'raised', 'unmasked', 'mxcsrBefore', 'mxcsrAfter'].some(
        (key) => key in source,
      )
    )
      throw new TypeError('incoherent device-not-available source');
    return { ...base, vector: 7 };
  }
  const phase = source.phase,
    cause = source.cause;
  if (vector !== 6) throw new TypeError('numeric source vector must be6/7');
  if (phase === 'admission') {
    const allowed =
      cause === 'em'
        ? em && ['mmx', 'simd', 'bridge'].includes(base.family)
        : cause === 'osfxsr' && !em && !osfxsr && ['simd', 'bridge'].includes(base.family);
    if (
      !allowed ||
      ['stage', 'raised', 'unmasked', 'mxcsrBefore', 'mxcsrAfter'].some((key) => key in source)
    )
      throw new TypeError('incoherent numeric admission source');
    return { ...base, vector: 6, phase, cause: cause as 'em' | 'osfxsr' };
  }
  if (
    phase !== 'numeric' ||
    cause !== 'osxmmexcpt' ||
    em ||
    ts ||
    !osfxsr ||
    osxmmexcpt ||
    !['simd', 'bridge'].includes(base.family)
  )
    throw new TypeError('incoherent numeric exception source');
  const stage = source.stage,
    raised = word(source.raised, 63),
    unmasked = word(source.unmasked, 63),
    mxcsrBefore = word(source.mxcsrBefore, 0xffff),
    mxcsrAfter = word(source.mxcsrAfter, 0xffff);
  if (
    !['pre-computation', 'post-computation'].includes(stage as string) ||
    !raised ||
    !unmasked ||
    unmasked !== (raised & ~(mxcsrBefore >> 7) & 63) ||
    mxcsrAfter !== (mxcsrBefore | raised)
  )
    throw new TypeError('invalid numeric status source');
  return {
    ...base,
    vector: 6,
    phase,
    cause,
    stage: stage as 'pre-computation' | 'post-computation',
    raised,
    unmasked,
    mxcsrBefore,
    mxcsrAfter,
  };
}

export interface NumericSourceLayout {
  offset: number;
  bytes: number;
  kind: number;
  family: number;
  controls: number;
  stage: number;
  raised: number;
  before: number;
  after: number;
  reserved: number;
  instructionPc: number;
}
export function validateNumericSourceLayout(
  l: NumericSourceLayout,
  size: number,
  end: number,
): void {
  if (
    !l ||
    l.bytes !== 40 ||
    !Number.isSafeInteger(l.offset) ||
    l.offset < end ||
    l.offset + l.bytes > size
  )
    throw new Error('invalid numeric source layout');
  const spans = [
    'kind',
    'family',
    'controls',
    'stage',
    'raised',
    'before',
    'after',
    'reserved',
    'instructionPc',
  ]
    .map((key) => [l[key as keyof NumericSourceLayout], key === 'instructionPc' ? 8 : 4])
    .sort((a, b) => a[0]! - b[0]!);
  let next = 0;
  for (const [offset, width] of spans) {
    if (!Number.isSafeInteger(offset) || offset! < next || offset! + width! > l.bytes)
      throw new Error('overlapping numeric source layout');
    next = offset! + width!;
  }
}
export function writeNumericSource(
  view: DataView,
  l: NumericSourceLayout,
  source?: NumericFault,
): void {
  new Uint8Array(view.buffer, view.byteOffset, l.bytes).fill(0);
  if (!source) return;
  const fault = captureNumericFault(source),
    numeric = fault.vector === 6 && fault.phase === 'numeric';
  const kind =
    fault.vector === 7 ? 1 : fault.phase === 'numeric' ? 4 : fault.cause === 'em' ? 2 : 3;
  view.setUint32(l.kind, kind, true);
  view.setUint32(l.family, FAMILIES.indexOf(fault.family), true);
  view.setUint32(
    l.controls,
    CONTROLS.reduce((bits, key, index) => bits | (Number(fault.controls[key]) << index), 0),
    true,
  );
  view.setBigUint64(l.instructionPc, fault.instructionPc, true);
  if (numeric) {
    view.setUint32(l.stage, fault.stage === 'pre-computation' ? 1 : 2, true);
    view.setUint32(l.raised, fault.raised, true);
    view.setUint32(l.before, fault.mxcsrBefore, true);
    view.setUint32(l.after, fault.mxcsrAfter, true);
  }
}
export function readNumericSource(
  view: DataView,
  l: NumericSourceLayout,
): NumericFault | undefined {
  const offset = l.offset,
    kind = view.getUint32(offset + l.kind, true);
  if (!kind) {
    for (let index = 0; index < l.bytes; index += 4)
      if (view.getUint32(offset + index, true) !== 0)
        throw new Error('nonzero absent numeric source');
    return undefined;
  }
  const bits = view.getUint32(offset + l.controls, true),
    controls = {} as NumericControls;
  for (const [index, key] of CONTROLS.entries()) controls[key] = !!(bits & (1 << index));
  if (kind > 4 || bits > 31 || view.getUint32(offset + l.reserved, true))
    throw new Error('invalid native numeric source');
  const numeric = kind === 4,
    stage = view.getUint32(offset + l.stage, true),
    raised = view.getUint32(offset + l.raised, true),
    before = view.getUint32(offset + l.before, true),
    after = view.getUint32(offset + l.after, true);
  if (!numeric && stage | raised | before | after) throw new Error('unexpected numeric status');
  return captureNumericFault({
    vector: kind === 1 ? 7 : 6,
    instructionPc: view.getBigUint64(offset + l.instructionPc, true),
    family: FAMILIES[view.getUint32(offset + l.family, true)],
    controls,
    ...(kind === 1
      ? {}
      : {
          phase: numeric ? 'numeric' : 'admission',
          cause: kind === 2 ? 'em' : kind === 3 ? 'osfxsr' : 'osxmmexcpt',
        }),
    ...(numeric
      ? {
          stage: stage === 1 ? 'pre-computation' : stage === 2 ? 'post-computation' : 'invalid',
          raised,
          unmasked: raised & ~(before >> 7) & 63,
          mxcsrBefore: before,
          mxcsrAfter: after,
        }
      : {}),
  });
}
