// Literal wire oracle, independent of the Rust descriptor and host validation.
export const DEBUG_LAYOUT = {
  offset: 616,
  layout: {
    bytes: 96,
    addresses: 0,
    dr6: 32,
    dr7: 40,
    sourceOffset: 48,
    source: {
      bytes: 32,
      kind: 0,
      slots: 4,
      singleStep: 8,
      completed: 12,
      origin: 16,
      hasOrigin: 24,
      reserved: 28,
    },
    continuationOffset: 80,
    continuation: { bytes: 16, slots: 0, reserved: 4, origin: 8 },
  },
};
