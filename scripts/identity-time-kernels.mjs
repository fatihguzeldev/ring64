const ENTRY = 0x1000n;
const INITIAL_TSC = 100n;
const AUX = 0x89abcdef;
const WRITE_TSC = 0xfffffffffffffff0n;
const WRITE_AUX = 0x1234abcd;
const MAX = 0xffffffffffffffffn;
const rows = [
  { name: 'ordinary-no-clock', op: 'ordinary' },
  ...['cpuid', 'rdtsc', 'rdtscp'].flatMap((op) => [
    { name: `${op}-batched`, op },
    { name: `${op}-sparse`, op, padding: 16 },
    { name: `${op}-short-resume`, op, resume: true },
    { name: `${op}-ia32e`, op, paged: true },
  ]),
  { name: 'tsc-msr-read', op: 'tsc-read', paged: true },
  { name: 'tsc-msr-write', op: 'tsc-write', paged: true },
  { name: 'aux-msr-read', op: 'aux-read', paged: true },
  { name: 'aux-msr-write', op: 'aux-write', paged: true },
  { name: 'tsc-msr-short-resume', op: 'tsc-read', paged: true, resume: true },
  { name: 'tsd-guest-toggle', op: 'tsd-toggle', paged: true },
  { name: 'tsd-set-cpl0-read', op: 'rdtsc', paged: true, tsd: true },
  { name: 'tsd-clear-cpl3-read', op: 'rdtsc', paged: true, cpl: 3 },
  { name: 'tsd-cpl3-refusal', op: 'rdtsc', paged: true, tsd: true, fault: true },
];
export const identityTimeNames = rows.map((row) => row.name);
const hex = (text) => Uint8Array.from(text.match(/../g) ?? [], (byte) => parseInt(byte, 16));
const encode = (value) =>
  JSON.stringify(value, (_, item) =>
    typeof item === 'bigint'
      ? item.toString(16)
      : item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
        : item,
  );
function equal(actual, expected, label) {
  if (ArrayBuffer.isView(actual) && ArrayBuffer.isView(expected)) {
    if (actual.length !== expected.length) throw Error(`${label}: byte lengths differ`);
    for (let i = 0; i < actual.length; i++)
      if (actual[i] !== expected[i]) throw Error(`${label}: byte${i} differs`);
  } else if (encode(actual) !== encode(expected))
    throw Error(`${label}: ${encode(actual)} != ${encode(expected)}`);
}
function context(cpl) {
  const segment = (selector, code = false) => ({
    selector: selector | cpl,
    base: 0n,
    limit: 0xffffffff,
    default32: !code,
    usable: true,
    type: code ? 'readable-code' : 'read-write',
    dpl: cpl,
    present: true,
    conforming: false,
    accessed: true,
    long: code,
    granularity: true,
    available: false,
  });
  const empty = { selector: 0, valid: false, base: 0n, limit: 0, attributes: 0 };
  return {
    mode: 'long64',
    cpl,
    segments: {
      cs: segment(8, true),
      ss: segment(16),
      ds: segment(16),
      es: segment(16),
      fs: segment(16),
      gs: segment(16),
    },
    gdtr: { base: 0n, limit: 0 },
    idtr: { base: 0n, limit: 0 },
    ldtr: { ...empty },
    tr: { ...empty },
  };
}
function program(row) {
  const bodies = {
    ordinary: '90',
    cpuid: 'b8000000000fa2',
    rdtsc: '0f31',
    rdtscp: '0f01f9',
    'tsc-read': '0f32',
    'tsc-write': '0f30',
    'aux-read': '0f32',
    'aux-write': '0f30',
    'tsd-toggle': '410f22e1410f22e20f31',
  };
  const body = '90'.repeat(row.padding ?? 0) + bodies[row.op];
  if (row.fault) return hex(body);
  const loop = body + '49ffc875'; // DEC R8; JNZ back to the body.
  return hex(loop + ((256 - (loop.length / 2 + 1)) & 255).toString(16).padStart(2, '0'));
}
function definition(row, knobs) {
  const n = Math.min(knobs.iterations, row.resume || row.fault ? 257 : 100001);
  const perCycle = row.fault
    ? 0
    : (row.padding ?? 0) + (row.op === 'cpuid' ? 4 : row.op === 'tsd-toggle' ? 5 : 3);
  const clockRead = ['rdtsc', 'rdtscp', 'tsc-read', 'tsd-toggle'].includes(row.op);
  return {
    ...row,
    iterations: n,
    requestedIterations: knobs.iterations,
    perCycle,
    retired: BigInt(n * perCycle),
    calls: row.fault ? n : row.resume ? n * perCycle : 1,
    work: n,
    workUnit: row.fault ? 'refused timestamp attempt' : 'complete guest loop cycle',
    memoryModel: row.paged ? 'ia32e-paged' : 'linear',
    profile: `long64/cpl${row.fault ? 3 : (row.cpl ?? 0)}`,
    guestImageBytes: row.paged ? 0x50000 : program(row).length + 64,
    code: program(row),
    clockReadAttempts: clockRead ? n : 0,
    clockReads: clockRead && !row.fault ? n : 0,
    nominalHelpers: {
      processor: ['cpuid', 'rdtsc', 'rdtscp', 'tsd-toggle'].includes(row.op) ? n : 0,
      pagingControl: row.op === 'tsd-toggle' ? 2 * n : row.op.includes('-') ? n : 0,
    },
    limits: {
      maxInstructions: 64,
      maxSourceBytes: 512,
      maxArtifactBytes: 131072,
      maxCachedArtifacts: 16,
      maxCachedBytes: 2097152,
      maxTranslationsPerRun: 64,
    },
  };
}
export function identityTimePlan(knobs) {
  for (const [key, max] of [
    ['iterations', 1000001],
    ['samples', 101],
  ])
    if (!Number.isSafeInteger(knobs[key]) || knobs[key] < 1 || knobs[key] > max)
      throw Error(`${key} outside allowed integer range`);
  if (
    !Array.isArray(knobs.workloads) ||
    !knobs.workloads.length ||
    new Set(knobs.workloads).size !== knobs.workloads.length ||
    knobs.workloads.some((name) => !identityTimeNames.includes(name))
  )
    throw Error('unknown, duplicate or empty workload selection');
  return rows
    .filter((row) => knobs.workloads.includes(row.name))
    .map((row) => definition(row, knobs));
}
function fixture(row, compiler) {
  const common = { compiler, context: context(row.fault ? 3 : (row.cpl ?? 0)), limits: row.limits };
  if (!row.paged)
    return {
      options: {
        ...common,
        code: { base: ENTRY, bytes: row.code },
        ram: { base: 0x8000n, bytes: new Uint8Array(64) },
      },
      memory: row.code,
      memoryBase: ENTRY,
      ram: new Uint8Array(64),
    };
  const memory = new Uint8Array(0x50000);
  memory.set(row.code, Number(ENTRY));
  const put = (at, value) => {
    for (let i = 0; i < 8; i++) memory[at + i] = Number((value >> BigInt(i * 8)) & 255n);
  };
  put(0x40000, 0x41027n);
  put(0x41000, 0x42027n);
  put(0x42000, 0x43027n);
  for (let i = 0; i < 80; i++) put(0x43000 + i * 8, BigInt(i * 4096) | 0x67n);
  const paging = {
    cr0: 0x80000033n,
    cr2: 0n,
    cr3: 0x40000n,
    cr4: row.tsd ? 0x62cn : 0x628n,
    efer: 0x500n,
  };
  return {
    memory,
    memoryBase: 0n,
    paging,
    options: {
      ...common,
      memoryModel: 'ia32e-paged',
      paging,
      entry: ENTRY,
      memory: {
        backings: [{ id: 'ram', bytes: memory }],
        mappings: [
          {
            base: 0n,
            backing: 'ram',
            offset: 0,
            length: memory.length,
            permissions: { read: true, write: true, execute: true },
          },
        ],
      },
      memoryLimits: { maxBackings: 1, maxMappings: 1, maxBackingBytes: memory.length },
    },
  };
}
function initial(cpu, row) {
  const state = cpu.readState();
  state.registers = Array.from({ length: 16 }, (_, i) => 0x1122334400000000n + BigInt(i));
  state.registers[4] = 0x9000n;
  state.registers[8] = BigInt(row.iterations);
  if (row.op.startsWith('tsc-')) state.registers[1] = 0x1122334400000010n;
  if (row.op.startsWith('aux-')) state.registers[1] = 0x11223344c0000103n;
  if (row.op === 'tsc-write') {
    state.registers[0] = 0x11223344fffffff0n;
    state.registers[2] = 0x55667788ffffffffn;
  }
  if (row.op === 'aux-write') {
    state.registers[0] = 0x112233441234abcdn;
    state.registers[2] = 0x5566778800000000n;
  }
  if (row.op === 'tsd-toggle') {
    state.registers[9] = 0x62cn;
    state.registers[10] = 0x628n;
  }
  state.flags = 0x202n;
  state.rip = ENTRY;
  state.interruptibility = { sti: false, ss: false };
  state.event = { kind: 'ready' };
  state.interrupts = { irq: null, nmiPending: false, nmiBlocked: false };
  return state;
}
function expected(row, state) {
  const scalar = structuredClone(state),
    r = scalar.registers;
  let tsc = (INITIAL_TSC + row.retired) & MAX,
    tscAux = AUX;
  if (!row.fault) {
    scalar.flags = 0x246n;
    scalar.rip = ENTRY + BigInt(row.code.length);
    r[8] = 0n;
    const sample =
      INITIAL_TSC +
      BigInt(
        (row.iterations - 1) * row.perCycle +
          (row.padding ?? 0) +
          (row.op === 'tsd-toggle' ? 2 : 0),
      );
    if (['rdtsc', 'rdtscp', 'tsc-read', 'tsd-toggle'].includes(row.op)) {
      r[0] = sample & 0xffffffffn;
      r[2] = sample >> 32n;
      if (row.op === 'rdtscp') r[1] = BigInt(AUX);
    }
    if (row.op === 'cpuid') [r[0], r[3], r[1], r[2]] = [1n, 0x676e6952n, 0x656e6967n, 0x6e453436n];
    if (row.op === 'aux-read') {
      r[0] = BigInt(AUX);
      r[2] = 0n;
    }
    if (row.op === 'aux-write') tscAux = WRITE_AUX;
    if (row.op === 'tsc-write') tsc = (WRITE_TSC + 2n) & MAX;
  }
  return { scalar, time: { tsc, tscAux } };
}
async function transport(compiler) {
  const api = (
    await WebAssembly.instantiate(compiler, {
      io: {
        read() {
          throw Error('unexpected layout-probe I/O');
        },
        write() {
          throw Error('unexpected layout-probe I/O');
        },
      },
    })
  ).exports;
  const pointer = api.core_input(2);
  new Uint8Array(api.memory.buffer, pointer, 2).set([0x90, 0]);
  if (api.core_init(ENTRY, 1, 0x8000n, 1) !== 0) throw Error('transport probe failed');
  const descriptor = JSON.parse(
    new TextDecoder().decode(
      new Uint8Array(api.memory.buffer, api.core_info_ptr(), api.core_info_len()),
    ),
  );
  api.core_dispose();
  return {
    stateBytes: descriptor.size,
    scalarBytes: descriptor.scalarSize,
    timeBank: descriptor.time,
    publicTimePayloadBytes: 12,
  };
}
const numeric = (cpu) => ({
  xmm: cpu.readXmmState(),
  mxcsr: cpu.readMxcsr(),
  x87: cpu.readX87State(),
});
export async function measureIdentityTime(side, knobs) {
  const definitions = identityTimePlan(knobs),
    samples = [],
    timing = !knobs.validateOnly;
  const layout = await transport(side.compiler);
  for (const row of definitions) {
    const f = fixture(row, side.compiler),
      createdAt = timing ? performance.now() : 0;
    const cpu = await side.createCpu(f.options);
    const creationMs = timing ? performance.now() - createdAt : undefined;
    try {
      cpu.setXmmState(Array.from({ length: 16 }, (_, i) => BigInt(i + 1) * 0x102030405060708n));
      cpu.setMxcsr(0x3f80);
      const fp = cpu.readX87State();
      fp.registers = Array.from({ length: 8 }, (_, i) => BigInt(i + 1));
      cpu.setX87State(fp);
      const numbers = numeric(cpu),
        debug = cpu.readDebugState(),
        originalContext = cpu.readContext();
      for (let sample = -1; sample < knobs.samples; sample++) {
        const state = initial(cpu, row),
          wanted = expected(row, state);
        cpu.setState(state);
        cpu.setTimeState({ tsc: INITIAL_TSC, tscAux: AUX });
        equal(
          cpu.readTimeState(),
          { tsc: INITIAL_TSC, tscAux: AUX },
          `${row.name} explicit initial time`,
        );
        const results = [],
          wallAt = timing ? performance.now() : 0;
        let elapsedMs = 0;
        for (let call = 0; call < row.calls; call++) {
          const at = timing ? performance.now() : 0;
          const result = await cpu.run({
            budget: row.fault || row.resume ? 1n : row.retired,
            repeatBudget: 0n,
          });
          if (timing) elapsedMs += performance.now() - at;
          results.push(result);
        }
        const wallMs = timing ? performance.now() - wallAt : undefined;
        const resources = {},
          timings = {};
        let retired = 0n;
        for (const result of results) {
          equal(result.reason, row.fault ? 'protection-fault' : 'budget', `${row.name} reason`);
          equal(
            result.retired,
            row.fault ? 0n : row.resume ? 1n : row.retired,
            `${row.name} call work`,
          );
          equal(result.remaining, row.fault ? 1n : 0n, `${row.name} remaining`);
          equal(result.repeatIterations, 0n, `${row.name} no repeat work`);
          if (row.fault)
            equal(
              result.protectionFault,
              { vector: 13, errorCode: 0, phase: 'privilege', instructionPc: ENTRY },
              `${row.name} exact TSD refusal`,
            );
          retired += result.retired;
          for (const key of [
            'compilations',
            'cacheHits',
            'nativeEntries',
            'dispatches',
            'generatedBytes',
            'pagingRestarts',
          ])
            if (result.resources[key] !== undefined)
              resources[key] = (resources[key] ?? 0) + result.resources[key];
          for (const [key, value] of Object.entries(result.timings))
            timings[key] = (timings[key] ?? 0) + value;
        }
        const last = results.at(-1),
          translations = cpu.inspectTranslations();
        equal(retired, row.retired, `${row.name} independently counted total instructions`);
        equal(last.state, wanted.scalar, `${row.name} full scalar/flags/event/interrupt state`);
        equal(cpu.readTimeState(), wanted.time, `${row.name} literal clock/AUX result`);
        equal(cpu.readContext(), originalContext, `${row.name} full context`);
        equal(numeric(cpu), numbers, `${row.name} numeric preservation`);
        equal(cpu.readDebugState(), debug, `${row.name} debug preservation`);
        equal(
          row.paged
            ? cpu.readPhysicalMemory(f.memoryBase, f.memory.length)
            : cpu.readMemory(f.memoryBase, f.memory.length),
          f.memory,
          `${row.name} source/tables memory`,
        );
        if (row.paged) equal(cpu.readPagingState(), f.paging, `${row.name} paging bank`);
        else equal(cpu.readMemory(0x8000n, 64), f.ram, `${row.name} all RAM`);
        equal(
          last.resources.cachedBytes,
          translations.reduce((sum, unit) => sum + unit.byteLength, 0),
          `${row.name} cache bytes`,
        );
        equal(last.resources.cachedArtifacts, translations.length, `${row.name} cache artifacts`);
        if (sample >= 0) equal(resources.compilations, 0, `${row.name} warm owner reuse`);
        samples.push({
          workload: row.name,
          sample,
          phase: sample < 0 ? 'first' : 'warm',
          ...(timing ? { ...(sample < 0 ? { creationMs } : {}), elapsedMs, wallMs, timings } : {}),
          calls: row.calls,
          retired,
          nominalHelpers: row.nominalHelpers,
          resources,
          finalGauge: last.resources,
          state: last.state,
          time: cpu.readTimeState(),
          translations,
        });
      }
    } finally {
      cpu.dispose();
    }
  }
  return {
    transport: layout,
    method: {
      timing: timing
        ? 'elapsedMs sums awaited Cpu.run only; wallMs also includes loop/timer/result retention. Initial bank/scalar/numeric setup and all output verification are outside both.'
        : 'validation only; no timing clock is sampled',
      phases:
        'One new owned CPU per workload and one creationMs observation on its first row. First invocation starts with empty translation cache; each warm sample resets full scalar state and TSC100/AUX89abcdef while preserving cached owners.',
      helperCounts:
        'Static nominal counts from authored operation forms, not instrumentation; excludes debug/boundary, fetch/page walks, compilation and snapshot crossings.',
      claims:
        'New behavior characterization only; no executable predecessor denominator, cycle/frequency calibration, p99 or application-throughput claim.',
    },
    definitions: definitions.map(({ code, ...row }) => ({ ...row, code: Array.from(code) })),
    samples,
  };
}
