import type { ExecutionContextSnapshot, SegmentSnapshot } from '../../host/context.js';

// Literal normalized fixtures, independent of the production context normalizer.
export function longSnapshot(fsBase = 0n, gsBase = 0n): ExecutionContextSnapshot {
  const data = (selector: number, base = 0n): SegmentSnapshot => ({
    selector,
    base,
    limit: 0xffffffff,
    default32: true,
    usable: true,
    type: 'read-write',
    dpl: 0,
    present: true,
    conforming: false,
    accessed: true,
    long: false,
    granularity: true,
    available: false,
  });
  return {
    mode: 'long64',
    cpl: 0,
    segments: {
      cs: { ...data(8), type: 'readable-code', default32: false, long: true },
      ss: data(16),
      ds: data(24),
      es: data(24),
      fs: data(24, fsBase),
      gs: data(24, gsBase),
    },
    gdtr: { base: 0n, limit: 0 },
    idtr: { base: 0n, limit: 0 },
    ldtr: { selector: 0, valid: false, base: 0n, limit: 0, attributes: 0 },
    tr: { selector: 0, valid: false, base: 0n, limit: 0, attributes: 0 },
  };
}

export function protectedSnapshot(): ExecutionContextSnapshot {
  const result = longSnapshot();
  result.mode = 'protected';
  result.segments.cs.default32 = true;
  result.segments.cs.long = false;
  return result;
}
