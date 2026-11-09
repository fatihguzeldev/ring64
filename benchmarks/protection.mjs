const put = (bytes, at, value, width) => {
  for (let i = 0; i < width; i++) bytes[at + i] = Number((value >> BigInt(8 * i)) & 255n);
};
const read = (bytes, at, width) =>
  bytes
    .slice(at, at + width)
    .reduce((value, byte, i) => value | (BigInt(byte) << BigInt(8 * i)), 0n);
function descriptors(s) {
  s.flags &= ~64n;
  for (const at of [40, 48, 56]) s.ram.set([255, 255, 0, 0, 0, 0x93, 0xcf, 0], at);
  s.gpr[2] = 8n;
}
function context(cpu) {
  const value = cpu.readContext();
  value.gdtr = { base: 0x4020n, limit: 31 };
  cpu.setContext(value);
  return value;
}
const rows = [
  {
    name: 'descriptor-sgdt',
    body: '0f0103',
    instructions: 1,
    expected(s) {
      put(s.ram, 16, 31n, 2);
      put(s.ram, 18, 0x4020n, 8);
    },
  },
  {
    name: 'descriptor-sidt',
    body: '0f010b',
    instructions: 1,
    expected(s) {
      put(s.ram, 16, 0n, 10);
    },
  },
  {
    name: 'descriptor-lgdt-stable',
    body: '0f0113',
    instructions: 1,
    setup(s) {
      put(s.ram, 16, 31n, 2);
      put(s.ram, 18, 0x4020n, 8);
    },
    expected() {},
  },
  {
    name: 'descriptor-sldt',
    body: '0f00c0',
    instructions: 1,
    expected(s) {
      s.gpr[0] = 0n;
    },
  },
  {
    name: 'descriptor-segment-read',
    body: '8ce0',
    instructions: 1,
    expected(s) {
      s.gpr[0] = 24n;
    },
  },
  {
    name: 'descriptor-lar',
    body: '0f02c2',
    instructions: 1,
    setup: descriptors,
    expected(s) {
      s.gpr[0] = 0xc09300n;
      s.flags |= 64n;
    },
  },
  {
    name: 'descriptor-lsl',
    body: '0f03c2',
    instructions: 1,
    setup: descriptors,
    expected(s) {
      s.gpr[0] = 0xffffffffn;
      s.flags |= 64n;
    },
  },
  {
    name: 'descriptor-verr',
    body: '0f00e2',
    instructions: 1,
    setup: descriptors,
    expected(s) {
      s.flags |= 64n;
    },
  },
  {
    name: 'descriptor-verw',
    body: '0f00ea',
    instructions: 1,
    setup: descriptors,
    expected(s) {
      s.flags |= 64n;
    },
  },
  {
    name: 'descriptor-fs-reload-a1',
    body: '8ee2',
    instructions: 1,
    setup(s) {
      descriptors(s);
      s.gpr[2] = 24n;
    },
    expected() {},
    verify(cpu) {
      if (cpu.readContext().segments.fs.selector !== 24) throw Error('FS selector');
    },
  },
  {
    name: 'descriptor-fs-reload-a0-reset',
    body: 'c64305928ee2',
    instructions: 2,
    setup(s) {
      descriptors(s);
      s.gpr[2] = 24n;
      s.gpr[3] = 0x4038n;
    },
    expected() {},
  },
  {
    name: 'descriptor-load-after-fs-reload',
    body: '8ee264488b03',
    instructions: 2,
    setup(s) {
      descriptors(s);
      s.gpr[2] = 24n;
    },
    expected(s) {
      s.gpr[0] = read(s.ram, 16, 8);
    },
  },
  {
    name: 'descriptor-lss-stable',
    body: '480fb213',
    instructions: 1,
    setup(s) {
      descriptors(s);
      put(s.ram, 16, 0x123456789abcdef0n, 8);
      put(s.ram, 24, 16n, 2);
    },
    expected(s) {
      s.gpr[2] = 0x123456789abcdef0n;
    },
  },
];
rows.push({
  ...rows.find((row) => row.name === 'descriptor-lss-stable'),
  name: 'descriptor-lss-resume',
  resume: true,
});
const encode = (value) =>
  JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? item.toString() : item));
export const protectionRows = rows.map((row) => ({
  ...row,
  requiresProtection: true,
  context,
  verify(cpu, expected) {
    if (encode(cpu.readContext()) !== encode(expected))
      throw Error('stable descriptor context changed');
    row.verify?.(cpu);
  },
}));
