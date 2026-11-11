// Literal 69-instruction packet from the reset spec; no production family resolver.
const hex = (s) => Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
const put = (bytes, at, value, width = 8) => {
  for (let i = 0; i < width; i++) bytes[at + i] = Number((value >> BigInt(8 * i)) & 255n);
};
const check = (condition, message) => {
  if (!condition) throw Error(message);
};
function resetContext() {
  const data = () => ({
    selector: 0,
    base: 0n,
    limit: 0xffff,
    default32: false,
    usable: true,
    type: 'read-write',
    dpl: 0,
    present: true,
    conforming: false,
    accessed: true,
    long: false,
    granularity: false,
    available: false,
  });
  return {
    mode: 'real',
    cpl: 0,
    segments: {
      cs: { ...data(), selector: 0xf000, base: 0xffff0000n },
      ss: data(),
      ds: data(),
      es: data(),
      fs: data(),
      gs: data(),
    },
    gdtr: { base: 0n, limit: 0xffff },
    idtr: { base: 0n, limit: 0xffff },
    ldtr: { selector: 0, valid: false, base: 0n, limit: 0xffff, attributes: 0 },
    tr: { selector: 0, valid: false, base: 0n, limit: 0xffff, attributes: 0 },
  };
}
function transitionProgram() {
  const ram = new Uint8Array(0x100000),
    rom = new Uint8Array(0x10000);
  rom.set(hex('ea00000010'), 0xfff0);
  ram.set(hex('270000000300'), 0x10200);
  for (const [i, image] of [
    '0000000000000000',
    'ffff0000009bcf00',
    'ffff00000093cf00',
    'ffff0000009baf00',
    'ffff0000009b0000',
  ].entries())
    ram.set(hex(image), 0x30000 + i * 8);
  for (const [address, code] of [
    [
      0x10000,
      'b80010 8ed8 0f01160002 66b808060000 0f22e0 dbe3 0f20c0 6625ffffff9f 6683c823 0f22c0 66ea000002000800',
    ],
    [
      0x20000,
      '66b81000 8ed8 8ec0 8ed0 bc00900000 b800100300 0f22d8 0f20c0 0d00000080 0f22c0 c7050060000011111111 0f20c0 25ffffff7f 0f22c0 b800600300 0f22d8 0f20e0 83c820 0f22e0 0f20c0 0d00000080 0f22c0 c7050060000022222222 0f20c0 25ffffff7f 0f22c0 b800b00300 0f22d8 b9800000c0 0f32 0d00010000 0f30 0f20c0 0d00000080 0f22c0 c7050060000033333333 ea001002001800',
    ],
    [0x21000, 'b844444444 c704250460000044444444 48ff2c2500500200'],
    [
      0x22000,
      '0f20c0 25ffffff7f 0f22c0 b9800000c0 0f32 25fffeffff 0f30 0f20e0 83e0df 0f22e0 c7050060000055555555 ea002300002000',
    ],
    [0x2300, '0f20c0 6683e0fe 0f22c0 ea00040010'],
    [0x10400, 'b8efbe'],
  ])
    ram.set(hex(code.replaceAll(' ', '')), address);
  ram.set(hex('00200200000000000800'), 0x25000);
  put(ram, 0x31000, 0x32003n, 4);
  put(ram, 0x36000, 0x37001n);
  put(ram, 0x37000, 0x38003n);
  put(ram, 0x3b000, 0x3c003n);
  put(ram, 0x3c000, 0x3d003n);
  put(ram, 0x3d000, 0x3e003n);
  for (let i = 0; i < 0x40; i++) {
    put(ram, 0x32000 + i * 4, i === 6 ? 0x90003n : BigInt(i << 12) | 3n, 4);
    put(ram, 0x38000 + i * 8, i === 6 ? 0x91003n : BigInt(i << 12) | 3n);
    put(ram, 0x3e000 + i * 8, i === 6 ? 0x92003n : BigInt(i << 12) | 3n);
  }
  return { ram, rom };
}

export async function transitionKernel(side, name, limits) {
  const split = name.endsWith('budget-one');
  const { ram, rom } = transitionProgram();
  const cpu = await side.createCpu({
    compiler: side.compiler,
    limits: { ...limits, maxTranslationsPerRun: 1000 },
    memoryModel: 'physical',
    entry: 0xfff0n,
    context: resetContext(),
    paging: { cr0: 0x60000010n, cr2: 0n, cr3: 0n, cr4: 0n, efer: 0n },
    memoryLimits: { maxBackingBytes: ram.length + rom.length, maxBackings: 2, maxMappings: 2 },
    memory: {
      backings: [
        { id: 'ram', bytes: ram },
        { id: 'rom', bytes: rom },
      ],
      mappings: [
        {
          base: 0n,
          backing: 'ram',
          offset: 0,
          length: ram.length,
          permissions: { read: true, write: true, execute: true },
        },
        {
          base: 0xffff0000n,
          backing: 'rom',
          offset: 0,
          length: rom.length,
          permissions: { read: true, write: false, execute: true },
        },
      ],
    },
  });
  return {
    cpu,
    units: 1,
    unit: 'complete 69-instruction family round trip; reset clears owners before each sample',
    prepare() {
      cpu.reset();
    },
    async run() {
      const runs = [];
      if (split) for (let i = 0; i < 69; i++) runs.push(await cpu.run({ budget: 1n }));
      else runs.push(await cpu.run({ budget: 100n, stop: 0x403n }));
      return runs;
    },
    validate(runs) {
      check(runs.length === (split ? 69 : 1), 'exact public invocation count');
      check(
        runs.every(
          (r) => r.reason === (split ? 'budget' : 'stop') && r.retired === (split ? 1n : 69n),
        ),
        'exact retirement boundaries',
      );
      const last = runs.at(-1),
        bank = cpu.readPagingState(),
        context = cpu.readContext();
      check(
        last.state.rip === 0x403n && (last.state.registers[0] & 0xffffn) === 0xbeefn,
        'literal real return',
      );
      check(
        bank.cr0 === 0x32n && bank.cr4 === 0x608n && bank.efer === 0n && bank.cr3 === 0x3b000n,
        'complete final control bank',
      );
      check(
        context.mode === 'real' &&
          context.segments.cs.base === 0x10000n &&
          context.segments.ss.default32,
        'retained cache contract',
      );
      for (const [address, value] of [
        [0x90000n, 0x11111111],
        [0x91000n, 0x22222222],
        [0x92000n, 0x33333333],
        [0x92004n, 0x44444444],
        [0x6000n, 0x55555555],
      ]) {
        const bytes = cpu.readPhysicalMemory(address, 4);
        check(
          new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) === value,
          'family physical witness',
        );
      }
      const resources = {},
        timings = {};
      for (const run of runs) {
        for (const [key, value] of Object.entries(run.resources))
          resources[key] =
            key === 'cachedArtifacts' || key === 'cachedBytes'
              ? value
              : (resources[key] ?? 0) + value;
        for (const [key, value] of Object.entries(run.timings))
          timings[key] = (timings[key] ?? 0) + value;
      }
      return {
        retired: 69n,
        completedRoundTrips: 1,
        publicRuns: runs.length,
        resources,
        timings,
        splitInstructionTimings: split
          ? runs.map((r, i) => ({
              instruction: i + 1,
              pc: r.state.rip,
              resources: r.resources,
              timings: r.timings,
            }))
          : undefined,
      };
    },
  };
}
