const CODE = 0x400000n,
  DATA = 0x500000n,
  HANDLER = 0x401000n,
  STACK = 0x405000n;
const BANK = { cr0: 0x80010033n, cr2: 0n, cr3: 0x1000n, cr4: 0x628n, efer: 0xd00n };
const LIMITS = {
  maxInstructions: 128,
  maxSourceBytes: 2048,
  maxArtifactBytes: 262144,
  maxCachedArtifacts: 32,
  maxCachedBytes: 4194304,
  maxTranslationsPerRun: 32,
};
const hex = (text) => Uint8Array.from(text.match(/../g) ?? [], (value) => parseInt(value, 16));
const stable = (value) =>
  JSON.stringify(value, (_, item) =>
    typeof item === 'bigint'
      ? item.toString()
      : item && typeof item === 'object' && !Array.isArray(item) && !ArrayBuffer.isView(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
        : item,
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
const rows = [
  ...['4k', '2m', '1g'].map((size) => ({
    name: `paging-${size}-warm-load`,
    size,
    kind: 'load',
    body: '488b03',
  })),
  {
    name: 'paging-4k-identity-warm-load',
    size: '4k',
    identity: true,
    kind: 'load',
    body: '488b03',
  },
  { name: 'paging-4k-cold-a-load', size: '4k', cold: true, kind: 'load', body: '488b03' },
  { name: 'paging-4k-warm-store', size: '4k', kind: 'store', body: '488903' },
  { name: 'paging-4k-cold-ad-store', size: '4k', cold: true, kind: 'store', body: '488903' },
  { name: 'paging-4k-crosspage-load', size: '4k', kind: 'load', cross: true, body: '488b03' },
  { name: 'paging-4k-crosspage-store', size: '4k', kind: 'store', cross: true, body: '488903' },
  { name: 'paging-4k-cr3-reload', size: '4k', kind: 'root', body: '0f22d8' },
  {
    name: 'paging-4k-root-switch',
    size: '4k',
    kind: 'root-switch',
    body: '48b800500000000000000f22d848b800100000000000000f22d8',
  },
  { name: 'paging-4k-invlpg', size: '4k', kind: 'invlpg', body: '0f013b' },
  { name: 'paging-4k-budget-one-resume', size: '4k', kind: 'load', resume: true, body: '488b03' },
  { name: 'paging-pf-report', size: '4k', kind: 'pf', body: '488b03', cycles: true },
  { name: 'paging-physical-refusal', size: '4k', kind: 'private', body: '488b03', cycles: true },
  {
    name: 'paging-physical-repair-resume',
    size: '4k',
    kind: 'private-repair',
    body: '488b03',
    cycles: true,
  },
  { name: 'paging-pf-guest-repair', size: '4k', kind: 'repair', body: '488b03', cycles: true },
  { name: 'paging-software-entry-iret', size: '4k', kind: 'software', body: 'cd30' },
  { name: 'paging-leaf-warm-store', size: '4k', kind: 'leaf-store', body: '488903', cycles: true },
  {
    name: 'paging-leaf-cold-ad-store',
    size: '4k',
    kind: 'leaf-store',
    body: '488903',
    cycles: true,
    coldLeaf: true,
  },
];
export const pagingNames = rows.map((row) => row.name);

function image(row) {
  const code = new Uint8Array(4096).fill(0x82);
  code.set(hex(row.body));
  if (!row.cycles) code.set([0xe2, 256 - (row.body.length / 2 + 2)], row.body.length / 2);
  const data = new Uint8Array(4096).fill(0xa5),
    second = new Uint8Array(4096).fill(0x5a);
  if (!row.cross) put(data, 0, 0x8877665544332211n);
  else {
    data.set([0x11, 0x22, 0x33, 0x44], 4092);
    second.set([0x55, 0x66, 0x77, 0x88]);
  }
  const handler = new Uint8Array(4096).fill(0x82);
  handler.set(
    hex(
      row.kind === 'repair'
        ? '410f20d248b807a000000000000048b900584000000000004889010f013b4883c40848cf'
        : '48cf',
    ),
  );
  const gdt = new Uint8Array(4096);
  put(gdt, 8, 0x00af9b000000ffffn);
  put(gdt, 16, 0x00cf93000000ffffn);
  const idt = new Uint8Array(4096);
  for (const vector of [14, 0x30]) {
    put(idt, vector * 16, HANDLER & 0xffffn, 2);
    put(idt, vector * 16 + 2, 8n, 2);
    idt[vector * 16 + 5] = 0x8e;
    put(idt, vector * 16 + 6, HANDLER >> 16n, 2);
  }
  const stack = new Uint8Array(4096).fill(0xa5),
    tables = new Uint8Array(row.kind === 'root-switch' ? 0x5000 : 0x4000);
  const entries =
    row.size === '4k'
      ? [
          [0x1000n, 0x2007n],
          [0x2000n, 0x3007n],
          [0x3010n, 0x4007n],
          [0x4000n, row.identity ? 0x400007n : 0x9007n],
          [0x4008n, 0xb007n],
          [0x4010n, 0xe007n],
          [0x4018n, 0xf007n],
          [0x4020n, 0xd007n],
          [0x4028n, 0x4007n],
          [
            0x4800n,
            row.kind === 'pf' || row.kind === 'repair' ? 0n : row.identity ? 0x500007n : 0xa007n,
          ],
          [0x4808n, 0xc007n],
        ]
      : row.size === '2m'
        ? [
            [0x1000n, 0x2007n],
            [0x2000n, 0x3007n],
            [0x3010n, 0x400087n],
          ]
        : [
            [0x1000n, 0x2007n],
            [0x2000n, 0x87n],
          ];
  if (row.kind === 'root-switch') entries.push([0x5000n, 0x2007n]);
  for (const [address, value] of entries)
    put(
      tables,
      Number(address - 0x1000n),
      value |
        (!row.cold && value ? 0x20n : 0n) |
        (!row.cold && value && row.kind === 'store' && (address === 0x4800n || address === 0x4808n)
          ? 0x40n
          : 0n),
    );
  const physical = (va, small) => (row.size === '4k' && !row.identity ? small : va);
  const spans = [
    { name: 'tables', base: 0x1000n, bytes: tables, execute: false },
    { name: 'code', base: physical(CODE, 0x9000n), bytes: code, execute: true },
    {
      name: 'data',
      base: physical(DATA, 0xa000n),
      bytes: data,
      read: !row.kind.startsWith('private'),
    },
    { name: 'second', base: physical(DATA + 4096n, 0xc000n), bytes: second },
    { name: 'handler', base: physical(HANDLER, 0xb000n), bytes: handler, execute: true },
    { name: 'gdt', base: physical(0x402000n, 0xe000n), bytes: gdt },
    { name: 'idt', base: physical(0x403000n, 0xf000n), bytes: idt },
    { name: 'stack', base: physical(0x404000n, 0xd000n), bytes: stack },
  ];
  return { spans, entries, physical };
}
function mappings(spans, privateReadable = false) {
  return spans.map((span) => ({
    base: span.base,
    backing: span.name,
    offset: 0,
    length: span.bytes.length,
    permissions: {
      read: privateReadable || span.read !== false,
      write: true,
      execute: span.execute ?? false,
    },
  }));
}
function state(row, n) {
  const registers = Array.from({ length: 16 }, (_, i) => 0x11110000n + BigInt(i));
  registers[0] = row.kind.startsWith('root') ? 0x1000n : 0x1020304050607080n;
  registers[1] = BigInt(n);
  registers[3] = DATA + (row.cross ? 4092n : 0n);
  registers[4] = STACK;
  return { registers, rip: CODE, flags: 0x202n };
}
function numeric(cpu) {
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
function expectedMemory(row, setup, before) {
  const expected = new Map(setup.spans.map((span) => [span.name, span.bytes.slice()]));
  const tables = expected.get('tables');
  if (row.cold)
    for (const address of [0x1000n, 0x2000n, 0x3010n, 0x4000n, 0x4800n]) {
      const original = setup.entries.find(([at]) => at === address)[1];
      put(
        tables,
        Number(address - 0x1000n),
        original | 0x20n | (row.kind === 'store' && address === 0x4800n ? 0x40n : 0n),
      );
    }
  if (row.kind === 'store' || row.kind === 'leaf-store') {
    const bytes = new Uint8Array(8);
    put(bytes, 0, before.registers[0]);
    if (row.cross) {
      expected.get('data').set(bytes.subarray(0, 4), 4092);
      expected.get('second').set(bytes.subarray(4), 0);
    } else expected.get('data').set(bytes);
  }
  if (row.kind === 'leaf-store') put(tables, 0x3800, 0xa067n);
  if (row.kind === 'repair' || row.kind === 'software') {
    // Every event uses the same six qword/error slots; subsequent cycles overwrite them.
    const stack = expected.get('stack'),
      offset = row.kind === 'repair' ? 0xfd0 : 0xfd8;
    const words =
      row.kind === 'repair'
        ? [0n, CODE, 8n, 0x10202n, STACK, 16n]
        : [CODE + 2n, 8n, 0x202n, STACK, 16n];
    words.forEach((word, i) => put(stack, offset + i * 8, word));
    put(tables, 0x3020, 0xd067n); // frame payload selects stack D.
  }
  if (row.kind === 'repair') {
    put(tables, 0x3800, 0xa027n);
    put(tables, 0x3028, 0x4067n);
  }
  return expected;
}

async function measurePagingRows(
  side,
  { iterations = 10001, samples = 7, workloads = pagingNames, leafAA = false } = {},
) {
  const definitions = [],
    results = [];
  for (const selected of rows.filter((row) => workloads.includes(row.name))) {
    const row =
      leafAA && selected.kind === 'leaf-store' ? { ...selected, coldLeaf: false } : selected;
    const n = Math.min(
      iterations,
      row.cycles || row.resume
        ? 101
        : row.kind.startsWith('root') || row.kind === 'invlpg' || row.kind === 'software'
          ? 1001
          : 10001,
    );
    const setup = image(row),
      limits = {
        ...LIMITS,
        maxTranslationsPerRun:
          row.kind.startsWith('root') || row.kind === 'invlpg' ? 4 * n + 8 : 32,
      };
    const began = performance.now();
    const cpu = await side.createCpu({
      compiler: side.compiler,
      memoryModel: 'ia32e-paged',
      paging: BANK,
      memory: {
        backings: setup.spans.map((span) => ({ id: span.name, bytes: span.bytes })),
        mappings: mappings(setup.spans),
      },
      memoryLimits: { maxBackings: 16, maxMappings: 32, maxBackingBytes: 131072 },
      entry: CODE,
      limits,
    });
    const creationMs = performance.now() - began;
    try {
      const context = cpu.readContext();
      if (row.kind === 'repair' || row.kind === 'software') {
        context.gdtr = { base: 0x402000n, limit: 0x3f };
        context.idtr = { base: 0x403000n, limit: 0xfff };
        cpu.setContext(context);
      }
      const numericBefore = numeric(cpu),
        debug = cpu.readDebugState();
      if (row.kind === 'leaf-store') {
        cpu.setState(state(row, 1));
        const warmup = await cpu.run({ budget: 1n });
        equal(warmup.reason, 'budget', row.name + ' untimed warmup reason');
        equal(warmup.retired, 1n, row.name + ' untimed warmup retirement');
        equal(warmup.resources.compilations, 1, row.name + ' untimed warmup compilation');
        equal(warmup.resources.nativeEntries, 1, row.name + ' untimed warmup native entry');
        equal(warmup.resources.pagingRestarts, 0, row.name + ' untimed warmup restarts');
      }
      const instructionCount =
        row.kind === 'repair'
          ? 8 * n
          : row.kind === 'private-repair' || row.kind === 'leaf-store'
            ? n
            : row.kind === 'root-switch'
              ? 5 * n
              : row.kind === 'pf' || row.kind === 'private'
                ? 0
                : row.kind === 'software'
                  ? 3 * n
                  : 2 * n;
      definitions.push({
        name: row.name,
        iterations: n,
        instructions: instructionCount,
        calls: row.resume || row.kind === 'private-repair' ? 2 * n : row.cycles ? n : 1,
        work: n,
        workUnit:
          row.kind === 'leaf-store'
            ? 'single8B store run'
            : row.kind === 'private-repair'
              ? 'physical-refusal/host-repair/retry'
              : row.kind === 'root-switch'
                ? 'two root changes + LOOP'
                : row.kind === 'pf' || row.kind === 'private'
                  ? 'faulting run'
                  : row.kind === 'repair'
                    ? 'fault/guest-repair/retry'
                    : row.kind === 'software'
                      ? 'software-entry/IRET/LOOP'
                      : 'operand/control + LOOP',
        pageSize: row.size,
        coldAD: Boolean(row.cold || row.coldLeaf),
        ...(row.kind === 'leaf-store'
          ? {
              leafComparison: leafAA
                ? 'A/A: both named cohorts use warmed leaf A/D; no leaf reset'
                : 'A/B: warmed leaf versus leaf A/D cleared per call',
              prewarmedArtifact: true,
              leafUpdatePattern: row.coldLeaf
                ? 'Before every measured call clear only the data PTE A/D to a007. Code and all upper A bits remain set. Host leaf/scalar reset is excluded from elapsedMs and included in wallMs. Every measured call has zero compilation and one native entry.'
                : 'Code/artifact and data PTE A/D prewarmed outside both timers. Every measured call has zero compilation and one native entry.',
            }
          : {}),
        ...(row.cold
          ? {
              coldUpdatePattern:
                'A/D cleared once per sample before the loop. The remaining iterations use warmed metadata; elapsedMs/work includes amortized cold admission and recompilation, not isolated A/D-update latency.',
            }
          : {}),
        limits,
        timing:
          'elapsedMs sums awaited run calls, including snapshots/compilation. wallMs includes per-cycle reset/repair/guards. Initial CPU/numeric/context setup and initial sample scalar/table reset are outside both. Cold rows deliberately invalidate dependent artifacts. No retained TLB is claimed.',
      });
      for (let sample = 0; sample < samples; sample++) {
        if (row.cold) cpu.writePhysicalMemory(0x1000n, setup.spans[0].bytes);
        const initial = state(row, row.cycles ? 1 : n);
        cpu.setState(initial);
        const contextBefore = cpu.readContext();
        const totals = {},
          timings = {},
          wallStart = performance.now();
        let elapsedMs = 0,
          retired = 0n,
          attempts = 0n,
          result,
          calls = 0;
        const run = async (options) => {
          const at = performance.now();
          result = await cpu.run(options);
          elapsedMs += performance.now() - at;
          calls++;
          retired += result.retired;
          attempts += result.deliveryAttempts ?? 0n;
          for (const [key, value] of Object.entries(result.resources))
            if (typeof value === 'number' && !key.startsWith('cached'))
              totals[key] = (totals[key] ?? 0) + value;
          for (const [key, value] of Object.entries(result.timings))
            timings[key] = (timings[key] ?? 0) + value;
          return result;
        };
        if (row.cycles)
          for (let i = 0; i < n; i++) {
            cpu.setState(initial);
            if (row.kind === 'leaf-store') {
              if (row.coldLeaf) {
                const leaf = new Uint8Array(8);
                put(leaf, 0, 0xa007n);
                cpu.writePhysicalMemory(0x4800n, leaf);
              }
              await run({ budget: 1n });
              equal(result.reason, 'budget', row.name + ' call reason');
              equal(result.retired, 1n, row.name + ' call retirement');
              equal(result.resources.compilations, 0, row.name + ' no measured compilation');
              equal(result.resources.nativeEntries, 1, row.name + ' one native entry per call');
              equal(result.resources.dispatches, 0, row.name + ' no host dispatch');
              continue;
            }
            if (row.kind === 'private-repair') {
              cpu.setMappings(mappings(setup.spans));
              await run({ budget: 1n });
              equal(result.reason, 'physical-memory-fault', row.name + ' first refusal');
              equal(result.retired, 0n, row.name + ' first retirement');
              cpu.setMappings(mappings(setup.spans, true));
              await run({ budget: 1n });
              equal(result.reason, 'budget', row.name + ' repaired retry');
              equal(result.retired, 1n, row.name + ' one completed retry');
              continue;
            }
            if (row.kind === 'repair') cpu.writePhysicalMemory(0x4800n, new Uint8Array(8));
            await run({
              budget: row.kind === 'repair' ? 8n : 1n,
              stop: CODE + 3n,
              ...(row.kind === 'repair' ? { eventDelivery: { budget: 1n } } : {}),
            });
            equal(
              result.reason,
              row.kind === 'pf'
                ? 'page-fault'
                : row.kind === 'private'
                  ? 'physical-memory-fault'
                  : 'budget',
              row.name + ' reason',
            );
            equal(result.retired, row.kind === 'repair' ? 8n : 0n, row.name + ' cycle retirement');
          }
        else if (row.resume)
          for (let i = 0; i < 2 * n; i++) {
            await run({ budget: 1n });
            equal(result.reason, 'budget', row.name + ' resume');
          }
        else {
          await run({
            budget: BigInt(instructionCount),
            ...(row.kind === 'software' ? { eventDelivery: { budget: BigInt(n) } } : {}),
          });
          equal(result.reason, 'budget', row.name + ' reason');
        }
        equal(retired, BigInt(instructionCount), row.name + ' total retirement');
        const expectedRegisters = initial.registers.slice();
        if (row.kind === 'load' || row.kind === 'repair' || row.kind === 'private-repair')
          expectedRegisters[0] = 0x8877665544332211n;
        if (!row.cycles) expectedRegisters[1] = 0n;
        if (row.kind === 'repair') {
          expectedRegisters[0] = 0x8877665544332211n;
          expectedRegisters[1] = 0x405800n;
          expectedRegisters[10] = DATA;
        }
        equal(result.state.registers, expectedRegisters, row.name + ' complete GPRs');
        equal(result.state.flags, 0x202n, row.name + ' FLAGS');
        equal(
          result.state.rip,
          row.cycles
            ? row.kind === 'repair' || row.kind === 'private-repair' || row.kind === 'leaf-store'
              ? CODE + 3n
              : CODE
            : CODE + BigInt(row.body.length / 2 + 2),
          row.name + ' RIP',
        );
        equal(result.state.event, { kind: 'ready' }, row.name + ' event');
        equal(
          result.state.interruptibility,
          { sti: false, ss: false },
          row.name + ' interruptibility',
        );
        equal(
          result.state.interrupts,
          { irq: null, nmiPending: false, nmiBlocked: false },
          row.name + ' interrupts',
        );
        equal(result.repeatIterations, 0n, row.name + ' repeat');
        equal(cpu.readContext(), contextBefore, row.name + ' complete context');
        equal(cpu.readDebugState(), debug, row.name + ' debug');
        equal(
          stable([cpu.readXmmState(), cpu.readMxcsr(), cpu.readX87State()]),
          numericBefore,
          row.name + ' raw numeric',
        );
        equal(
          cpu.readPagingState(),
          { ...BANK, cr2: row.kind === 'pf' || row.kind === 'repair' ? DATA : 0n },
          row.name + ' paging',
        );
        if (row.kind === 'pf')
          equal(
            result.pageFault,
            { instructionPc: CODE, vector: 14, address: DATA, access: 'read', errorCode: 0 },
            row.name + ' literal page diagnostic',
          );
        if (row.kind === 'private')
          equal(
            result.physicalMemoryFault,
            {
              instructionPc: CODE,
              address: DATA,
              access: 'read',
              physicalAddress: 0xa000n,
              width: 8,
              failingPhysicalAddress: 0xa000n,
              physicalAccess: 'read',
              segment: 'ds',
              cause: 'permission',
              phase: 'final-access',
            },
            row.name + ' literal private diagnostic',
          );
        const expected = expectedMemory(row, setup, initial);
        if (row.kind.startsWith('private')) cpu.setMappings(mappings(setup.spans, true));
        for (const span of setup.spans) {
          equal(
            cpu.readPhysicalMemory(span.base, span.bytes.length),
            expected.get(span.name),
            row.name + ' full ' + span.name,
          );
        }
        if (row.kind.startsWith('private')) cpu.setMappings(mappings(setup.spans));
        equal(attempts, row.kind === 'repair' ? BigInt(n) : 0n, row.name + ' automatic entries');
        equal(totals.pagingRestarts, 0, row.name + ' no restart');
        if (!row.cycles && !row.resume && ['load', 'store'].includes(row.kind)) {
          equal(totals.nativeEntries, 1, row.name + ' one native loop entry');
          equal(totals.dispatches, 0, row.name + ' no per-instruction host dispatch');
          equal(
            totals.compilations,
            row.cold || sample === 0 ? 1 : 0,
            row.name + ' cold/warm compilation',
          );
        }
        results.push({
          workload: row.name,
          side: side.label,
          sample,
          window: sample === 0 ? 'first' : sample < 4 ? 'early' : 'later',
          elapsedMs,
          wallMs: performance.now() - wallStart,
          creationMs,
          calls,
          retired,
          attempts,
          resources: totals,
          timings,
          translations: cpu.inspectTranslations(),
        });
      }
    } finally {
      cpu.dispose();
    }
  }
  return {
    definitions,
    samples: results,
    ceiling:
      'Current-only imported-paging synthetic kernels. No baseline has this profile. Byte/state/numeric/context/debug/control guards run outside summed run timing. Walk counts are not inferred from elapsed time.',
  };
}

export async function measurePaging(side, options = {}) {
  const { workloads = pagingNames, samples = 7, reverse = false } = options;
  const leaf = workloads.filter(
    (name) => name === 'paging-leaf-warm-store' || name === 'paging-leaf-cold-ad-store',
  );
  const result = await measurePagingRows(side, {
    ...options,
    workloads: workloads.filter((name) => !leaf.includes(name)),
  });
  // These two rows are an actual same-guest mode control. Alternate their cohorts,
  // with an independently prewarmed CPU per sample, rather than time all warm first.
  for (let sample = 0; sample < samples; sample++) {
    const order = Boolean(sample % 2) !== reverse ? leaf.slice().reverse() : leaf;
    for (const name of order) {
      const part = await measurePagingRows(side, { ...options, samples: 1, workloads: [name] });
      if (sample === 0)
        result.definitions.push(
          ...part.definitions.map((definition) => ({
            ...definition,
            pairedSchedule:
              'Warm/cold leaf rows alternate sample order; --reverse flips the first order. An independent CPU/artifact is prewarmed before each sample, outside both timers. creationMs is that sample CPU creation only; no independent cold-run latency claim.',
          })),
        );
      result.samples.push(
        ...part.samples.map((row) => ({
          ...row,
          sample,
          window: sample === 0 ? 'first' : sample < 4 ? 'early' : 'later',
        })),
      );
    }
  }
  return { ...result, reverse, leafAA: options.leafAA ?? false };
}
