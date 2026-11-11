const limits = {
  maxInstructions: 128,
  maxSourceBytes: 2048,
  maxArtifactBytes: 262144,
  maxCachedArtifacts: 32,
  maxCachedBytes: 4194304,
  maxTranslationsPerRun: 32,
};
const hex = (source) => Uint8Array.from(source.match(/../g) ?? [], (b) => parseInt(b, 16));
const put = (bytes, offset, value, length = 8) => {
  for (let i = 0; i < length; i++) bytes[offset + i] = Number((value >> BigInt(8 * i)) & 255n);
};
const check = (condition, message) => {
  if (!condition) throw Error(message);
};
const loop = (body) => {
  const bytes = hex(body);
  return Uint8Array.of(...bytes, 0xff, 0xc9, 0x75, 256 - bytes.length - 4);
};
const state = (count) => ({
  registers: Array.from({ length: 16 }, (_, i) =>
    i === 1
      ? BigInt(count)
      : i === 2
        ? 0x80n
        : i === 3 || i === 6
          ? 0x4000n
          : i === 7
            ? 0x5000n
            : 0n,
  ),
  rip: 0x1000n,
  flags: 2n,
});
const x87 = (values) => {
  let tagWord = 0xffff;
  for (const [bank, value] of Object.entries(values))
    tagWord =
      (tagWord & ~(3 << (2 * Number(bank)))) | ((value === 0n ? 1 : 0) << (2 * Number(bank)));
  return {
    registers: Array.from({ length: 8 }, (_, i) => values[i] ?? 0n),
    tagWord,
    statusWord: 0,
    controlWord: 0x37f,
    instructionPointer: 0n,
    dataPointer: 0n,
    opcode: 0,
  };
};
const special = [
  {
    name: 'x87-fprem',
    body: 'd9f8',
    instructions: 1,
    values: { 0: 0x4001e000000000000000n, 1: 0x40008000000000000000n },
    expected: 0x3fff8000000000000000n,
  },
  {
    name: 'x87-fprem1',
    body: 'd9f5',
    instructions: 1,
    values: { 0: 0x4001e000000000000000n, 1: 0x40008000000000000000n },
    expected: 0xbfff8000000000000000n,
  },
  {
    name: 'x87-fscale',
    body: 'd9fd',
    instructions: 1,
    values: { 0: 0x3fffc000000000000000n, 1: 0n },
    expected: 0x3fffc000000000000000n,
  },
  {
    name: 'x87-fxtract-balanced',
    body: 'db2bd9f4ddd8ddd8',
    instructions: 4,
    values: {},
    raw: 0x4002c000000000000000n,
  },
  { name: 'x87-fbld-balanced', body: 'df23ddd8', instructions: 2, values: {}, bcd: true },
  {
    name: 'x87-fbstp-balanced',
    body: 'db2bdf7310',
    instructions: 2,
    values: {},
    raw: 0x4000a000000000000000n,
    store: true,
  },
];
export const newSpecNames = [
  ...special.map((row) => row.name),
  'io-in-scalar',
  'io-out-scalar',
  'io-rep-ins8-bitmap',
  'io-rep-ins8-paged-bitmap',
  ...['ins', 'outs'].flatMap((kind) => [8, 16, 32].map((width) => `io-rep-${kind}${width}`)),
  'legacy32-rmw',
  'legacy-pae-rmw',
  'ia32e-rmw',
  'physical-pg0-rmw',
  'numeric-clts-fnop',
  'numeric-nm-fault-attempt',
  'io-ins-private-fault-attempt',
  'physical-reset-small',
  'physical-reset-large',
  'physical-reset-resident8',
  'physical-reset-resident24',
];

async function linear(side, code, io, ramSize = 0x20000) {
  return side.createCpu({
    compiler: side.compiler,
    limits,
    code: { base: 0x1000n, bytes: code },
    ram: { base: 0x4000n, bytes: new Uint8Array(ramSize) },
    ...(io ? { io } : {}),
  });
}
async function physical(side, family, code, ramSize = 0x20000, io, compileLimits = {}) {
  const template = await linear(side, Uint8Array.of(0x90));
  const context = template.readContext();
  template.dispose();
  const long = family === 'ia32e';
  if (!long) {
    context.mode = 'protected';
    context.segments.cs.long = false;
    context.segments.cs.default32 = true;
  }
  const bytes = new Uint8Array(ramSize);
  bytes.set(code, family === 'pg0' ? 0x1000 : 0x5000);
  let bank;
  if (long) {
    for (const [address, value] of [
      [0x10000, 0x11003n],
      [0x11000, 0x12003n],
      [0x12000, 0x13003n],
      [0x13008, 0x5003n],
      [0x13020, 0x6003n],
    ])
      put(bytes, address, value);
    bank = { cr0: 0x80000033n, cr2: 0n, cr3: 0x10000n, cr4: 0x628n, efer: 0x500n };
  } else if (family === 'pae') {
    for (const [address, value] of [
      [0x14000, 0x12001n],
      [0x12000, 0x13003n],
      [0x13008, 0x5003n],
      [0x13020, 0x6003n],
    ])
      put(bytes, address, value);
    bank = {
      cr0: 0x80000033n,
      cr2: 0n,
      cr3: 0x14000n,
      cr4: 0x628n,
      efer: 0n,
      pdpte: [0x12001n, 0n, 0n, 0n],
    };
  } else {
    for (const [address, value] of [
      [0x12000, 0x13003n],
      [0x13004, 0x5003n],
      [0x13010, 0x6003n],
    ])
      put(bytes, address, value, 4);
    bank = {
      cr0: family === 'pg0' ? 0x33n : 0x80000033n,
      cr2: 0n,
      cr3: 0x12000n,
      cr4: 0x608n,
      efer: 0n,
    };
  }
  return side.createCpu({
    compiler: side.compiler,
    limits: { ...limits, ...compileLimits },
    ...(io ? { io } : {}),
    memoryModel: long ? 'ia32e-paged' : 'physical',
    context,
    paging: bank,
    entry: 0x1000n,
    memoryLimits: { maxBackingBytes: bytes.length, maxBackings: 1, maxMappings: 1 },
    memory: {
      backings: [{ id: 'ram', bytes }],
      mappings: [
        {
          base: 0n,
          backing: 'ram',
          offset: 0,
          length: bytes.length,
          permissions: { read: true, write: true, execute: true },
        },
      ],
    },
  });
}

async function kernel(side, name, requested) {
  const row = special.find((row) => row.name === name);
  if (row) {
    const cpu = await linear(side, loop(row.body));
    const n = requested;
    return {
      cpu,
      units: n,
      unit: 'retired loop iteration',
      expectedRetired: BigInt((row.instructions + 2) * n),
      prepare() {
        cpu.setState(state(n));
        cpu.setX87State(x87(row.values));
        if (row.raw) {
          const bytes = new Uint8Array(10);
          put(bytes, 0, row.raw, 10);
          cpu.writeMemory(0x4000n, bytes);
        }
        if (row.bcd) cpu.writeMemory(0x4000n, hex('42000000000000000080'));
      },
      validate() {
        const result = cpu.readX87State();
        if (row.expected !== undefined)
          check(result.registers[0] === row.expected, name + ' exact raw result');
        else
          check(
            result.tagWord === 0xffff && (result.statusWord & 0x3800) === 0,
            name + ' balanced stack',
          );
        if (row.name === 'x87-fxtract-balanced')
          check(
            result.registers[6] === 0x3fffc000000000000000n &&
              result.registers[7] === 0x4000c000000000000000n,
            'extracted raw significand/exponent',
          );
        if (row.bcd)
          check(
            result.registers[7] === 0xc004a800000000000000n,
            'exact negative BCD payload before pop',
          );
        if (row.store)
          check(
            [...cpu.readMemory(0x4010n, 10)].join(',') === '2,0,0,0,0,0,0,0,0,0',
            'rounded BCD store',
          );
      },
    };
  }
  if (name === 'numeric-nm-fault-attempt' || name === 'io-ins-private-fault-attempt') {
    const numeric = name.startsWith('numeric'),
      n = Math.min(requested, 1024);
    let calls = 0;
    const cpu = numeric
      ? await physical(side, 'ia32e', hex('d9d0'))
      : await linear(
          side,
          hex('6c'),
          {
            read() {
              calls++;
              return 0x7b;
            },
            write() {},
          },
          1,
        );
    return {
      cpu,
      units: n,
      unit: 'public failed instruction attempt',
      attempts: n,
      prepare() {
        cpu.setState(state(n));
        calls = 0;
        if (numeric) cpu.setPagingState({ ...cpu.readPagingState(), cr0: 0x8000003bn });
      },
      validate(results) {
        for (const result of results)
          check(
            result.reason === (numeric ? 'device-not-available' : 'data-fault') &&
              result.retired === 0n &&
              result.repeatIterations === 0n &&
              result.state.rip === 0x1000n,
            name + ' no failed progress',
          );
        check(calls === (numeric ? 0 : n), name + ' irreversible input attempts');
        return {
          attempts: n,
          consumedReads: calls,
          committedElements: 0,
          retired: 0n,
          resources: results.reduce(
            (sum, result) =>
              Object.fromEntries(
                Object.entries(result.resources).map(([key, value]) => [
                  key,
                  (sum[key] ?? 0) + value,
                ]),
              ),
            {},
          ),
        };
      },
    };
  }
  if (name.startsWith('io-')) {
    const repeated = name.includes('-rep-'),
      input = name.includes('-in'),
      width = Number(name.match(/\d+$/)?.[0] ?? 8),
      size = width / 8;
    const n = Math.min(requested, 65536),
      value = width === 8 ? 0x7b : width === 16 ? 0xbeef : 0x89abcdef;
    const opcode = input ? (size === 1 ? '6c' : '6d') : size === 1 ? '6e' : '6f';
    let calls = 0,
      checksum = 0;
    const io = {
      read() {
        calls++;
        return value;
      },
      write(_p, _w, actual) {
        calls++;
        checksum = (checksum + actual) >>> 0;
      },
    };
    const code = repeated
      ? hex((width === 16 ? '66' : '') + 'f3' + opcode)
      : loop(input ? 'ec' : 'ee');
    const pagedBitmap = name.includes('paged-bitmap'),
      bitmap = name.includes('bitmap');
    const cpu = pagedBitmap
      ? await physical(side, 'ia32e', code, 0x40000, io)
      : await linear(side, code, io, n * size + 0x1000);
    if (bitmap) {
      const context = cpu.readContext();
      context.cpl = 3;
      for (const segment of Object.values(context.segments)) {
        segment.dpl = 3;
        segment.selector |= 3;
      }
      context.tr = { selector: 0x28, valid: true, base: 0x4000n, limit: 0x100, attributes: 0x8b };
      cpu.setContext(context);
      if (pagedBitmap) {
        for (const [address, value] of [
          [0x10000n, 0x11007n],
          [0x11000n, 0x12007n],
          [0x12000n, 0x13007n],
          [0x13008n, 0x5007n],
        ]) {
          const bytes = new Uint8Array(8);
          put(bytes, 0, value);
          cpu.writePhysicalMemory(address, bytes);
        }
        for (let page = 0; page < Math.ceil(n / 4096); page++) {
          const bytes = new Uint8Array(8);
          put(bytes, 0, BigInt(0x16000 + page * 4096) | 7n);
          cpu.writePhysicalMemory(0x13028n + BigInt(page * 8), bytes);
        }
        cpu.writePhysicalMemory(0x6066n, hex('8000'));
      } else cpu.writeMemory(0x4066n, hex('8000'));
    }
    if (repeated && !input) {
      const bytes = new Uint8Array(n * size);
      for (let i = 0; i < n; i++) put(bytes, i * size, BigInt(value), size);
      cpu.writeMemory(0x4000n, bytes);
    }
    const registers = state(n);
    registers.registers[0] = 0x7bn;
    let providerOnlyMs;
    return {
      cpu,
      units: n,
      unit: 'full-width callback',
      expectedRetired: repeated ? 1n : BigInt(3 * n),
      repeat: repeated ? BigInt(n) : 0n,
      prepare() {
        cpu.setState(registers);
        calls = 0;
        checksum = 0;
        const began = performance.now();
        for (let i = 0; i < n; i++) {
          if (input) io.read(0x80, width);
          else io.write(0x80, width, value);
        }
        providerOnlyMs = performance.now() - began;
        calls = 0;
        checksum = 0;
      },
      validate() {
        check(calls === n, name + ' callback count');
        if (!input)
          check(
            checksum === Number((BigInt(value) * BigInt(n)) & 0xffffffffn),
            name + ' output checksum',
          );
        if (repeated && input) {
          const bytes = pagedBitmap
            ? cpu.readPhysicalMemory(0x16000n + BigInt((n - 1) * size), size)
            : cpu.readMemory(0x5000n + BigInt((n - 1) * size), size);
          check(
            bytes.every((byte, i) => byte === ((value >>> (8 * i)) & 255)),
            name + ' last input bytes',
          );
        }
        return {
          callbacks: calls,
          dataBytes: repeated ? n * size : 0,
          providerOnlyDirectLoopMs: providerOnlyMs,
          expectedPermissionU16ReadsPerElement: bitmap ? 2 : 0,
        };
      },
    };
  }
  const reset = name.startsWith('physical-reset');
  const family = name.startsWith('legacy32')
    ? 'legacy32'
    : name.startsWith('legacy-pae')
      ? 'pae'
      : name.startsWith('ia32e') || name === 'numeric-clts-fnop'
        ? 'ia32e'
        : 'pg0';
  const n = reset
    ? Math.min(requested, 1024)
    : name === 'numeric-clts-fnop'
      ? Math.min(requested, 2048)
      : requested;
  let cpu = await physical(
    side,
    family,
    loop(name === 'numeric-clts-fnop' ? '0f06d9d0' : 'ff03'),
    name.endsWith('large') ? 0x100000 : 0x20000,
  );
  const data = family === 'pg0' ? 0x4000n : 0x6000n;
  if (reset) {
    check(typeof cpu.reset === 'function', 'current build must include completed reset API');
    const ramSize = name.endsWith('large') ? 0x100000 : 0x20000;
    let before = cpu.readPhysicalMemory(0n, ramSize);
    const resident = Number(name.match(/resident(\d+)$/)?.[1] ?? 0);
    return {
      get cpu() {
        return cpu;
      },
      units: resident ? 1 : n,
      unit: 'idle reset at a stated resident-owner count',
      reset: resident ? 1 : n,
      async prepare() {
        if (!resident) return;
        cpu.dispose();
        cpu = await physical(side, 'pg0', new Uint8Array(64).fill(0x90), ramSize, undefined, {
          maxInstructions: 1,
        });
        cpu.setState(state(1));
        const warm = await cpu.run({ budget: BigInt(resident) });
        check(
          warm.resources.cachedArtifacts === resident,
          'resident owner population before reset',
        );
        before = cpu.readPhysicalMemory(0n, ramSize);
      },
      validate() {
        const image = cpu.readPhysicalMemory(0n, before.length);
        check(
          image.every((byte, i) => byte === before[i]),
          'reset preserves RAM',
        );
        const bank = cpu.readPagingState(),
          fp = cpu.readX87State();
        check(
          bank.cr0 === 0x60000010n && fp.controlWord === 0x40 && fp.tagWord === 0x5555,
          'literal reset bank',
        );
        return {
          retainedRamBytes: name.endsWith('large') ? 0x100000 : 0x20000,
          residentOwnersBeforeEachReset: resident,
        };
      },
    };
  }
  return {
    cpu,
    units: n,
    unit: name === 'numeric-clts-fnop' ? 'guest CLTS/FNOP loop iteration' : 'guest checked RMW',
    expectedRetired: BigInt((name === 'numeric-clts-fnop' ? 4 : 3) * n),
    prepare() {
      cpu.setState(state(n));
      cpu.writePhysicalMemory(data, new Uint8Array(4));
      if (name === 'numeric-clts-fnop')
        cpu.setPagingState({ ...cpu.readPagingState(), cr0: 0x8000003bn });
    },
    validate() {
      if (name === 'numeric-clts-fnop')
        check((cpu.readPagingState().cr0 & 8n) === 0n, 'CLTS clears TS');
      else {
        const bytes = cpu.readPhysicalMemory(data, 4);
        check(
          new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) === n,
          name + ' final RMW result',
        );
      }
      return { family };
    },
  };
}

export async function measureFive(
  side,
  { iterations = 65536, samples = 7, workloads = newSpecNames } = {},
) {
  const definitions = [],
    measurements = [];
  for (const name of workloads) {
    const began = performance.now(),
      row = await kernel(side, name, iterations);
    definitions.push({
      name,
      units: row.units,
      unit: row.unit,
      creationMs: performance.now() - began,
      evidence: 'new behavior characterization; no executable-old-baseline speedup claim',
    });
    try {
      for (let sample = -1; sample < samples; sample++) {
        await row.prepare();
        const at = performance.now();
        let result;
        const attempts = [];
        if (row.attempts)
          for (let i = 0; i < row.attempts; i++)
            attempts.push(await row.cpu.run({ budget: 1n, repeatBudget: 0n }));
        else if (row.reset) for (let i = 0; i < row.reset; i++) row.cpu.reset();
        else
          result = await row.cpu.run({
            budget: row.expectedRetired,
            repeatBudget: row.repeat ?? 0n,
          });
        const elapsedMs = performance.now() - at;
        if (result) {
          check(
            result.reason === 'budget' &&
              result.retired === row.expectedRetired &&
              result.repeatIterations === (row.repeat ?? 0n),
            name + ' exact work/accounting',
          );
          check(result.state.registers[1] === 0n, name + ' loop count');
        }
        const observed = row.validate(attempts) ?? {};
        measurements.push({
          name,
          phase: sample < 0 ? 'first invocation batch in shared process' : 'warm',
          sample,
          elapsedMs,
          units: row.units,
          ...observed,
          ...(result
            ? {
                retired: result.retired,
                repeatIterations: result.repeatIterations,
                resources: result.resources,
                timings: result.timings,
              }
            : {}),
        });
      }
    } finally {
      row.cpu.dispose();
    }
  }
  return {
    definitions,
    samples: measurements,
    claimCeiling:
      'Synthetic public-run time includes synchronous provider work. Provider-only direct-call loops include their own loop overhead and are never subtracted into engine cycles. Source/control/fault matrices and mutation campaigns are separate correctness evidence.',
  };
}
