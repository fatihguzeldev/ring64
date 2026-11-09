const CODE = 0x1000n;
const RAM = 0x4000n;
const GDT = 0x4100n;
const TSS = 0x4200n;
const IDT = 0x4300n;
const STACK = 0x4080n;
const IST_STACK = 0x40c0n;
const VECTOR = 0x20;
const CONTROLS = 0x3c3602n;
const put = (bytes, at, value, width) => {
  for (let i = 0; i < width; i++) bytes[at + i] = Number((value >> BigInt(8 * i)) & 255n);
};
const offset = (address) => Number(address - RAM);
const encode = (value) =>
  JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? item.toString() : item));

const rows = [
  { name: 'software-event-str-readonly', body: '0f00c8', instructions: 1, task: true },
  {
    name: 'software-event-ltr-reset-busy-str',
    body: 'c64505890f00da0f00c8',
    instructions: 3,
    task: true,
    loadTask: true,
  },
  ...[
    { mode: 'real', width: 16, profile: 'real16' },
    { mode: 'protected', width: 16, profile: 'protected16' },
    { mode: 'protected', width: 32, profile: 'protected32' },
    { mode: 'long64', width: 64, profile: 'long64' },
  ].map((row) => ({
    ...row,
    name: `software-event-int-iret-${row.profile}`,
    body: 'cd20',
    suffix: row.width === 64 ? '48cf' : 'cf',
    instructions: 2,
    transfer: true,
  })),
];
rows.push({
  ...rows.find((row) => row.transfer && row.width === 64),
  name: 'software-event-int-iret-64-resume',
  resume: true,
});
rows.push({
  ...rows.find((row) => row.transfer && row.width === 64 && !row.resume),
  name: 'software-event-ist1-stable-null-ss',
  ist: true,
});

export const softwareEventRows = rows.map((row) => ({
  ...row,
  profile: row.profile ?? 'long64',
  legacy: row.mode === 'protected',
  requiresSoftwareEvents: true,
  requiresSystemFlags: true,
  flagMask: 0x3d7fd7n,
  ramBytes: 2048,
  maxIterations: row.resume ? 1001 : 10001,
  context(cpu) {
    const value = cpu.readContext();
    value.gdtr = { base: GDT, limit: 55 };
    value.idtr = {
      base: IDT,
      limit: (VECTOR + 1) * (row.mode === 'real' ? 4 : row.width === 64 ? 16 : 8) - 1,
    };
    value.tr =
      row.task || row.ist
        ? { selector: 0x28, valid: true, base: TSS, limit: 0x67, attributes: 0x8b }
        : { selector: 0, valid: false, base: 0n, limit: 0, attributes: 0 };
    if (row.mode === 'real' || row.mode === 'protected') {
      value.mode = row.mode;
      value.segments.cs.long = false;
      value.segments.cs.default32 = row.width === 32;
      value.segments.ss.default32 = row.width === 32;
      if (row.mode === 'real') {
        value.segments.cs.selector = 0;
        value.segments.cs.limit = 0xffff;
      }
    }
    if (row.ist) {
      value.segments.ss.selector = 0;
      value.segments.ss.usable = false;
    }
    cpu.setContext(value);
    return cpu.readContext();
  },
  setup(s) {
    s.flags = row.mode === 'real' ? CONTROLS & ~0x40000n : CONTROLS;
    s.gpr[4] = row.ist ? STACK + 3n : STACK;
    s.ram.set(
      [255, 255, 0, 0, 0, 0x9b, row.width === 16 ? 0x8f : row.width === 32 ? 0xcf : 0xaf, 0],
      offset(GDT) + 8,
    );
    for (const selector of [16, 24])
      s.ram.set(
        [255, 255, 0, 0, 0, 0x93, selector === 16 && row.width === 16 ? 0x8f : 0xcf, 0],
        offset(GDT) + selector,
      );
    s.ram.set([0x67, 0, 0, 0x42, 0, row.loadTask ? 0x89 : 0x8b, 0, 0], offset(GDT) + 40);
    if (row.loadTask) {
      s.gpr[2] = 0x28n;
      s.gpr[5] = GDT + 40n;
    }
    if (!row.transfer) return;
    const target = CODE + BigInt(row.body.length / 2 + 2);
    const gate = offset(IDT) + VECTOR * (row.mode === 'real' ? 4 : row.width === 64 ? 16 : 8);
    if (row.mode === 'real') {
      put(s.ram, gate, target, 2);
      put(s.ram, gate + 2, 0n, 2);
    } else {
      put(s.ram, gate, target & 0xffffn, 2);
      put(s.ram, gate + 2, 8n, 2);
      s.ram[gate + 4] = row.ist ? 1 : 0;
      s.ram[gate + 5] = row.width === 16 ? 0x86 : 0x8e;
      put(s.ram, gate + 6, target >> 16n, 2);
      if (row.width === 64) put(s.ram, gate + 8, target >> 32n, 4);
    }
    if (row.ist) put(s.ram, offset(TSS) + 36, IST_STACK, 8);
  },
  expected(s) {
    if (row.task) {
      s.gpr[0] = 0x28n;
      if (row.loadTask) s.ram[offset(GDT) + 45] = 0x8b;
      return;
    }
    const width = row.width / 8;
    const stack = row.ist ? IST_STACK : STACK;
    if (row.width === 64) {
      put(s.ram, offset(stack) - width, row.ist ? 0n : 16n, width);
      put(s.ram, offset(stack) - 2 * width, s.gpr[4], width);
    }
    const slots = row.width === 64 ? 5 : 3;
    put(s.ram, offset(stack) - (slots - 2) * width, s.flags, width);
    put(s.ram, offset(stack) - (slots - 1) * width, row.mode === 'real' ? 0n : 8n, width);
    put(s.ram, offset(stack) - slots * width, CODE + BigInt(row.body.length / 2), width);
  },
  verify(cpu, expectedContext) {
    if (encode(cpu.readContext()) !== encode(expectedContext))
      throw Error('software event stable context changed');
  },
  resources(totals, n, sample, final, units) {
    const artifacts = row.transfer ? 3 : 1;
    const entries = row.transfer ? (row.resume ? 3 * Number(n) : 2 * Number(n) + 1) : 1;
    if (totals.compilations !== (sample === 0 ? artifacts : 0))
      throw Error('software event stable compilation reuse');
    if (totals.nativeEntries !== entries || totals.cacheHits !== entries - totals.compilations)
      throw Error('software event native entry/cache accounting');
    if (totals.dispatches !== (row.transfer && !row.resume ? 2 * Number(n) : 0))
      throw Error('software event dispatch accounting');
    if (units.length !== artifacts || final.cachedArtifacts !== artifacts)
      throw Error('software event retained unit count');
    if (units.some((unit) => unit.boundaryObserved)) throw Error('unexpected observed event unit');
    if (new Set(units.map((unit) => unit.contextVersion)).size !== 1)
      throw Error('software event stable context versions');
    if (final.cachedBytes !== units.reduce((size, unit) => size + unit.byteLength, 0))
      throw Error('software event cached bytes');
    if (totals.generatedBytes !== (sample === 0 ? final.cachedBytes : 0))
      throw Error('software event generated bytes');
  },
}));
