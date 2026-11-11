const PC = 0x400000n,
  DATA = 0x500010n;
export const pagingWorkloads = ['fetch', 'load', 'store', 'rmw', 'system'];
const code = {
  fetch: '90ffc975fb',
  load: '488b03ffc975f9',
  store: '488903ffc975f9',
  rmw: '48830301ffc975f8',
  system: '0f0303ffc975f9',
};
const check = (ok, label) => {
  if (!ok) throw Error(label);
};
const equal = (a, b, label) => check(a === b, `${label}: expected ${String(b)}, got ${String(a)}`);
const hex = (s) => Uint8Array.from(s.match(/../g), (x) => parseInt(x, 16));
const little = (n, width) =>
  Uint8Array.from({ length: width }, (_, i) => Number((n >> BigInt(8 * i)) & 255n));
const limits = {
  maxInstructions: 32,
  maxSourceBytes: 256,
  maxArtifactBytes: 65536,
  maxCachedArtifacts: 8,
  maxCachedBytes: 1048576,
  maxTranslationsPerRun: 8,
};
function setup(compiler, name) {
  const tables = new Uint8Array(0x5000),
    view = new DataView(tables.buffer);
  for (const [at, value] of [
    [0, 0x2027n],
    [0x1000, 0x3027n],
    [0x2010, 0x4027n],
    [0x2018, 0x5027n],
    [0x3000, 0x9027n],
    [0x3800, 0xa067n],
    [0x4000, 0xb027n],
  ])
    view.setBigUint64(at, value, true);
  const gdt = hex('0000000000000000ffff0000009bcf00ffff00000093cf00');
  const backings = [
    { id: 'tables', bytes: tables },
    { id: 'code', bytes: hex(code[name]) },
    { id: 'data', bytes: new Uint8Array(64) },
    { id: 'gdt', bytes: gdt },
  ];
  const bases = [0x1000n, 0x9000n, 0xa000n, 0xb000n];
  return {
    compiler,
    memoryModel: 'ia32e-paged',
    paging: { cr0: 0x80000033n, cr2: 0n, cr3: 0x1000n, cr4: 0x628n, efer: 0x500n },
    entry: PC,
    limits,
    memoryLimits: { maxBackings: 4, maxMappings: 4, maxBackingBytes: 0x10000 },
    memory: {
      backings,
      mappings: backings.map((b, i) => ({
        base: bases[i],
        backing: b.id,
        offset: 0,
        length: b.bytes.length,
        permissions: { read: true, write: i === 0 || i === 2, execute: i === 1 },
      })),
    },
  };
}
function prepare(cpu, name, n) {
  const bytes = new Uint8Array(64).fill(0xa5);
  const value = name === 'load' ? 7n : name === 'system' ? 0x10n : 0n;
  bytes.set(little(value, name === 'system' ? 2 : 8), 16);
  cpu.writePhysicalMemory(0xa000n, bytes);
  const registers = Array.from({ length: 16 }, (_, i) => 0x1122334400000000n + BigInt(i));
  registers[0] = name === 'store' ? 0x1122334455667788n : 0x12345678n;
  registers[1] = BigInt(n);
  registers[3] = DATA;
  cpu.setState({
    registers,
    flags: 2n,
    rip: PC,
    interruptibility: { sti: false, ss: false },
    event: { kind: 'ready' },
    interrupts: { irq: null, nmiPending: false, nmiBlocked: false },
  });
  return { registers, bytes };
}
function verify(cpu, name, n, before, result, sample) {
  equal(result.reason, 'budget', name + ' reason');
  equal(result.retired, 3n * BigInt(n), name + ' retirements');
  equal(result.remaining, 0n, 'remaining');
  equal(result.repeatIterations, 0n, 'repeat work');
  equal(result.state.rip, PC + BigInt(code[name].length / 2), 'final PC');
  equal(result.state.flags, 0x46n, 'defined final DEC flags');
  const expected = [...before.registers];
  expected[1] = 0n;
  if (name === 'load') expected[0] = 7n;
  if (name === 'system') expected[0] = 0xffffffffn;
  for (let i = 0; i < 16; i++) equal(result.state.registers[i], expected[i], name + ' raw GPR' + i);
  if (name === 'store') before.bytes.set(little(expected[0], 8), 16);
  if (name === 'rmw') before.bytes.set(little(BigInt(n), 8), 16);
  const actual = cpu.readPhysicalMemory(0xa000n, 64);
  for (let i = 0; i < 64; i++) equal(actual[i], before.bytes[i], name + ' guarded data byte' + i);
  equal(result.resources.compilations, sample === 0 ? 1 : 0, 'compilations');
  equal(result.resources.nativeEntries, 1, 'native entries');
  equal(result.resources.dispatches, 0, 'dispatches');
  equal(result.state.event.kind, 'ready', 'no pending event');
  equal(result.deliveryAttempts, undefined, 'no entry allowance');
  check(
    !result.fault &&
      !result.pageFault &&
      !result.physicalMemoryFault &&
      !result.deviceNotAvailable &&
      !result.numericControlFault,
    'no hidden fault',
  );
  const table = cpu.readPhysicalMemory(0x4800n, 8);
  equal(
    new DataView(table.buffer, table.byteOffset, 8).getBigUint64(0, true),
    0xa067n,
    'warm AD bits unchanged',
  );
  equal(cpu.inspectTranslations().length, 1, 'one resident artifact');
}
// Sides carry their own factory and compiled Core; no side shares a CPU or backing.
export async function measurePaging(
  sides,
  { iterations, samples, reverse = false, smoke = false, workloads = pagingWorkloads },
) {
  const results = [];
  for (const name of workloads) {
    const active = [];
    try {
      for (const side of sides) {
        const cpu = await side.createCpu(setup(side.compiler, name));
        if (name === 'system') {
          const context = cpu.readContext();
          context.gdtr = { base: 0x600000n, limit: 23 };
          cpu.setContext(context);
        }
        active.push({ ...side, cpu });
      }
      for (let sample = 0; sample < samples; sample++) {
        const order = (sample + Number(reverse)) % 2 ? [...active].reverse() : active;
        for (const [orderIndex, side] of order.entries()) {
          const before = prepare(side.cpu, name, iterations);
          const began = smoke ? 0 : performance.now();
          const result = await side.cpu.run({ budget: 3n * BigInt(iterations) });
          const elapsedMs = smoke ? undefined : performance.now() - began;
          verify(side.cpu, name, iterations, before, result, sample);
          results.push({
            side: side.label,
            workload: name,
            sample,
            window: sample === 0 ? 'first' : 'warm',
            orderIndex,
            iterations,
            retired: result.retired.toString(),
            reason: result.reason,
            ...(smoke
              ? {}
              : { elapsedMs, timings: result.timings, creationMs: side.cpu.creationMs }),
            resources: result.resources,
            units: side.cpu.inspectTranslations(),
          });
        }
      }
    } finally {
      for (const side of active) side.cpu.dispose();
    }
  }
  return {
    smoke,
    iterations,
    samples,
    reverse,
    results,
    workloads,
    limits,
    expectedSemanticWork: {
      instructionsPerIteration: 3,
      fetch: { operandBytes: 0 },
      load: { readBytes: 8 },
      store: { writeBytes: 8 },
      rmw: { readBytes: 8, writeBytes: 8 },
      system: { selectorReadBytes: 2, descriptorReadBytes: 8 },
      walkLevels: 4,
      tableAD: 'already set; no required A/D update',
    },
    ceiling:
      'Expected semantic bytes are not physical-read instrumentation. Timings include public run/snapshot work; no subtraction across workloads, hardware-cycle or application claim. First sample includes generated compilation; warm samples reuse one artifact. Smoke runs do not record timing.',
  };
}
