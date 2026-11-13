const ENTRY = 0x1000n,
  DATA = 0x8000n,
  SUPERVISOR = 0x9000n,
  GDT = 0xa000n,
  AC = 0x40000n,
  SMEP = 0x100000n,
  SMAP = 0x200000n,
  DATA_WORD = 0x8877665544332211n,
  SUPERVISOR_WORD = 0x1020304050607080n,
  INITIAL_TSC = 100n,
  AUX = 0x89abcdef;
const rows = [
  { name: 'inactive-linear-load', kind: 'load' },
  { name: 'inactive-ia32e-load', kind: 'load', paged: true },
  { name: 'inactive-ia32e-store', kind: 'store', paged: true },
  { name: 'smep-ia32e-data-load', kind: 'load', paged: true, controls: SMEP },
  { name: 'smap-ac1-ia32e-user-load', kind: 'load', paged: true, controls: SMAP, ac: true },
  {
    name: 'smap-ac0-ia32e-supervisor-load',
    kind: 'load',
    paged: true,
    controls: SMAP,
    userData: false,
  },
  { name: 'stac-clac-ia32e-alternating', kind: 'alternating', paged: true, controls: SMEP | SMAP },
  {
    name: 'stac-clac-ia32e-short-resume',
    kind: 'alternating',
    paged: true,
    controls: SMEP | SMAP,
    resume: true,
  },
  {
    name: 'smap-ac1-implicit-denial',
    kind: 'implicit-denial',
    paged: true,
    controls: SMAP,
    ac: true,
  },
  {
    name: 'legacy-pae-smep-quartet-toggle',
    kind: 'pae-smep',
    paged: true,
    controls: SMEP,
    ac: true,
  },
  {
    name: 'legacy-pae-smap-no-quartet-toggle',
    kind: 'pae-smap',
    paged: true,
    controls: SMAP,
    ac: true,
  },
  { name: 'smap-ins-guest-pf-repair', kind: 'repair', paged: true, controls: SMAP },
];
export const supervisorAccessNames = rows.map((row) => row.name);
const hex = (text) => Uint8Array.from(text.match(/../g) ?? [], (byte) => parseInt(byte, 16));
const stable = (value) =>
  JSON.stringify(value, (_, item) =>
    typeof item === 'bigint'
      ? item.toString(16)
      : item && typeof item === 'object' && !Array.isArray(item) && !ArrayBuffer.isView(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
        : item,
  );
function equal(actual, expected, label) {
  if (ArrayBuffer.isView(actual) && ArrayBuffer.isView(expected)) {
    if (actual.length !== expected.length) throw Error(`${label}: byte lengths differ`);
    for (let i = 0; i < actual.length; i++)
      if (actual[i] !== expected[i]) throw Error(`${label}: byte${i} differs`);
  } else if (stable(actual) !== stable(expected))
    throw Error(`${label}: ${stable(actual)} != ${stable(expected)}`);
}
function put(bytes, offset, value) {
  for (let i = 0; i < 8; i++) bytes[offset + i] = Number((value >> BigInt(i * 8)) & 255n);
}
function program(row) {
  if (row.kind.startsWith('pae-')) return hex('0f22e20f22e0e2f8');
  if (row.kind === 'repair') return hex('f36c');
  if (row.kind === 'implicit-denial') return hex('8ed8'); // MOV DS,AX reads GDT metadata.
  const body =
    row.kind === 'alternating'
      ? '0f01cb488b030f01ca488b32'
      : row.kind === 'store'
        ? '488903'
        : '488b03';
  // LOOP preserves FLAGS and returns exactly to the first body instruction.
  const code = hex(body + 'e2' + (256 - (body.length / 2 + 2)).toString(16));
  equal(code.length + (code.at(-1) - 256), 0, `${row.name} loop target`);
  return code;
}
export function supervisorAccessPlan(knobs) {
  for (const [key, max] of [
    ['iterations', 100001],
    ['samples', 31],
  ])
    if (!Number.isSafeInteger(knobs[key]) || knobs[key] < 1 || knobs[key] > max)
      throw Error(`${key} outside allowed integer range`);
  if (
    !Array.isArray(knobs.workloads) ||
    !knobs.workloads.length ||
    new Set(knobs.workloads).size !== knobs.workloads.length ||
    knobs.workloads.some((name) => !supervisorAccessNames.includes(name))
  )
    throw Error('unknown, duplicate or empty workload selection');
  return rows
    .filter((row) => knobs.workloads.includes(row.name))
    .map((row) => {
      const fault = row.kind === 'implicit-denial',
        control = row.kind.startsWith('pae-'),
        repair = row.kind === 'repair',
        n = Math.min(knobs.iterations, control || repair ? 31 : row.resume || fault ? 257 : 100001),
        perCycle = fault ? 0 : control ? 3 : repair ? 8 : row.kind === 'alternating' ? 5 : 2,
        code = program(row),
        retired = BigInt(n * perCycle),
        calls = fault || repair ? n : row.resume || control ? n * perCycle : 1;
      equal(
        retired,
        fault ? 0n : BigInt(row.resume || control ? calls : n * perCycle),
        `${row.name} work ledger`,
      );
      return {
        ...row,
        controls: row.controls ?? 0n,
        fault,
        code,
        iterations: n,
        requestedIterations: knobs.iterations,
        perCycle,
        retired,
        calls,
        work: n,
        workUnit: fault
          ? 'refused implicit descriptor attempt'
          : repair
            ? 'fault entry repair IRETD and completed REP cycle'
            : control
              ? 'set clear CR4 pair and LOOP cycle'
              : 'complete guest loop cycle',
        predecessorComparable: !row.controls && row.kind !== 'alternating',
        userData: control ? false : (row.userData ?? true),
        memoryModel: control || repair ? 'physical' : row.paged ? 'ia32e-paged' : 'linear',
        profile: control
          ? 'protected32/cpl0/legacyPAE'
          : repair
            ? 'protected32/cpl0/nonPAE'
            : 'long64/cpl0',
        guestImageBytes: control || repair ? 0x30000 : row.paged ? 0x20000 : code.length + 0x2000,
        ...(control || repair
          ? {
              capReason:
                'bounded control-fence or guest-entry characterization; no unbounded translation/handler loop',
            }
          : {}),
        nominalHelpers: {
          flags: row.kind === 'alternating' ? 2 * n : 0,
          ...(repair
            ? { ordinaryStackInstructions: 2 * n, stringMemoryAttempts: 3 * n }
            : { explicitMemory: fault || control ? 0 : row.kind === 'alternating' ? 2 * n : n }),
          ...(!repair ? { implicitMetadata: fault ? n : 0 } : {}),
          ...(control
            ? { cr4Writes: 2 * n, quartetCaptures: row.kind === 'pae-smep' ? 2 * n : 0 }
            : {}),
          ...(repair
            ? {
                cr4Writes: n,
                providerReads: 3 * n,
                completedRepElements: 2 * n,
                automaticEntries: n,
              }
            : {}),
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
    });
}
function fixture(row, compiler) {
  if (!row.paged) {
    const ram = new Uint8Array(0x2000).fill(0xa5);
    put(ram, 0, DATA_WORD);
    put(ram, 0x1000, SUPERVISOR_WORD);
    return {
      memory: row.code,
      memoryBase: ENTRY,
      ram,
      options: {
        compiler,
        code: { base: ENTRY, bytes: row.code },
        ram: { base: DATA, bytes: ram },
        limits: row.limits,
      },
    };
  }
  const memory = new Uint8Array(0x20000);
  memory.set(row.code, Number(ENTRY));
  put(memory, Number(DATA), DATA_WORD);
  put(memory, Number(SUPERVISOR), SUPERVISOR_WORD);
  put(memory, Number(GDT) + 16, 0x00cf93000000ffffn);
  for (const [at, value] of [
    [0x10000, 0x11027n],
    [0x11000, 0x12027n],
    [0x12000, 0x13027n],
  ])
    put(memory, at, value);
  for (let i = 0; i < 32; i++) put(memory, 0x13000 + i * 8, BigInt(i * 4096) | 0x63n);
  if (row.userData) put(memory, 0x13040, DATA | 0x67n);
  put(memory, 0x13050, GDT | 0x67n);
  const paging = {
    cr0: 0x80010033n,
    cr2: 0xdeadn,
    cr3: 0x10000n,
    cr4: 0x628n | row.controls,
    efer: 0x500n,
  };
  return {
    memory,
    memoryBase: 0n,
    paging,
    options: {
      compiler,
      memoryModel: 'ia32e-paged',
      paging,
      entry: ENTRY,
      limits: row.limits,
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
  state.registers[1] = BigInt(row.iterations);
  state.registers[2] = SUPERVISOR;
  state.registers[3] = DATA;
  state.registers[4] = 0x9ff0n;
  if (row.fault) state.registers[0] = 0x10n;
  state.flags = 0x202n | (row.ac ? AC : 0n);
  state.rip = ENTRY;
  state.interruptibility = { sti: false, ss: false };
  state.event = { kind: 'ready' };
  state.interrupts = { irq: null, nmiPending: false, nmiBlocked: false };
  return state;
}
function expected(row, state, setup) {
  const scalar = structuredClone(state),
    memory = setup.memory.slice(),
    ram = setup.ram?.slice();
  if (!row.fault) {
    scalar.registers[1] = 0n;
    scalar.rip = ENTRY + BigInt(row.code.length);
    if (row.kind !== 'store') scalar.registers[0] = DATA_WORD;
    if (row.kind === 'alternating') scalar.registers[6] = SUPERVISOR_WORD;
    if (row.kind === 'store')
      put(row.paged ? memory : ram, row.paged ? Number(DATA) : 0, state.registers[0]);
  }
  return {
    scalar,
    memory,
    ram,
    paging: row.paged
      ? { ...setup.paging, cr2: row.fault ? GDT + 16n : setup.paging.cr2 }
      : undefined,
  };
}
const numeric = (cpu) => ({
  xmm: cpu.readXmmState(),
  mxcsr: cpu.readMxcsr(),
  x87: cpu.readX87State(),
});

function physicalFixture(row, compiler) {
  const control = row.kind.startsWith('pae-'),
    memory = new Uint8Array(0x30000),
    code = row.code;
  memory.set(code, Number(ENTRY));
  if (control) {
    put(memory, 0x10000, 0x20001n);
    put(memory, 0x10008, 0x22001n);
    put(memory, 0x20000, 0x21027n);
    for (let i = 0; i < 32; i++) put(memory, 0x21000 + i * 8, BigInt(i * 4096) | 0x63n);
  } else {
    // All A/D bits start set; the measurement isolates the entry/repair contract, not first walks.
    for (let i = 0; i < 32; i++) {
      const value = BigInt(i * 4096) | (i === 8 ? 0x67n : 0x63n);
      for (let byte = 0; byte < 4; byte++)
        memory[0x11000 + i * 4 + byte] = Number((value >> BigInt(byte * 8)) & 255n);
    }
    const pde = 0x11027n;
    for (let byte = 0; byte < 4; byte++)
      memory[0x10000 + byte] = Number((pde >> BigInt(byte * 8)) & 255n);
    memory.set(hex('500f20e025ffffdfff0f22e05883c404cf'), 0x4000);
    put(memory, Number(GDT) + 8, 0x00cf9b000000ffffn);
    put(memory, Number(GDT) + 16, 0x00cf93000000ffffn);
    memory.set(hex('00400800008e0000'), 0xb000 + 14 * 8);
    put(memory, Number(DATA), DATA_WORD);
  }
  const paging = {
    cr0: 0x80010033n,
    cr2: 0xdeadn,
    cr3: 0x10000n,
    cr4: control ? 0x628n : 0x608n | SMAP,
    efer: 0n,
    ...(control ? { pdpte: [0x20001n, 0n, 0n, 0n] } : {}),
  };
  const provider = [];
  const segment = (selector, code = false) => ({
    selector,
    base: 0n,
    limit: 0xffffffff,
    default32: true,
    usable: true,
    type: code ? 'readable-code' : 'read-write',
    dpl: 0,
    present: true,
    conforming: false,
    accessed: true,
    long: false,
    granularity: true,
    available: false,
  });
  const context = {
    mode: 'protected',
    cpl: 0,
    segments: {
      cs: segment(8, true),
      ss: segment(16),
      ds: segment(24),
      es: segment(24),
      fs: segment(24),
      gs: segment(24),
    },
    gdtr: { base: control ? 0n : GDT, limit: control ? 0 : 31 },
    idtr: { base: control ? 0n : 0xb000n, limit: control ? 0 : 0x77 },
    ldtr: { selector: 0, valid: false, base: 0n, limit: 0, attributes: 0 },
    tr: { selector: 0, valid: false, base: 0n, limit: 0, attributes: 0 },
  };
  return {
    memory,
    paging,
    provider,
    options: {
      compiler,
      memoryModel: 'physical',
      context,
      paging,
      entry: ENTRY,
      limits: row.limits,
      memoryLimits: { maxBackings: 1, maxMappings: 1, maxBackingBytes: memory.length },
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
      ...(!control
        ? {
            io: {
              read(port, width) {
                const value = [0x11, 0x22, 0x33][provider.length % 3];
                provider.push([port, width, value]);
                return value;
              },
              write() {
                throw Error('repair INS must not output');
              },
            },
          }
        : {}),
    },
  };
}

async function measurePhysicalControls(side, row, knobs) {
  const setup = physicalFixture(row, side.compiler),
    control = row.kind.startsWith('pae-'),
    timing = !knobs.validateOnly,
    createdAt = timing ? performance.now() : 0,
    cpu = await side.createCpu(setup.options),
    creationMs = timing ? performance.now() - createdAt : undefined,
    samples = [];
  try {
    if (!control) {
      const context = cpu.readContext();
      context.gdtr = { base: GDT, limit: 31 };
      context.idtr = { base: 0xb000n, limit: 0x77 };
      cpu.setContext(context);
    }
    cpu.setXmmState(Array.from({ length: 16 }, (_, i) => BigInt(i + 1) * 0x102030405060708n));
    cpu.setMxcsr(0x3f80);
    const numbers = numeric(cpu),
      debug = cpu.readDebugState(),
      context = cpu.readContext();
    for (let sample = -1; sample < knobs.samples; sample++) {
      setup.provider.length = 0;
      const before = initial(cpu, { ...row, ac: control }),
        wanted = structuredClone(before),
        expectedRam = setup.memory.slice();
      if (control) {
        before.registers[0] = 0x1122334400000628n;
        before.registers[2] = 0x1122334400000628n | row.controls;
        wanted.registers = before.registers.slice();
        wanted.registers[1] = 0n;
        wanted.rip = ENTRY + 8n;
      } else {
        before.registers[0] = 0x11223344cafebaben;
        before.registers[1] = 2n;
        before.registers[2] = 0x80n;
        before.registers[7] = DATA;
        wanted.registers = before.registers.slice();
        wanted.registers[1] = 0n;
        wanted.registers[7] = DATA + 2n;
        wanted.rip = ENTRY + 2n;
        expectedRam[Number(DATA)] = 0x22;
        expectedRam[Number(DATA) + 1] = 0x33;
        // Four-dword protected PF frame and the handler's saved EAX word.
        for (const [at, value] of [
          [0x9fe0, 3n],
          [0x9fe4, ENTRY],
          [0x9fe8, 8n],
          [0x9fec, 0x10202n],
          [0x9fdc, before.registers[0]],
        ])
          for (let byte = 0; byte < 4; byte++)
            expectedRam[at + byte] = Number((value >> BigInt(byte * 8)) & 255n);
      }
      cpu.setState(before);
      cpu.setTimeState({ tsc: INITIAL_TSC, tscAux: AUX });
      const resources = {},
        timings = {},
        results = [];
      let elapsedMs = 0,
        retired = 0n,
        elements = 0n,
        attempts = 0n;
      const wallAt = timing ? performance.now() : 0;
      for (let call = 0; call < row.calls; call++) {
        if (!control) {
          cpu.setPagingState(setup.paging);
          cpu.setState(before);
          const reset = new Uint8Array(8);
          put(reset, 0, DATA_WORD);
          cpu.writePhysicalMemory(DATA, reset);
        }
        const at = timing ? performance.now() : 0;
        const result = await cpu.run(
          control
            ? { budget: 1n, repeatBudget: 0n }
            : { budget: 8n, repeatBudget: 2n, eventDelivery: { budget: 1n } },
        );
        if (timing) elapsedMs += performance.now() - at;
        results.push(result);
      }
      const wallMs = timing ? performance.now() - wallAt : undefined;
      for (const result of results) {
        equal(result.reason, 'budget', `${row.name} completed instruction allowance`);
        equal(result.retired, control ? 1n : 8n, `${row.name} call retirement`);
        equal(result.remaining, 0n, `${row.name} call remaining`);
        equal(
          result.repeatIterations,
          control ? 0n : 2n,
          `${row.name} exact completed REP elements`,
        );
        equal(result.deliveryAttempts ?? 0n, control ? 0n : 1n, `${row.name} exact guest entries`);
        retired += result.retired;
        elements += result.repeatIterations;
        attempts += result.deliveryAttempts ?? 0n;
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
      equal(retired, row.retired, `${row.name} total retired ledger`);
      equal(
        elements,
        control ? 0n : BigInt(row.iterations * 2),
        `${row.name} total element ledger`,
      );
      equal(attempts, control ? 0n : BigInt(row.iterations), `${row.name} total entry ledger`);
      equal(last.state, wanted, `${row.name} full scalar`);
      equal(
        cpu.readTimeState(),
        { tsc: INITIAL_TSC + row.retired, tscAux: AUX },
        `${row.name} exact time`,
      );
      equal(
        cpu.readPagingState(),
        control
          ? { ...setup.paging, pdpte: [0x20001n, row.kind === 'pae-smep' ? 0x22001n : 0n, 0n, 0n] }
          : { ...setup.paging, cr4: 0x608n, cr2: DATA },
        `${row.name} complete controls and captured quartet`,
      );
      equal(cpu.readContext(), context, `${row.name} full context`);
      equal(numeric(cpu), numbers, `${row.name} all numeric banks`);
      equal(cpu.readDebugState(), debug, `${row.name} debug bank`);
      equal(
        cpu.readPhysicalMemory(0n, setup.memory.length),
        expectedRam,
        `${row.name} complete source tables frame and payload`,
      );
      if (control)
        equal(
          resources.nativeEntries,
          row.calls,
          `${row.name} one reached native entry per instruction`,
        );
      else
        equal(
          setup.provider,
          Array.from({ length: row.iterations * 3 }, (_, i) => [
            0x80,
            8,
            [0x11, 0x22, 0x33][i % 3],
          ]),
          `${row.name} actual consumed input sequence`,
        );
      equal(last.resources.cachedArtifacts, translations.length, `${row.name} cache artifacts`);
      equal(
        last.resources.cachedBytes,
        translations.reduce((sum, unit) => sum + unit.byteLength, 0),
        `${row.name} cache bytes`,
      );
      samples.push({
        workload: row.name,
        sample,
        phase:
          sample < 0
            ? 'first'
            : control
              ? 'retained-control-cycle'
              : 'repeated-repair-control-reset',
        ...(timing ? { ...(sample < 0 ? { creationMs } : {}), elapsedMs, wallMs, timings } : {}),
        calls: row.calls,
        retired,
        repeatIterations: elements,
        deliveryAttempts: attempts,
        providerReads: setup.provider.length,
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
  return samples;
}

export async function measureSupervisorAccess(side, knobs) {
  const definitions = supervisorAccessPlan(knobs),
    samples = [],
    timing = !knobs.validateOnly;
  for (const row of definitions) {
    if (row.kind.startsWith('pae-') || row.kind === 'repair') {
      samples.push(...(await measurePhysicalControls(side, row, knobs)));
      continue;
    }
    const setup = fixture(row, side.compiler),
      createdAt = timing ? performance.now() : 0,
      cpu = await side.createCpu(setup.options),
      creationMs = timing ? performance.now() - createdAt : undefined;
    try {
      if (row.fault) {
        const c = cpu.readContext();
        c.gdtr = { base: GDT, limit: 31 };
        cpu.setContext(c);
      }
      cpu.setXmmState(Array.from({ length: 16 }, (_, i) => BigInt(i + 1) * 0x102030405060708n));
      cpu.setMxcsr(0x3f80);
      const fp = cpu.readX87State();
      fp.registers = Array.from({ length: 8 }, (_, i) => BigInt(i + 1));
      cpu.setX87State(fp);
      const numbers = numeric(cpu),
        debug = cpu.readDebugState(),
        context = cpu.readContext();
      for (let sample = -1; sample < knobs.samples; sample++) {
        if (row.kind === 'store') {
          const bytes = new Uint8Array(8);
          put(bytes, 0, DATA_WORD);
          if (row.paged) cpu.writePhysicalMemory(DATA, bytes);
          else cpu.writeMemory(DATA, bytes);
        }
        const state = initial(cpu, row),
          wanted = expected(row, state, setup);
        cpu.setState(state);
        cpu.setTimeState({ tsc: INITIAL_TSC, tscAux: AUX });
        equal(cpu.readTimeState(), { tsc: INITIAL_TSC, tscAux: AUX }, `${row.name} initial time`);
        const results = [],
          wallAt = timing ? performance.now() : 0;
        let elapsedMs = 0;
        for (let call = 0; call < row.calls; call++) {
          const at = timing ? performance.now() : 0;
          results.push(
            await cpu.run({ budget: row.fault || row.resume ? 1n : row.retired, repeatBudget: 0n }),
          );
          if (timing) elapsedMs += performance.now() - at;
        }
        const wallMs = timing ? performance.now() - wallAt : undefined,
          resources = {},
          timings = {};
        let retired = 0n,
          faultAttempts = 0;
        for (const result of results) {
          equal(result.reason, row.fault ? 'page-fault' : 'budget', `${row.name} reason`);
          equal(
            result.retired,
            row.fault ? 0n : row.resume ? 1n : row.retired,
            `${row.name} call retirement`,
          );
          equal(result.remaining, row.fault ? 1n : 0n, `${row.name} remaining`);
          equal(result.repeatIterations, 0n, `${row.name} no repeat`);
          equal(result.deliveryAttempts ?? 0n, 0n, `${row.name} no automatic delivery`);
          if (row.fault) {
            equal(
              result.pageFault,
              {
                instructionPc: ENTRY,
                vector: 14,
                address: GDT + 16n,
                access: 'read',
                errorCode: 1,
                table: 'gdt',
                systemPhase: 'descriptor-read',
                selector: 16,
              },
              `${row.name} implicit denial`,
            );
            faultAttempts++;
          }
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
        equal(retired, row.retired, `${row.name} total retirement`);
        equal(faultAttempts, row.fault ? row.iterations : 0, `${row.name} actual fault returns`);
        equal(last.state, wanted.scalar, `${row.name} complete scalar state`);
        equal(
          cpu.readTimeState(),
          { tsc: INITIAL_TSC + row.retired, tscAux: AUX },
          `${row.name} exact ticks`,
        );
        equal(cpu.readContext(), context, `${row.name} full context`);
        equal(numeric(cpu), numbers, `${row.name} numeric preservation`);
        equal(cpu.readDebugState(), debug, `${row.name} debug preservation`);
        equal(
          row.paged
            ? cpu.readPhysicalMemory(setup.memoryBase, setup.memory.length)
            : cpu.readMemory(setup.memoryBase, setup.memory.length),
          wanted.memory,
          `${row.name} full source/tables/payload image`,
        );
        if (row.paged) equal(cpu.readPagingState(), wanted.paging, `${row.name} paging bank`);
        else equal(cpu.readMemory(DATA, setup.ram.length), wanted.ram, `${row.name} complete RAM`);
        equal(resources.nativeEntries, row.calls, `${row.name} measured native entries`);
        equal(resources.dispatches, 0, `${row.name} no host redispatch`);
        equal(resources.pagingRestarts ?? 0, 0, `${row.name} no fetch restart`);
        equal(resources.compilations, sample < 0 ? 1 : 0, `${row.name} cold/warm compilation`);
        equal(last.resources.cachedArtifacts, translations.length, `${row.name} cache artifacts`);
        equal(
          last.resources.cachedBytes,
          translations.reduce((sum, unit) => sum + unit.byteLength, 0),
          `${row.name} cache bytes`,
        );
        samples.push({
          workload: row.name,
          sample,
          phase: sample < 0 ? 'first' : 'warm',
          ...(timing ? { ...(sample < 0 ? { creationMs } : {}), elapsedMs, wallMs, timings } : {}),
          calls: row.calls,
          retired,
          faultAttempts,
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
    method: {
      timing: timing
        ? 'elapsedMs sums awaited Cpu.run including host instrumentation, compilation and result snapshots; wallMs also includes loop/timer overhead. Per-sample setup and all output guards are outside both. Repair inter-call control/scalar/payload reset is outside elapsedMs but inside wallMs.'
        : 'Validation only; no characterization timers are sampled or recorded. Ordinary Cpu.run internal instrumentation remains active.',
      phases:
        'One CPU per workload; first sample-1 starts empty. Ordinary warm samples reuse owners; PAE toggle samples retain the resulting control-cycle state, with changed controls fencing owners during execution. Repair samples reset SMAP/CR2, source scalar and payload outside each timed run, deliberately fencing owners each cycle; those are repeated repair samples, not warmed-owner throughput. All samples reset TSC100/AUX89abcdef. A/D are preset; no isolated walk or cold-A/D cost claim. For repair rows elapsedMs excludes inter-call host reset while wallMs includes it.',
      counts:
        'nativeEntries/dispatches/compilations are actual returned resources; faultAttempts counts exact validated page-fault returns. nominalHelpers are authored static semantic operation counts, excluding fetch, debug and snapshots; quartetCaptures is the declared CR4 trigger count, not physical-read instrumentation. Repair memory traffic is identified by ordinaryStackInstructions and stringMemoryAttempts, without pretending to count individual event-frame reads/writes.',
      claims:
        'Current-only characterization. New controls/instructions have no predecessor denominator. Inactive rows use literal contracts supported by the predecessor, but this driver emits no comparison ratio. No native-cycle, p99, frequency or application-throughput claim.',
    },
    definitions: definitions.map(({ code, ...row }) => ({ ...row, code: Array.from(code) })),
    samples,
  };
}
