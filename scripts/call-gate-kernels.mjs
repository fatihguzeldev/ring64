// Independent public-CPU oracle. Descriptor bytes and expected frame arithmetic live here;
// no production decoder, frame planner, or execution-test fixture is imported.
const CODE = 0x1000n;
const TARGET = 0x2000n;
const GDT = 0x4000n;
const TSS = 0x5000n;
const POINTER = 0x6000n;
const RAM_BYTES = 0x50000;
const LIMITS = {
  maxInstructions: 32,
  maxSourceBytes: 512,
  maxArtifactBytes: 131072,
  maxCachedArtifacts: 16,
  maxCachedBytes: 2097152,
  maxTranslationsPerRun: 16,
};
const mask = (width) => (1n << BigInt(width * 8)) - 1n;
const little = (value, width) =>
  Array.from({ length: width }, (_, i) => Number((BigInt(value) >> BigInt(8 * i)) & 255n));
const stable = (value) =>
  JSON.stringify(value, (_, item) =>
    typeof item === 'bigint'
      ? item.toString(16)
      : item !== null && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
        : item,
  );
function equal(actual, expected, label) {
  if (ArrayBuffer.isView(actual) && ArrayBuffer.isView(expected)) {
    if (actual.length !== expected.length) throw Error(`${label}: byte length differs`);
    for (let i = 0; i < actual.length; i++)
      if (actual[i] !== expected[i])
        throw Error(`${label}: byte 0x${i.toString(16)} = ${actual[i]}, expected ${expected[i]}`);
  } else if (stable(actual) !== stable(expected))
    throw Error(`${label}: ${stable(actual)} != ${stable(expected)}`);
}
function put(bytes, at, value, width = 4) {
  bytes.set(little(value, width), Number(at));
}
function descriptor(base, dpl, code, bits, accessed = true) {
  // All legacy segments deliberately have a 4-GiB expanded limit, including B=0.
  const raw = [255, 255, ...little(base, 3), (code ? 0x9a : 0x92) | (dpl << 5) | +accessed];
  return Uint8Array.of(...raw, (bits === 64 ? 0xa0 : bits === 32 ? 0xc0 : 0x80) | 15, 0);
}
function segment(selector, base, dpl, code, bits) {
  return {
    selector,
    base,
    limit: 0xffffffff,
    default32: bits === 32,
    usable: true,
    type: code ? 'readable-code' : 'read-write',
    dpl,
    present: true,
    conforming: false,
    accessed: true,
    long: bits === 64,
    granularity: true,
    available: false,
  };
}
const vacant = { selector: 0, valid: false, base: 0n, limit: 0, attributes: 0 };
const noSwitch = (row) => row.same || row.conforming;
function context(row) {
  const dpl = row.same ? 0 : 3;
  const oldSs = segment(row.same ? 0x10 : 0x23, row.oldBase, dpl, false, row.oldBits);
  return {
    mode: row.long ? (row.compat ? 'compatibility' : 'long64') : 'protected',
    cpl: dpl,
    segments: {
      cs: segment(
        row.same ? (row.equalContext ? 8 : 0x48) : 0x1b,
        0n,
        dpl,
        true,
        row.long && !row.compat ? 64 : row.sourceBits,
      ),
      ss: oldSs,
      ...Object.fromEntries(['ds', 'es', 'fs', 'gs'].map((name) => [name, { ...oldSs, base: 0n }])),
    },
    gdtr: { base: GDT, limit: 0x7f },
    idtr: { base: 0n, limit: 0 },
    ldtr: { ...vacant },
    tr: noSwitch(row)
      ? { ...vacant }
      : {
          selector: 0x28,
          valid: true,
          base: TSS,
          limit: 0x67,
          attributes: row.trBits === 16 ? 0x83 : 0x8b,
        },
  };
}
function flagsNumeric(cpu) {
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
  return numeric(cpu);
}
const numeric = (cpu) => [cpu.readXmmState(), cpu.readMxcsr(), cpu.readX87State()];
const read = (cpu, f, address, width) =>
  f.paging ? cpu.readPhysicalMemory(address, width) : cpu.readMemory(address, width);
function definition(input) {
  return {
    width: 4,
    count: 1,
    oldBits: 32,
    newBits: 32,
    sourceBits: 32,
    trBits: 32,
    oldBase: 0x10000n,
    newBase: 0x20000n,
    oldSp: 0x1122334400004000n,
    newSp: 0x9000n,
    memory: 'linear',
    ...input,
  };
}
function bank(row, ram) {
  if (row.memory === 'linear') return undefined;
  const value = { cr0: 0x80010033n, cr2: 0x12345000n, cr3: 0x40000n, cr4: 0x608n, efer: 0n };
  if (row.memory === 'pg0') return { ...value, cr0: 0x33n, cr3: 0xdead000n };
  if (row.memory === 'nonpae') {
    put(ram, 0x40000n, row.pageCold ? 0x41007n : 0x41067n);
    for (let i = 0; i < RAM_BYTES / 4096; i++)
      put(ram, 0x41000n + BigInt(i * 4), BigInt(i * 4096) | (row.pageCold ? 7n : 0x67n));
  } else if (row.memory === 'pae') {
    value.cr4 |= 0x20n;
    value.pdpte = [0x41001n, 0n, 0n, 0n];
    put(ram, 0x40000n, 0x41001n, 8);
    put(ram, 0x41000n, 0x42067n, 8);
    for (let i = 0; i < RAM_BYTES / 4096; i++)
      put(ram, 0x42000n + BigInt(i * 8), BigInt(i * 4096) | 0x67n, 8);
  } else {
    value.cr4 |= 0x20n;
    value.efer = 0x500n;
    for (const [at, next] of [
      [0x40000n, 0x41027n],
      [0x41000n, 0x42027n],
      [0x42000n, 0x43027n],
    ])
      put(ram, at, next, 8);
    for (let i = 0; i < RAM_BYTES / 4096; i++)
      put(ram, 0x43000n + BigInt(i * 8), BigInt(i * 4096) | 0x67n, 8);
  }
  return value;
}
function fixture(input, looping = false) {
  const row = definition(input);
  if (row.long) {
    row.width = 8;
    row.oldBase = row.newBase = 0n;
    row.oldSp = input.oldSp ?? 0x4000n;
    row.newSp = input.newSp ?? 0x9003n;
  }
  const ram = new Uint8Array(RAM_BYTES).fill(0xa5);
  ram.fill(0, 0x40000);
  const targetBits = row.long ? 64 : row.width === 2 ? 32 : 16;
  ram.set(descriptor(row.newBase, 0, false, row.newBits, !row.accessedCold), Number(GDT + 16n));
  // Code base must be zero; stack base is independent of target CS.D.
  ram.set(descriptor(0n, 0, true, targetBits, !row.accessedCold), Number(GDT + 8n));
  if (row.conforming) ram[Number(GDT + 13n)] |= 4;
  ram.set(
    descriptor(0n, 3, true, row.long && !row.compat ? 64 : row.sourceBits),
    Number(GDT + 24n),
  );
  ram.set(descriptor(row.oldBase, 3, false, row.oldBits), Number(GDT + 32n));
  ram.set(
    descriptor(0n, 0, true, row.long && !row.compat ? 64 : row.sourceBits),
    Number(GDT + 72n),
  );
  // Call gate literal layout: low offset, embedded selector, count, P/DPL/type, high offset.
  ram.set(
    [0, 0x20, 8, 0, row.count | (row.long ? 0xe0 : 0), row.width === 2 ? 0xe4 : 0xec, 0, 0],
    Number(GDT + 56n),
  );
  if (row.long) ram.fill(0, Number(GDT + 64n), Number(GDT + 72n));
  if (row.long) put(ram, TSS + 4n, row.newSp, 8);
  else if (row.trBits === 16) {
    put(ram, TSS + 2n, row.newSp, 2);
    put(ram, TSS + 4n, 0x10n, 2);
  } else {
    put(ram, TSS + 4n, row.newSp, 4);
    put(ram, TSS + 8n, 0x10n, 2);
  }
  const operandWidth = row.width === 2 ? 4 : 2;
  const call = row.long
    ? row.compat
      ? [0xff, 0x1d, ...little(POINTER, 4)]
      : [0x48, 0xff, 0x1b]
    : [
        ...(operandWidth * 8 !== row.sourceBits ? [0x66] : []),
        0x9a,
        ...little(0x11223344n, operandWidth),
        0x3b,
        0,
      ];
  put(ram, POINTER, 0x8877665544332211n, row.long && !row.compat ? 8 : 4);
  put(ram, POINTER + BigInt(row.long && !row.compat ? 8 : 4), 0x3bn, 2);
  const rearm =
    looping && !noSwitch(row)
      ? row.long
        ? row.compat
          ? [0xbc, ...little(row.oldSp, 4)]
          : [0x48, 0xbc, ...little(row.oldSp, 8)]
        : [...(row.sourceBits === 16 ? [0x66] : []), 0xbc, ...little(row.oldSp, 4)]
      : [];
  const code = [...rearm, ...call];
  const nextPc = CODE + BigInt(code.length);
  if (looping) code.push(0xe2, -(code.length + 2) & 255);
  ram.set(code, Number(CODE));
  const cleanup = row.long || noSwitch(row) ? 0 : row.count * row.width;
  const returnCode = row.long ? [0x48, 0xcb] : [0x66, 0xca, ...little(cleanup, 2)];
  if (row.kind === 'gate-edit') {
    ram.set([0x66, 0xb8, ...little(0xaaaa1234n, 4), ...returnCode], Number(TARGET));
    ram.set([0x66, 0xb8, ...little(0xbbbb5678n, 4), ...returnCode], Number(TARGET + 0x100n));
  } else ram.set(returnCode, Number(TARGET));
  const values = [];
  for (let i = 0; i < row.count && !row.long && !noSwitch(row); i++) {
    const value = (0x9e3779b9n * BigInt(i + 1) + BigInt(row.width * 257)) & mask(row.width);
    const at = row.oldBase + ((row.oldSp + BigInt(i * row.width)) & mask(row.oldBits / 8));
    put(ram, at, value, row.width);
    values.push(value);
  }
  const paging = bank(row, ram);
  const execution = context(row);
  const registers = Array.from({ length: 16 }, (_, i) => 0x3333000000000000n + BigInt(i));
  registers[3] = POINTER;
  registers[4] = row.oldSp;
  if (row.kind === 'gate-edit') registers[0] = 0n;
  const state = { registers, flags: 0x104d7n, rip: CODE };
  const bytes = ram.slice();
  const memory = {
    backings: [{ id: 'ram', bytes }],
    mappings: [
      {
        base: 0n,
        backing: 'ram',
        offset: 0,
        length: RAM_BYTES,
        permissions: { read: true, write: true, execute: true },
      },
    ],
  };
  if (row.highStackBase !== undefined)
    memory.mappings.push({
      base: row.highStackBase,
      backing: 'ram',
      offset: 0x30000,
      length: 0x10000,
      permissions: { read: true, write: true, execute: true },
    });
  return {
    row,
    ram,
    execution,
    state,
    nextPc,
    values,
    code,
    paging,
    config: {
      entry: CODE,
      context: execution,
      limits: LIMITS,
      memory,
      memoryLimits: {
        maxBackings: 1,
        maxMappings: memory.mappings.length,
        maxBackingBytes: RAM_BYTES,
      },
      ...(paging
        ? { memoryModel: row.memory === 'ia32e-fixed' ? 'ia32e-paged' : 'physical', paging }
        : {}),
    },
  };
}
function frameExpected(f) {
  const { row, state, nextPc, values } = f;
  const width = row.width;
  const slots = noSwitch(row)
    ? [BigInt(f.execution.segments.cs.selector), nextPc]
    : row.long
      ? [
          BigInt(f.execution.segments.ss.selector),
          row.oldSp,
          BigInt(f.execution.segments.cs.selector),
          nextPc,
        ]
      : [
          BigInt(f.execution.segments.ss.selector),
          row.oldSp,
          ...values.slice().reverse(),
          BigInt(f.execution.segments.cs.selector),
          nextPc,
        ];
  const expected = f.ram.slice();
  let raw = noSwitch(row) ? row.oldSp : row.newSp;
  const bits = row.long ? 64 : noSwitch(row) ? row.oldBits : row.newBits;
  for (const value of slots) {
    raw = (raw & ~mask(bits / 8)) | ((raw - BigInt(width)) & mask(bits / 8));
    const address = (noSwitch(row) ? row.oldBase : row.newBase) + (raw & mask(bits / 8));
    const backingOffset =
      row.highStackBase !== undefined && address >= row.highStackBase
        ? 0x30000n + address - row.highStackBase
        : address;
    put(expected, backingOffset, value, width);
  }
  if (row.accessedCold) {
    expected[Number(GDT + 13n)] |= 1;
    if (!noSwitch(row) && !row.long) expected[Number(GDT + 21n)] |= 1;
  }
  if (row.pageCold) {
    // This finite non-PAE fixture touches source, target, GDT, TSS, old params,
    // and one destination page. Only the destination leaf gains D.
    expected[0x40000] |= 0x20;
    for (const page of [1, 2, 4, 5, 0x14, 0x28]) expected[0x41000 + page * 4] |= 0x20;
    expected[0x41000 + 0x28 * 4] |= 0x40;
  }
  const registers = state.registers.slice();
  registers[4] = raw;
  return { ram: expected, registers, raw, slots: slots.length };
}
function completion(result, budget, label) {
  equal(result.reason, 'budget', `${label} completion`);
  equal(result.retired, budget, `${label} retirement`);
  equal(result.repeatIterations, 0n, `${label} no repeated work`);
}
function targetContext(f, original) {
  const result = structuredClone(original);
  result.cpl = f.row.conforming ? original.cpl : 0;
  result.mode = f.row.long ? 'long64' : 'protected';
  result.segments.cs = segment(
    8 | result.cpl,
    0n,
    0,
    true,
    f.row.long ? 64 : f.row.width === 2 ? 32 : 16,
  );
  result.segments.cs.conforming = !!f.row.conforming;
  if (!noSwitch(f.row))
    result.segments.ss = f.row.long
      ? { ...original.segments.ss, selector: 0, usable: false, dpl: 0 }
      : segment(0x10, f.row.newBase, 0, false, f.row.newBits);
  return result;
}
async function checkOne(side, input) {
  const f = fixture(input),
    expected = input.reject ? undefined : frameExpected(f);
  const cpu = await side.createCpu({ compiler: side.compiler, ...f.config });
  try {
    const original = cpu.readContext(),
      numbers = flagsNumeric(cpu);
    cpu.setState(f.state);
    const entered = await cpu.run({ budget: 1n });
    if (input.reject) {
      equal(entered.reason, 'protection-fault', `${input.name} touched-span rejection`);
      equal(entered.protectionFault?.vector, 12, `${input.name} SS owns stack span`);
      equal(entered.protectionFault?.errorCode, 0, `${input.name} stack fault code`);
      equal(entered.retired, 0n, `${input.name} no retirement`);
      equal(entered.state.registers, f.state.registers, `${input.name} failed scalar atomicity`);
      equal(entered.state.rip, CODE, `${input.name} failed PC atomicity`);
      equal(entered.state.flags, f.state.flags & ~0x10000n, `${input.name} begin-cleared RF`);
      equal(cpu.readContext(), original, `${input.name} failed context atomicity`);
      equal(read(cpu, f, 0n, RAM_BYTES), f.ram, `${input.name} no frame or descriptor payload`);
      equal(numeric(cpu), numbers, `${input.name} failed numeric state`);
      return { calls: 1, copiedParameters: 0, frameSlots: 0 };
    }
    completion(entered, 1n, input.name);
    equal(entered.state.rip, TARGET, `${input.name} target ignores far operand offset`);
    equal(entered.state.registers, expected.registers, `${input.name} entry GPRs/raw stack`);
    equal(entered.state.flags, f.state.flags & ~0x10000n, `${input.name} RF/flags`);
    equal(cpu.readContext(), targetContext(f, original), `${input.name} target context`);
    equal(
      read(cpu, f, 0n, RAM_BYTES),
      expected.ram,
      `${input.name} exact frame and all untouched RAM`,
    );
    equal(numeric(cpu), numbers, `${input.name} numeric/pending state`);
    const returned = await cpu.run({ budget: 1n });
    completion(returned, 1n, `${input.name} return`);
    const registers = f.state.registers.slice();
    const restored = f.row.oldSp & mask(f.row.width);
    registers[4] = f.row.same
      ? f.row.oldSp
      : f.row.long
        ? f.row.oldSp
        : (restored & ~mask(f.row.oldBits / 8)) |
          ((restored + BigInt(f.row.count * f.row.width)) & mask(f.row.oldBits / 8));
    equal(returned.state.rip, f.nextPc & mask(f.row.width), `${input.name} literal return PC`);
    equal(returned.state.registers, registers, `${input.name} cleanup/raw pointer roundtrip`);
    equal(returned.state.flags, f.state.flags & ~0x10000n, `${input.name} return flags`);
    equal(cpu.readContext(), original, `${input.name} restored full context`);
    equal(read(cpu, f, 0n, RAM_BYTES), expected.ram, `${input.name} return leaves frame bytes`);
    equal(numeric(cpu), numbers, `${input.name} return numeric/pending state`);
    return {
      calls: 2,
      copiedParameters: f.row.long || f.row.same ? 0 : f.row.count,
      frameSlots: expected.slots,
    };
  } catch (error) {
    error.message = `${input.name}: ${error.message}`;
    throw error;
  } finally {
    cpu.dispose();
  }
}
export async function checkCallGates(side, { matrix = true } = {}) {
  const rows = [];
  if (matrix)
    for (const width of [2, 4])
      for (let count = 0; count < 32; count++)
        for (const oldBits of [16, 32])
          for (const newBits of [16, 32])
            for (const trBits of [16, 32])
              for (const sourceBits of [16, 32])
                rows.push({
                  name: `legacy-w${width}-n${count}-old${oldBits}-new${newBits}-tr${trBits}-cs${sourceBits}`,
                  width,
                  count,
                  oldBits,
                  newBits,
                  trBits,
                  sourceBits,
                  newSp: trBits === 32 && newBits === 16 ? 0x12349000n : 0x9000n,
                });
  rows.push(
    { name: 'raw-old-b16-wrap-full-dword', count: 2, oldBits: 16, oldSp: 0x11223344abcdfffen },
    { name: 'raw-new-b16-wrap', count: 2, newBits: 16, newSp: 0x12340008n },
    ...[1, 2].map((count) => ({
      name: `captured-overlap-n${count}`,
      count,
      oldBase: 0n,
      newBase: 0n,
      oldSp: 0x8000n,
      newSp: BigInt(0x8004 + count * 4),
    })),
    ...['pg0', 'nonpae', 'pae'].map((memory) => ({
      name: `raw-bank-${memory}`,
      memory,
      count: 31,
    })),
    {
      name: 'same-cpl-invalid-tr-ignores-count31',
      same: true,
      count: 31,
      oldBase: 0n,
      newBase: 0n,
      oldSp: 0x9003n,
    },
    ...[false, true].flatMap((compat) =>
      [false, true].map((same) => ({
        name: `ia64-${compat ? 'compat' : 'long'}-${same ? 'same' : 'inner'}-unaligned`,
        long: true,
        compat,
        same,
        count: 31,
        memory: 'ia32e-fixed',
        oldSp: same ? 0x9003n : 0x8000n,
      })),
    ),
    ...[false, true].flatMap((same) =>
      [false, true].map((reject) => ({
        name: `ia64-${same ? 'same' : 'inner'}-${reject ? 'upper-hole-rejected' : 'first-hole-pushes-canonical'}`,
        long: true,
        same,
        reject,
        count: 31,
        highStackBase: 0x7fffffff0000n,
        ...(same
          ? { oldSp: reject ? 0xffff800000000000n : 0x800000000000n }
          : { newSp: reject ? 0xffff800000000000n : 0x800000000000n }),
      })),
    ),
    {
      name: 'ia64-compat-same-full-rsp-b16',
      long: true,
      compat: true,
      same: true,
      count: 31,
      oldBits: 16,
      oldSp: 0x7ffffffff003n,
      highStackBase: 0x7fffffff0000n,
    },
  );
  const results = [];
  for (const row of rows) results.push({ name: row.name, ...(await checkOne(side, row)) });
  return {
    oracle: {
      matrixCases: matrix ? 1024 : 0,
      cases: results.length,
      guestCalls: results.reduce((sum, row) => sum + row.calls, 0),
      coverage:
        'literal raw descriptors, all 32 counts, both slot widths, old/new SS.B, both busy TR banks, source CS.D, wrap/raw-pointer/overlap, memory banks, IA64 same/inner/compatibility/full-RSP/canonical touched spans',
      ceiling:
        'Finite imported-context CALL+matching-RETF oracle; not native hardware overlap equivalence or application coverage.',
    },
    cases: results,
  };
}

const performanceRows = [
  ...[2, 4].flatMap((width) =>
    [0, 1, 31].map((count) => ({ name: `gate-w${width}-n${count}-linear`, width, count })),
  ),
  ...['pg0', 'nonpae', 'pae'].flatMap((memory) =>
    [0, 1, 31].map((count) => ({ name: `gate-w4-n${count}-${memory}`, memory, count })),
  ),
  { name: 'gate-w4-n31-b16', count: 31, oldBits: 16, newBits: 16, newSp: 0x12349000n },
  { name: 'gate-w2-n31-tr16', width: 2, count: 31, trBits: 16 },
  { name: 'gate-w4-n1-first-accessed', accessedCold: true },
  { name: 'gate-w4-n31-debug-miss', count: 31, debug: 'miss' },
  { name: 'gate-w4-n1-debug-parameter-hit', count: 1, debug: 'hit' },
  {
    name: 'gate-w4-same-cpl-count31-ignored',
    same: true,
    count: 31,
    oldBase: 0n,
    newBase: 0n,
    oldSp: 0x9003n,
  },
  { name: 'gate-w4-conforming-count31-ignored', conforming: true, count: 31 },
  { name: 'gate-w4-n31-first-page-ad', memory: 'nonpae', pageCold: true, count: 31 },
  {
    name: 'gate-w4-n2-captured-overlap',
    kind: 'alias',
    count: 2,
    oldBase: 0n,
    newBase: 0n,
    oldSp: 0x8000n,
    newSp: 0x800cn,
  },
  { name: 'gate-w4-n1-private-page-repair', kind: 'repair', memory: 'nonpae' },
  { name: 'gate-w4-n1-short-resumes', kind: 'resume' },
  { name: 'gate-w4-n1-gate-edit-A-B-A', kind: 'gate-edit' },
  ...['ia32e-fixed', 'ia32e-physical'].flatMap((memory) =>
    [false, true].map((compat) => ({
      name: `gate-ia64-${memory}-${compat ? 'compat' : 'long'}`,
      long: true,
      compat,
      memory,
      count: 31,
    })),
  ),
  {
    name: 'gate-ia64-equal-loaded-context',
    long: true,
    same: true,
    equalContext: true,
    memory: 'ia32e-fixed',
    count: 31,
    oldSp: 0x9003n,
  },
  {
    name: 'gate-ia64-same-context',
    long: true,
    same: true,
    memory: 'ia32e-fixed',
    count: 31,
    oldSp: 0x9003n,
  },
];
export const callGateNames = performanceRows.map((row) => row.name);
const resourceKeys = [
  'compilations',
  'cacheHits',
  'nativeEntries',
  'dispatches',
  'generatedBytes',
  'pagingRestarts',
];
const timingKeys = [
  'translationMs',
  'browserCompileMs',
  'instantiationMs',
  'executionMs',
  'totalMs',
];
const zero = (keys) => Object.fromEntries(keys.map((key) => [key, 0]));
const add = (to, from) => {
  for (const key of Object.keys(to)) to[key] += from[key] ?? 0;
};
export async function measureCallGates(side, { iterations, samples, workloads }) {
  const definitions = [],
    results = [];
  for (const input of performanceRows.filter((row) => workloads.includes(row.name))) {
    const hit = input.debug === 'hit';
    const resetEach = hit || ['alias', 'repair'].includes(input.kind);
    const f = fixture(input, !resetEach),
      n = BigInt(Math.min(iterations, resetEach || input.kind === 'resume' ? 257 : 1000001));
    const creationAt = performance.now();
    const cpu = await side.createCpu({ compiler: side.compiler, ...f.config });
    const creationMs = performance.now() - creationAt;
    const original = cpu.readContext();
    const numbers = flagsNumeric(cpu);
    const retiredEach = hit
      ? 1n
      : resetEach
        ? 2n
        : noSwitch(f.row)
          ? 3n
          : input.kind === 'gate-edit'
            ? 5n
            : 4n;
    definitions.push({
      name: input.name,
      iterations: n,
      limits: LIMITS,
      descriptorAndCodeBytes: {
        gate: Array.from(
          f.ram.subarray(Number(GDT + 56n), Number(GDT + 56n) + (f.row.long ? 16 : 8)),
        ),
        code: f.code,
      },
      memoryModel: f.config.memoryModel ?? 'linear',
      paging: f.paging,
      context: original,
      effectiveWork: {
        gateCalls: n,
        matchingReturns: hit ? 0n : n,
        copiedParameters: noSwitch(f.row) || f.row.long ? 0n : n * BigInt(f.row.count),
        copiedBytes: noSwitch(f.row) || f.row.long ? 0n : n * BigInt(f.row.count * f.row.width),
        frameSlots: n * BigInt(frameExpected(f).slots),
        retiredInstructions: retiredEach * n,
        failedAttempts: input.kind === 'repair' ? n : 0n,
      },
      contextReuse:
        'same CPU/compiler/Core across first and warm samples; imported context/state rearmed outside measured run intervals',
      codeReuse:
        input.kind === 'gate-edit'
          ? 'same cached source CALL bytes; live gate target edited A to B to A outside run intervals, destination marker proves selected target'
          : 'same bytes and descriptors; no source write between samples',
      nominalOperationsPerCompletedCall: {
        scope:
          'Architectural operand/metadata operations from this literal fixture; excludes instruction fetch, translation validation, page walks and page A/D traffic. RETF reads and failed attempts are separate.',
        pointerReads: f.row.long ? 1 : 0,
        parameterReads: noSwitch(f.row) || f.row.long ? 0 : f.row.count,
        systemReads: (f.row.long ? 2 : 1) + 1 + (noSwitch(f.row) ? 0 : f.row.long ? 1 : 3),
        frameWrites: frameExpected(f).slots,
        matchingReturnStackReads: noSwitch(f.row) ? 2 : 4,
        matchingReturnDescriptorReads: noSwitch(f.row) ? 1 : 2,
      },
      descriptorCold: !!input.accessedCold,
      pagingCold: !!input.pageCold,
      firstSampleColdMeaning:
        'one CPU: sample-1 includes first execution; A/D and descriptor A first touches occur only there, warm samples retain them',
      timing:
        'elapsedMs sums awaited run calls only; wallMs also includes host rearming, repair and per-call guards; final checkpoint guards follow the wall timer. creationMs is one CPU creation, not independent cold-start sampling',
      ceiling:
        'New-behavior characterization only; no old Unsupported denominator or native/application throughput equivalence.',
    });
    try {
      for (let sample = -1; sample < samples; sample++) {
        const targetB = input.kind === 'gate-edit' && sample % 2 === 0;
        if (input.kind === 'gate-edit') {
          put(f.ram, GDT + 56n, targetB ? TARGET + 0x100n : TARGET, 2);
          cpu.writeMemory(GDT + 56n, f.ram.subarray(Number(GDT + 56n), Number(GDT + 58n)));
        }
        cpu.setContext(original);
        const state = structuredClone(f.state);
        state.registers[1] = n;
        // Debug hit isolates gate entry; the ordinary loop additionally retires return/rearm/LOOP.
        const debug = {
          addresses: [
            input.debug === 'hit'
              ? f.row.oldBase + (f.row.oldSp & mask(f.row.oldBits / 8))
              : 0x3f000n,
            0n,
            0n,
            0n,
          ],
          dr6: 0xffff0ff0n,
          dr7: input.debug ? 0xf0401n : 0x400n,
        };
        cpu.setState(state);
        cpu.setDebugState(debug);
        const ready = cpu.readState();
        const resources = zero(resourceKeys),
          timings = zero(timingKeys);
        let elapsedMs = 0,
          calls = 0,
          retired = 0n,
          result;
        const run = async (budget) => {
          const started = performance.now();
          const value = await cpu.run({ budget });
          elapsedMs += performance.now() - started;
          calls++;
          retired += value.retired;
          add(resources, value.resources);
          add(timings, value.timings);
          return value;
        };
        const wallAt = performance.now();
        if (hit)
          for (let i = 0n; i < n; i++) {
            cpu.setContext(original);
            cpu.setState(state);
            cpu.setDebugState(debug);
            result = await run(1n);
            equal(result.reason, 'debug-exception', `${input.name} exact data trap`);
            equal(result.retired, 1n, `${input.name} gate retired once`);
            equal(result.state.rip, TARGET, `${input.name} trap destination`);
          }
        else if (resetEach)
          for (let i = 0n; i < n; i++) {
            cpu.setContext(original);
            cpu.setState(state);
            if (input.kind === 'alias')
              cpu.writeMemory(
                f.row.oldSp,
                f.ram.subarray(
                  Number(f.row.oldSp),
                  Number(f.row.oldSp) + f.row.count * f.row.width,
                ),
              );
            if (input.kind === 'repair') {
              cpu.writePhysicalMemory(0x410a0n, Uint8Array.of(0, 0, 0, 0));
              const failedRam = read(cpu, f, 0n, RAM_BYTES);
              const failed = await run(1n);
              equal(failed.reason, 'page-fault', `${input.name} exact failed admission`);
              equal(failed.pageFault?.address, 0x28ffcn, `${input.name} first refused frame slot`);
              equal(failed.pageFault?.errorCode, 2, `${input.name} kernel write fault code`);
              equal(failed.retired, 0n, `${input.name} no failed retirement`);
              equal(
                failed.state.registers,
                state.registers,
                `${input.name} failed scalar atomicity`,
              );
              equal(cpu.readContext(), original, `${input.name} failed context atomicity`);
              equal(
                read(cpu, f, 0n, RAM_BYTES),
                failedRam,
                `${input.name} failed RAM/descriptor/D atomicity`,
              );
              equal(failed.state.rip, CODE, `${input.name} failed source PC`);
              equal(
                failed.state.flags,
                state.flags & ~0x10000n,
                `${input.name} failed begin-cleared RF`,
              );
              cpu.writePhysicalMemory(0x410a0n, Uint8Array.from(little(0x28067n, 4)));
            }
            result = await run(2n);
            completion(result, 2n, `${input.name} successful repair/alias roundtrip`);
          }
        else if (input.kind === 'resume')
          for (let i = 0n; i < retiredEach * n; i++) {
            result = await run(1n);
            completion(result, 1n, `${input.name} single instruction resume`);
          }
        else result = await run(retiredEach * n);
        const wallMs = performance.now() - wallAt;
        if (!hit && !resetEach && input.kind !== 'resume')
          completion(result, retiredEach * n, input.name);
        equal(retired, retiredEach * n, `${input.name} complete retired work`);
        equal(result.state.flags, state.flags & ~0x10000n, `${input.name} flags guard`);
        equal(numeric(cpu), numbers, `${input.name} numeric guard`);
        const expectedSp = hit
          ? frameExpected(f).raw
          : noSwitch(f.row) || f.row.long
            ? f.row.oldSp
            : (f.row.oldSp & mask(f.row.width)) + BigInt(f.row.count * f.row.width);
        equal(result.state.registers[4], expectedSp, `${input.name} final raw stack guard`);
        const expectedRegisters = state.registers.slice();
        expectedRegisters[4] = expectedSp;
        if (!resetEach) expectedRegisters[1] = 0n;
        if (input.kind === 'gate-edit') expectedRegisters[0] = targetB ? 0xbbbb5678n : 0xaaaa1234n;
        equal(result.state.registers, expectedRegisters, `${input.name} full GPR guard`);
        const expectedRip = hit ? TARGET : resetEach ? f.nextPc : CODE + BigInt(f.code.length);
        equal(result.state.rip, expectedRip, `${input.name} exact final PC`);
        equal(
          result.state,
          {
            ...ready,
            registers: expectedRegisters,
            flags: state.flags & ~0x10000n,
            rip: expectedRip,
          },
          `${input.name} complete scalar/event/interrupt checkpoint`,
        );
        equal(
          cpu.readContext(),
          hit ? targetContext(f, original) : original,
          `${input.name} complete context guard`,
        );
        equal(
          read(cpu, f, 0n, RAM_BYTES),
          frameExpected(f).ram,
          `${input.name} full RAM/frame guard`,
        );
        equal(
          cpu.readDebugState(),
          { ...debug, dr6: hit ? 0xffff0ff1n : debug.dr6 },
          `${input.name} complete debug bank`,
        );
        equal(
          read(cpu, f, GDT + 56n, f.row.long ? 16 : 8),
          f.ram.subarray(Number(GDT + 56n), Number(GDT + 56n) + (f.row.long ? 16 : 8)),
          `${input.name} gate bytes never A/busy`,
        );
        equal(
          read(cpu, f, CODE, f.code.length),
          Uint8Array.from(f.code),
          `${input.name} source immutable`,
        );
        if (f.paging)
          equal(
            cpu.readPagingState(),
            input.kind === 'repair' ? { ...f.paging, cr2: 0x28ffcn } : f.paging,
            `${input.name} paging bank`,
          );
        results.push({
          workload: input.name,
          sample,
          phase: sample < 0 ? 'first' : 'warm',
          creationMs,
          elapsedMs,
          wallMs,
          calls,
          retired,
          effectiveGateCalls: n,
          copiedParameters: noSwitch(f.row) || f.row.long ? 0n : n * BigInt(f.row.count),
          copiedBytes: noSwitch(f.row) || f.row.long ? 0n : n * BigInt(f.row.count * f.row.width),
          failedAttempts: input.kind === 'repair' ? n : 0n,
          resources,
          timings,
          finalGauge: result.resources,
        });
      }
    } finally {
      cpu.dispose();
    }
  }
  return { definitions, samples: results };
}
