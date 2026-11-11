const USER = 0x400000n,
  KERNEL = 0x401000n,
  HANDLER = 0x402000n,
  USER_SP = 0x403ff0n,
  KERNEL_SP = 0x404ff0n,
  TLS = 0x405000n;
const PAGING = { cr0: 0x80010033n, cr2: 0xdeadn, cr3: 0x1000n, cr4: 0x628n, efer: 0xd01n };
const FAST = {
  star: 0x0020000800000000n,
  lstar: KERNEL,
  fmask: 0x200n,
  sysenterCs: 8n,
  sysenterEip: KERNEL,
  sysenterEsp: KERNEL_SP,
  kernelGsBase: TLS,
};
const hex = (text) => Uint8Array.from(text.match(/../g) ?? [], (v) => parseInt(v, 16));
const stable = (v) =>
  JSON.stringify(v, (_, x) =>
    typeof x === 'bigint'
      ? x.toString()
      : x && typeof x === 'object' && !Array.isArray(x) && !ArrayBuffer.isView(x)
        ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
        : x,
  );
function equal(actual, expected, label) {
  if (ArrayBuffer.isView(actual) && ArrayBuffer.isView(expected)) {
    if (actual.length !== expected.length) throw Error(label + ': byte lengths differ');
    for (let i = 0; i < actual.length; i++)
      if (actual[i] !== expected[i])
        throw Error(`${label}: byte${i} ${actual[i]} != ${expected[i]}`);
  } else if (stable(actual) !== stable(expected))
    throw Error(`${label}: ${stable(actual)} != ${stable(expected)}`);
}
function put(bytes, offset, value, width = 8) {
  for (let i = 0; i < width; i++) bytes[offset + i] = Number((value >> BigInt(8 * i)) & 255n);
}
function context(kind) {
  const cpl = kind === 'msr' ? 0 : 3,
    compatibility = kind === 'sysret32' || kind === 'sysexit32',
    cs =
      kind === 'msr'
        ? 8
        : kind === 'sysexit32'
          ? 0x1b
          : kind === 'sysexit64'
            ? 0x2b
            : compatibility
              ? 0x23
              : 0x33,
    ss = kind === 'msr' ? 16 : kind === 'sysexit32' ? 0x23 : kind === 'sysexit64' ? 0x33 : 0x2b;
  const data = (selector, base = 0n) => ({
    selector,
    base,
    limit: 0xffffffff,
    default32: true,
    usable: true,
    type: 'read-write',
    dpl: cpl,
    present: true,
    conforming: false,
    accessed: true,
    long: false,
    granularity: true,
    available: false,
  });
  return {
    mode: compatibility ? 'compatibility' : 'long64',
    cpl,
    segments: {
      cs: { ...data(cs), type: 'readable-code', default32: compatibility, long: !compatibility },
      ss: data(ss),
      ds: data(0x2b),
      es: data(0x2b),
      fs: data(0x2b, 0xffff800000123000n),
      gs: data(0x2b, 0x409000n),
    },
    gdtr: { base: 0x406000n, limit: 0x3f },
    idtr: { base: 0x407000n, limit: 0xfff },
    ldtr: { selector: 0, valid: false, base: 0n, limit: 0, attributes: 0 },
    tr: { selector: 0, valid: false, base: 0n, limit: 0, attributes: 0 },
  };
}
const rows = [
  {
    name: 'fast-syscall-sysret64',
    kind: 'syscall',
    user: '0f0549ffc875f9',
    kernel: '480f07',
    perCycle: 4,
  },
  {
    name: 'fast-sysret32',
    kind: 'sysret32',
    user: '0f344b75fb',
    kernel: 'b90200400041bb0202000048bcf03f4000000000000f07',
    perCycle: 7,
  },
  {
    name: 'fast-sysenter-sysexit32',
    kind: 'sysexit32',
    user: '0f344b75fb',
    kernel: '0f35',
    perCycle: 4,
  },
  {
    name: 'fast-sysenter-sysexit64',
    kind: 'sysexit64',
    user: '0f3449ffc875f9',
    kernel: '480f35',
    perCycle: 4,
  },
  {
    name: 'fast-syscall-gs-stack',
    kind: 'gs',
    user: '0f0549ffc875f9',
    kernel:
      '0f01f865488924250000000065488b24250800000050586548ff04251000000065488b2425000000000f01f8480f07',
    perCycle: 12,
  },
  {
    name: 'fast-selected-rdmsr',
    kind: 'msr',
    user: '0f3249ffc875f9',
    kernel: '480f07',
    perCycle: 3,
  },
  {
    name: 'fast-budget-one-roundtrip',
    kind: 'syscall',
    resume: true,
    user: '0f0549ffc875f9',
    kernel: '480f07',
    perCycle: 4,
  },
  {
    name: 'fast-debug-enabled-miss',
    kind: 'syscall',
    debug: true,
    user: '0f0549ffc875f9',
    kernel: '480f07',
    perCycle: 4,
  },
  {
    name: 'fast-kernel-cr3-roundtrip',
    kind: 'root',
    user: '0f0549ffc875f9',
    kernel: '48b800500000000000000f22d848b800100000000000000f22d8480f07',
    perCycle: 8,
  },
  {
    name: 'fast-target-pf-guest-repair',
    kind: 'pf',
    cycles: true,
    user: '0f05',
    kernel: '480f07',
    perCycle: 7,
  },
  {
    name: 'fast-target-private-repair',
    kind: 'private',
    cycles: true,
    user: '0f05',
    kernel: '480f07',
    perCycle: 2,
  },
];
export const fastNames = rows.map((row) => row.name);
const inheritedMsrRows = [
  {
    name: 'inherited-efer-rdmsr',
    kind: 'msr',
    inheritedMsr: 'read',
    user: '0f3249ffc875f9',
    kernel: '480f07',
    perCycle: 3,
  },
  {
    name: 'inherited-efer-unchanged-wrmsr',
    kind: 'msr',
    inheritedMsr: 'write',
    user: '0f3049ffc875f9',
    kernel: '480f07',
    perCycle: 3,
  },
];
export const inheritedMsrNames = inheritedMsrRows.map((row) => row.name);
function image(row) {
  const ram = new Uint8Array(0x12000).fill(0xa5);
  ram.fill(0, 0x1000, 0x6000);
  for (const [at, value] of [
    [0x1000, 0x2027n],
    [0x2000, 0x3027n],
    [0x3010, 0x4027n],
    [0x5000, 0x2027n],
    ...[
      0x9067n,
      row.kind === 'pf' ? 0n : 0xa063n,
      0xb063n,
      0xc067n,
      0xd063n,
      0xe063n,
      0xf063n,
      0x10063n,
      0x4063n,
      0x11067n,
    ].map((v, i) => [0x4000 + i * 8, v]),
  ])
    put(ram, at, value);
  ram.fill(0x82, 0x9000, 0xc000);
  ram.set(hex(row.user), 0x9000);
  ram.set(hex(row.kernel), 0xa000);
  ram.set(hex('48b823a000000000000048bb08804000000000004889034883c40848cf'), 0xb000);
  // Long64 ring0 CS/SS, with already-accessed descriptors: event entry has no A-bit write.
  ram.fill(0, 0xf000, 0x11000);
  put(ram, 0xf008, 0x00af9b000000ffffn);
  put(ram, 0xf010, 0x00cf93000000ffffn);
  put(ram, 0x10000 + 14 * 16, HANDLER & 0xffffn, 2);
  put(ram, 0x10000 + 14 * 16 + 2, 8n, 2);
  ram[0x10000 + 14 * 16 + 5] = 0x8e;
  put(ram, 0x10000 + 14 * 16 + 6, HANDLER >> 16n, 2);
  put(ram, 0xe008, KERNEL_SP);
  put(ram, 0xe010, 0n);
  return ram;
}
function mappings(execute = true) {
  return [
    {
      base: 0n,
      offset: 0,
      length: 0xa000,
      permissions: { read: true, write: true, execute: true },
    },
    {
      base: 0xa000n,
      offset: 0xa000,
      length: 0x1000,
      permissions: { read: true, write: true, execute },
    },
    {
      base: 0xb000n,
      offset: 0xb000,
      length: 0x7000,
      permissions: { read: true, write: true, execute: true },
    },
  ].map((span) => ({ ...span, backing: 'ram' }));
}
function scalar(row, n) {
  const registers = Array.from({ length: 16 }, (_, i) => 0x11110000n + BigInt(i));
  registers[1] =
    row.kind === 'msr'
      ? row.inheritedMsr
        ? 0xc0000080n
        : 0xc0000082n
      : row.kind.startsWith('sysexit')
        ? USER_SP
        : 0x11110001n;
  registers[2] = row.kind.startsWith('sysexit') ? USER + 2n : 0x11110002n;
  registers[3] = row.kind === 'sysexit32' || row.kind === 'sysret32' ? BigInt(n) : registers[3];
  registers[4] = row.kind === 'msr' ? KERNEL_SP : USER_SP;
  registers[8] = row.kind === 'sysexit32' || row.kind === 'sysret32' ? registers[8] : BigInt(n);
  if (row.inheritedMsr) {
    registers[0] = 0xd00n;
    registers[2] = 0n;
  }
  return { registers, flags: 0x202n, rip: USER };
}
export function seedFastNumeric(cpu) {
  cpu.setXmmState(
    Array.from({ length: 16 }, (_, i) => (BigInt(i + 1) << 112n) | 0xfedcba9876543210n),
  );
  cpu.setMxcsr(0xffc5);
  cpu.setX87State({
    registers: Array.from({ length: 8 }, (_, i) => (BigInt(i + 1) << 64n) | 0x123456789abcdef0n),
    controlWord: 0x37e,
    statusWord: 0x8081,
    tagWord: 0xffff,
    instructionPointer: 0x1122334455667788n,
    dataPointer: 0x8877665544332211n,
    opcode: 0x5a5,
  });
  return stable([cpu.readXmmState(), cpu.readMxcsr(), cpu.readX87State()]);
}
function expected(row, initial) {
  const state = structuredClone(initial);
  state.rip = USER + BigInt(row.user.length / 2);
  state.flags = row.kind.startsWith('sysexit') ? 0x46n : 0x246n;
  if (row.kind === 'sysexit32' || row.kind === 'sysret32') state.registers[3] = 0n;
  else state.registers[8] = 0n;
  if (row.kind === 'msr') {
    state.registers[0] = row.inheritedMsr ? 0xd00n : KERNEL;
    state.registers[2] = 0n;
  } else if (!row.kind.startsWith('sysexit')) {
    state.registers[1] = USER + 2n;
    state.registers[11] = 0x202n;
  }
  if (row.kind === 'root') state.registers[0] = 0x1000n;
  if (row.cycles) {
    state.rip = USER + 2n;
    state.flags = 0x202n;
    state.registers[8] = 1n;
    if (row.kind === 'pf') {
      state.registers[0] = 0xa023n;
      state.registers[3] = 0x408008n;
    }
  }
  return {
    ...state,
    event: { kind: 'ready' },
    interrupts: { irq: null, nmiPending: false, nmiBlocked: false },
    interruptibility: { sti: false, ss: false },
  };
}

// Share the literal setup, not the old driver's source-writing sample rearm.
export function fastReuseFixture(name, iterations) {
  const row = rows.find((item) => item.name === name);
  if (!row || row.cycles || row.kind === 'root' || row.kind === 'msr')
    throw Error('not a source-preserving fast reuse fixture');
  const initial = scalar(row, iterations);
  return {
    row,
    ram: image(row),
    mappings: mappings(),
    context: context(row.kind),
    paging: { ...PAGING },
    fastSystem: { ...FAST },
    initial,
    expected: expected(row, initial),
  };
}

async function measureRows(
  side,
  selectedRows,
  { iterations = 101, samples = 7, workloads = fastNames } = {},
) {
  const definitions = [],
    results = [];
  for (const row of selectedRows.filter((item) => workloads.includes(item.name))) {
    const n = Math.min(iterations, row.kind === 'msr' ? 10001 : 101),
      bank = { ...PAGING, efer: row.inheritedMsr ? 0xd00n : PAGING.efer },
      ram = image(row),
      startContext = context(row.kind),
      limits = {
        maxInstructions: 128,
        maxSourceBytes: 2048,
        maxArtifactBytes: 262144,
        maxCachedArtifacts: 32,
        maxCachedBytes: 4194304,
        maxTranslationsPerRun: 8 * n + 32,
      },
      began = performance.now();
    const cpu = await side.createCpu({
      compiler: side.compiler,
      memoryModel: 'ia32e-paged',
      paging: bank,
      ...(row.inheritedMsr ? {} : { fastSystem: FAST }),
      memory: { backings: [{ id: 'ram', bytes: ram }], mappings: mappings(row.kind !== 'private') },
      memoryLimits: { maxBackings: 1, maxMappings: 3, maxBackingBytes: ram.length },
      context: startContext,
      entry: USER,
      limits,
    });
    const creationMs = performance.now() - began;
    try {
      const numericBefore = seedFastNumeric(cpu);
      if (row.debug)
        cpu.setDebugState({
          ...cpu.readDebugState(),
          addresses: [KERNEL + 0x800n, 0n, 0n, 0n],
          dr7: 0x401n,
        });
      const debug = cpu.readDebugState();
      definitions.push({
        name: row.name,
        iterations: n,
        instructions: row.perCycle * n,
        calls: row.resume ? row.perCycle * n : row.kind === 'private' ? 2 * n : row.cycles ? n : 1,
        work: n,
        workUnit:
          row.kind === 'msr'
            ? 'RDMSR/DEC/JNZ cycle'
            : row.cycles
              ? 'transfer/refusal/repair/return'
              : 'complete user/kernel round trip',
        currentOnly: !row.inheritedMsr,
        helperWork: {
          fastSystem: row.kind === 'msr' ? 0 : (row.kind === 'gs' ? 4 : 2) * n,
          pagingControl: row.kind === 'msr' ? n : row.kind === 'root' ? 2 * n : 0,
        },
        limits,
        debugProfile: row.debug ? 'enabled execution slot, no match' : 'disabled',
        timing:
          'elapsedMs sums awaited Cpu.run calls only. wallMs also includes per-cycle host context/scalar/PTE/mapping reset and output guards. CPU creation/numeric setup and initial sample setup are outside both. Context-changing transfers retire source owners; compilation/translation and native entries are reported, not presented as retained-transfer-artifact throughput.',
      });
      for (let sample = 0; sample < samples; sample++) {
        cpu.writePhysicalMemory(0n, ram);
        cpu.setContext(startContext);
        cpu.setPagingState(bank);
        if (!row.inheritedMsr) cpu.setFastSystemState(FAST);
        if (row.kind === 'private') cpu.setMappings(mappings(false));
        const initial = scalar(row, row.cycles ? 1 : n);
        cpu.setState(initial);
        let retired = 0n,
          attempts = 0n,
          calls = 0,
          elapsedMs = 0,
          result;
        const resources = {},
          timings = {},
          wall = performance.now();
        const run = async (options) => {
          const at = performance.now();
          result = await cpu.run(options);
          elapsedMs += performance.now() - at;
          calls++;
          retired += result.retired;
          attempts += result.deliveryAttempts ?? 0n;
          for (const [key, value] of Object.entries(result.resources))
            if (typeof value === 'number' && !key.startsWith('cached'))
              resources[key] = (resources[key] ?? 0) + value;
          for (const [key, value] of Object.entries(result.timings))
            timings[key] = (timings[key] ?? 0) + value;
          return result;
        };
        if (row.cycles) {
          for (let i = 0; i < n; i++) {
            cpu.setContext(startContext);
            cpu.setState(initial);
            if (row.kind === 'pf') {
              cpu.writePhysicalMemory(0x4008n, new Uint8Array(8));
              await run({ budget: 32n, stop: USER + 2n, eventDelivery: { budget: 1n } });
              equal(result.reason, 'stop', row.name + ' repaired return');
              equal(result.retired, 7n, row.name + ' seven committed instructions');
              equal(result.deliveryAttempts, 1n, row.name + ' one PF entry');
            } else {
              cpu.setMappings(mappings(false));
              await run({ budget: 2n });
              equal(result.reason, 'physical-memory-fault', row.name + ' private target refusal');
              equal(result.retired, 1n, row.name + ' transfer already retired');
              equal(
                result.physicalMemoryFault?.physicalAddress,
                0xa000n,
                row.name + ' destination physical source',
              );
              equal(
                result.physicalMemoryFault?.instructionPc,
                KERNEL,
                row.name + ' committed destination PC',
              );
              equal(result.state.rip, KERNEL, row.name + ' committed destination');
              equal(cpu.readContext().cpl, 0, row.name + ' committed kernel privilege');
              cpu.setMappings(mappings(true));
              await run({ budget: 1n });
              equal(result.reason, 'budget', row.name + ' one return, no entry replay');
              equal(result.retired, 1n, row.name + ' only SYSRET retires on resume');
            }
          }
        } else if (row.resume) {
          for (let i = 0; i < row.perCycle * n; i++) {
            await run({ budget: 1n });
            equal(result.reason, 'budget', row.name + ' each short quantum');
            equal(result.retired, 1n, row.name + ' one instruction per call');
          }
        } else {
          await run({ budget: BigInt(row.perCycle * n) });
          equal(result.reason, 'budget', row.name + ' final reason');
        }
        equal(retired, BigInt(row.perCycle * n), row.name + ' total retirement');
        equal(attempts, BigInt(row.kind === 'pf' ? n : 0), row.name + ' delivery attempts');
        equal(result.state, expected(row, initial), row.name + ' full scalar checkpoint');
        equal(cpu.readContext(), startContext, row.name + ' full returned context');
        if (!row.inheritedMsr) equal(cpu.readFastSystemState(), FAST, row.name + ' full fast bank');
        else if (typeof cpu.readFastSystemState === 'function')
          equal(
            cpu.readFastSystemState(),
            Object.fromEntries(Object.keys(FAST).map((name) => [name, 0n])),
            row.name + ' unused fast bank',
          );
        equal(
          cpu.readPagingState(),
          { ...bank, cr2: row.kind === 'pf' ? KERNEL : bank.cr2 },
          row.name + ' full paging bank',
        );
        equal(cpu.readDebugState(), debug, row.name + ' debug bank preserved');
        equal(
          cpu.readState().interrupts,
          { irq: null, nmiPending: false, nmiBlocked: false },
          row.name + ' intake preserved',
        );
        equal(
          stable([cpu.readXmmState(), cpu.readMxcsr(), cpu.readX87State()]),
          numericBefore,
          row.name + ' nonzero numeric banks preserved',
        );
        const memory = ram.slice();
        if (row.kind === 'gs') {
          put(memory, 0xe000, USER_SP);
          put(memory, 0xe010, BigInt(n));
          put(memory, 0xdfe8, initial.registers[0]);
        }
        if (row.kind === 'pf') {
          put(memory, 0x4008, 0xa023n);
          [16n, KERNEL, 8n, 0x10002n, USER_SP, 16n].forEach((v, i) =>
            put(memory, 0xcfc0 + i * 8, v),
          );
        }
        equal(
          cpu.readPhysicalMemory(0n, ram.length),
          memory,
          row.name + ' all RAM/code/tables guarded',
        );
        results.push({
          workload: row.name,
          side: side.label,
          sample,
          window: sample === 0 ? 'first' : sample < 4 ? 'early' : 'later',
          calls,
          retired,
          attempts,
          elapsedMs,
          wallMs: performance.now() - wall,
          creationMs,
          resources,
          timings,
          translations: cpu.inspectTranslations(),
        });
      }
    } finally {
      cpu.dispose();
    }
  }
  return { definitions, samples: results };
}

export async function measureFast(side, options) {
  return measureRows(side, rows, options);
}
export async function measureInheritedMsr(side, options = {}) {
  return measureRows(side, inheritedMsrRows, {
    ...options,
    workloads: options.workloads ?? inheritedMsrNames,
  });
}
