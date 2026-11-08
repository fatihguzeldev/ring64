const MASK64 = (1n << 64n) - 1n;
const put = (bytes, at, value, width) => {
  for (let i = 0; i < width; i++) bytes[at + i] = Number((value >> BigInt(8 * i)) & 255n);
};
function mmx(s) {
  s.x87.controlWord = 0x37f;
  s.x87.statusWord = 0x2800;
  s.x87.tagWord = 0xffff;
}
function transition(s) {
  s.x87.statusWord &= ~0x3800;
  s.x87.tagWord = 0;
}
const footprint = (checked, copied) => ({
  read: { checked: 0, copied: 0 },
  write: { checked, copied },
});
const rows = [];
for (const [name, body, width, bank] of [
  ['nti32', '0fc303', 4, 'gpr'],
  ['nti64', '480fc303', 8, 'gpr'],
  ['ntq', '0fe703', 8, 'mmx'],
  ['ntdq', '660fe703', 16, 'xmm'],
  ['ntps', '0f2b03', 16, 'xmm'],
  ['ntpd', '660f2b03', 16, 'xmm'],
])
  rows.push({
    name: `stream-${name}`,
    body,
    instructions: 1,
    guestMemoryPerIteration: footprint(width, width),
    setup(s) {
      if (bank === 'mmx') mmx(s);
    },
    expected(s) {
      const value =
        bank === 'gpr' ? s.gpr[0] : bank === 'xmm' ? s.xmm[0] : s.x87.registers[0] & MASK64;
      put(s.ram, 16, value, width);
      if (bank === 'mmx') transition(s);
    },
  });
for (const width of [8, 16]) {
  for (const [density, bits] of [
    ['zero', 0],
    ['one', 1],
    ['alternating', width === 8 ? 0x55 : 0x5555],
    ['full', (1 << width) - 1],
  ]) {
    const row = {
      name: `mask-${width}-${density}`,
      body: (width === 16 ? '66' : '') + '0ff7c1',
      instructions: 1,
      guestMemoryPerIteration: footprint(
        width,
        [...Array(width).keys()].filter((i) => bits & (1 << i)).length,
      ),
      setup(s) {
        s.gpr[7] = 0x4010n;
        let mask = 0n;
        for (let i = 0; i < width; i++)
          mask |= BigInt((bits & (1 << i) ? 128 : 0) | ((i * 7 + 3) & 127)) << BigInt(8 * i);
        if (width === 8) {
          mmx(s);
          s.x87.registers[1] = (0x1234n << 64n) | mask;
        } else s.xmm[1] = mask;
      },
      expected(s) {
        const data = width === 8 ? s.x87.registers[0] & MASK64 : s.xmm[0];
        for (let i = 0; i < width; i++)
          if (bits & (1 << i)) put(s.ram, 16 + i, data >> BigInt(8 * i), 1);
        if (width === 8) transition(s);
      },
    };
    rows.push(row);
    if (width === 16 && density === 'full')
      rows.push({ ...row, name: row.name + '-resume', resume: true });
  }
}
for (const [name, body] of [
  ['lfence', '0faeef'],
  ['mfence', '0faef7'],
  ['sfence', '0faeff'],
  ['pause', 'f34190'],
]) {
  rows.push({ name: `hint-${name}`, body, instructions: 1, expected() {} });
}
rows.push(
  {
    name: 'hint-prefetch-unmapped',
    body: '0f18030f180b0f18130f181b',
    instructions: 4,
    setup(s) {
      s.gpr[3] = 0x800000000000n;
    },
    expected() {},
  },
  {
    name: 'hint-clflush-probe',
    body: '0fae3b',
    instructions: 1,
    guestMemoryPerIteration: { read: { checked: 1, copied: 0 }, write: { checked: 0, copied: 0 } },
    expected() {},
  },
  {
    name: 'stream-ntdq-sfence',
    body: '660fe7030faef8',
    instructions: 2,
    guestMemoryPerIteration: footprint(16, 16),
    expected(s) {
      put(s.ram, 16, s.xmm[0], 16);
    },
  },
);
const fullMask = rows.find((row) => row.name === 'mask-16-full');
rows.push({
  ...fullMask,
  name: 'mask-16-full-mfence',
  body: fullMask.body + '0faef0',
  instructions: 2,
});
export const streamingRows = rows.map((row) => ({ ...row, requiresStreaming: true }));
