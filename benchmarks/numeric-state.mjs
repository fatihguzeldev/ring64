const MASK64 = (1n << 64n) - 1n;
const marker = 0xffffn << 64n;
const put = (b, at, value, width) => {
  for (let i = 0; i < width; i++) b[at + i] = Number((BigInt(value) >> BigInt(8 * i)) & 255n);
};
function numeric(s) {
  s.x87.controlWord = 0x37f;
  s.x87.statusWord = 0x2800;
  s.x87.tagWord = 0xffff;
}
function transition(s) {
  s.x87.statusWord &= ~0x3800;
  s.x87.tagWord = 0;
}
function fx(s) {
  put(s.ram, 0, s.x87.controlWord, 2);
  put(s.ram, 2, s.x87.statusWord, 2);
  put(s.ram, 4, 0, 1);
  put(s.ram, 6, s.x87.opcode, 2);
  put(s.ram, 8, s.x87.instructionPointer, 8);
  put(s.ram, 16, s.x87.dataPointer, 8);
  put(s.ram, 24, s.mxcsr, 4);
  put(s.ram, 28, 0xffff, 4);
  const top = (s.x87.statusWord >> 11) & 7;
  for (let i = 0; i < 8; i++) put(s.ram, 32 + 16 * i, s.x87.registers[(top + i) & 7], 10);
  for (let i = 0; i < 16; i++) put(s.ram, 160 + 16 * i, s.xmm[i], 16);
}
export const numericStateRows = [
  {
    name: 'mmx-byte-add',
    body: '0ffcc1',
    instructions: 1,
    setup(s) {
      numeric(s);
      s.x87.registers[0] = 0n;
      s.x87.registers[1] = 0x0101010101010101n;
    },
    expected(s, n) {
      transition(s);
      s.x87.registers[0] = marker | ((n & 255n) * 0x0101010101010101n);
    },
  },
  {
    name: 'mmx-pack-saturating',
    body: '0f6fc20f63c1',
    instructions: 2,
    setup(s) {
      numeric(s);
      s.x87.registers[2] = 0x0080ff7f007fff80n;
      s.x87.registers[1] = 0x7fff80000000ffffn;
    },
    expected(s) {
      transition(s);
      s.x87.registers[0] = marker | 0x7f8000ff7f807f80n;
    },
  },
  {
    name: 'mmx-unpack-high',
    body: '0f6fc20f68c1',
    instructions: 2,
    setup(s) {
      numeric(s);
      s.x87.registers[2] = 0x0706050403020100n;
      s.x87.registers[1] = 0x0f0e0d0c0b0a0908n;
    },
    expected(s) {
      transition(s);
      s.x87.registers[0] = marker | 0x0f070e060d050c04n;
    },
  },
  {
    name: 'mmx-shift-variable',
    body: '0f6fc20fe1c1',
    instructions: 2,
    setup(s) {
      numeric(s);
      s.x87.registers[2] = 0xffff800000010002n;
      s.x87.registers[1] = 3n;
    },
    expected(s) {
      transition(s);
      s.x87.registers[0] = marker | 0xfffff00000000000n;
    },
  },
  {
    name: 'mmx-sad',
    body: '0f6fc20ff6c1',
    instructions: 2,
    setup(s) {
      numeric(s);
      s.x87.registers[2] = 0x00010203040506ffn;
      s.x87.registers[1] = 0n;
    },
    expected(s) {
      transition(s);
      s.x87.registers[0] = marker | 0x114n;
    },
  },
  {
    name: 'mmx-gpr-xmm-bridges',
    body: '0f6ec0f30fd6c0f20fd6c80f7ec8',
    instructions: 4,
    setup: numeric,
    expected(s) {
      const value = s.gpr[0] & 0xffffffffn;
      transition(s);
      s.x87.registers[0] = marker | value;
      s.x87.registers[1] = marker | value;
      s.xmm[0] = value;
      s.gpr[0] = value;
    },
  },
  {
    name: 'mmx-x87-emms',
    x87StatusMask: 0xbaff,
    body: '0fefc00f77d9e8ddd8',
    instructions: 4,
    setup: numeric,
    expected(s) {
      s.x87.statusWord = 0;
      s.x87.tagWord = 0xffff;
      s.x87.registers[0] = marker;
      s.x87.registers[7] = 0x3fff8000000000000000n;
      s.x87.instructionPointer = 0x1007n;
    },
  },
  {
    name: 'numeric-legacy-roundtrip',
    guestMemoryPerIteration: {
      read: { checked: 108, copied: 100 },
      write: { checked: 108, copied: 100 },
    },
    body: 'dd33dd23',
    instructions: 2,
    ramBytes: 108,
    setup(s) {
      numeric(s);
      s.gpr[3] = 0x4000n;
      s.ram.fill(0xa5);
    },
    expected(s) {
      put(s.ram, 0, s.x87.controlWord, 2);
      put(s.ram, 4, s.x87.statusWord, 2);
      put(s.ram, 8, 0xffff, 2);
      put(s.ram, 12, s.x87.instructionPointer, 4);
      put(s.ram, 16, 0, 2);
      put(s.ram, 18, s.x87.opcode, 2);
      put(s.ram, 20, s.x87.dataPointer, 4);
      put(s.ram, 24, 0, 2);
      for (let i = 0; i < 8; i++) put(s.ram, 28 + 10 * i, s.x87.registers[(5 + i) & 7], 10);
      s.x87.instructionPointer &= 0xffffffffn;
      s.x87.dataPointer &= 0xffffffffn;
    },
  },
  {
    name: 'mmx-add-dependent',
    body: '0fd4c1',
    instructions: 1,
    setup(s) {
      numeric(s);
      s.x87.registers[0] = 0n;
      s.x87.registers[1] = 7n;
    },
    expected(s, n) {
      transition(s);
      s.x87.registers[0] = marker | ((7n * n) & MASK64);
    },
  },
  {
    name: 'mmx-checked-load-store',
    guestMemoryPerIteration: { read: { checked: 8, copied: 8 }, write: { checked: 8, copied: 8 } },
    body: '0f6f030f7f03',
    instructions: 2,
    setup(s) {
      numeric(s);
      put(s.ram, 16, 0x8877665544332211n, 8);
    },
    expected(s) {
      transition(s);
      s.x87.registers[0] = marker | 0x8877665544332211n;
    },
  },
  {
    name: 'mmx-emms-boundary',
    body: '0fefc00f77',
    instructions: 2,
    setup: numeric,
    expected(s) {
      s.x87.statusWord &= ~0x3800;
      s.x87.tagWord = 0xffff;
      s.x87.registers[0] = marker;
    },
  },
  {
    name: 'mmx-convert-pi-ps',
    body: '0f2ac0',
    instructions: 1,
    setup(s) {
      numeric(s);
      s.x87.registers[0] = 0xfeffffff01000001n;
    },
    expected(s) {
      transition(s);
      s.xmm[0] = (s.xmm[0] & ~MASK64) | 0xcb8000004b800000n;
      s.mxcsr |= 0x20;
    },
  },
  {
    name: 'numeric-fxsave',
    guestMemoryPerIteration: {
      read: { checked: 0, copied: 0 },
      write: { checked: 512, copied: 367 },
    },
    body: '480fae03',
    instructions: 1,
    ramBytes: 512,
    setup(s) {
      numeric(s);
      s.gpr[3] = 0x4000n;
      s.ram.fill(0xa5);
    },
    expected: fx,
  },
  {
    name: 'numeric-fx-roundtrip-live-xmm',
    guestMemoryPerIteration: {
      read: { checked: 512, copied: 367 },
      write: { checked: 512, copied: 367 },
    },
    body: '480fae03660fefc0480fae0b',
    instructions: 3,
    ramBytes: 512,
    setup(s) {
      numeric(s);
      s.gpr[3] = 0x4000n;
      s.ram.fill(0xa5);
    },
    expected: fx,
  },
  {
    name: 'numeric-fnstenv',
    guestMemoryPerIteration: {
      read: { checked: 0, copied: 0 },
      write: { checked: 28, copied: 20 },
    },
    body: 'd933',
    instructions: 1,
    setup(s) {
      numeric(s);
      s.ram.fill(0xa5);
    },
    expected(s) {
      put(s.ram, 16, s.x87.controlWord, 2);
      put(s.ram, 20, s.x87.statusWord, 2);
      put(s.ram, 24, 0xffff, 2);
      put(s.ram, 28, s.x87.instructionPointer, 4);
      put(s.ram, 32, 0, 2);
      put(s.ram, 34, s.x87.opcode, 2);
      put(s.ram, 36, s.x87.dataPointer, 4);
      put(s.ram, 40, 0, 2);
    },
  },
]
  .flatMap((row) => [
    row,
    ...(row.name === 'mmx-add-dependent' || row.name === 'numeric-fx-roundtrip-live-xmm'
      ? [{ ...row, name: row.name + '-resume', resume: true }]
      : []),
  ])
  .map((row) => ({
    ...row,
    requiresX87: true,
    requiresNumericState: true,
    x87StatusMask: row.x87StatusMask ?? 0xffff,
  }));
