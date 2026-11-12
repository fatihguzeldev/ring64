export const numericExtraNames = [
  'numeric-nm-handler-roundtrip',
  'numeric-live-control-toggle-loop',
  'numeric-osfxsr0-fx-image-pair',
  'numeric-cold-quota-nm',
];

const limits = {
  maxInstructions: 128,
  maxSourceBytes: 2048,
  maxArtifactBytes: 262144,
  maxCachedArtifacts: 8,
  maxCachedBytes: 2097152,
  maxTranslationsPerRun: 32,
};
const bank = { cr0: 0x80000033n, cr2: 0xdeadn, cr3: 0x10000n, cr4: 0x628n, efer: 0x500n };
const hex = (source) => Uint8Array.from(source.match(/../g) ?? [], (byte) => parseInt(byte, 16));
const check = (condition, message) => {
  if (!condition) throw Error(message);
};
const put = (bytes, offset, value, width = 8) => {
  for (let index = 0; index < width; index++)
    bytes[offset + index] = Number((value >> BigInt(8 * index)) & 255n);
};
const sameBank = (actual, expected, label) =>
  check(
    actual.length === expected.length && actual.every((value, i) => value === expected[i]),
    label,
  );
const xmm = () =>
  Array.from({ length: 16 }, (_, i) => 0x112233445566778899aabbccddeeff00n + BigInt(i));
const emptyX87 = () => ({
  registers: Array(8).fill(0n),
  controlWord: 0x37f,
  statusWord: 0,
  tagWord: 0xffff,
  instructionPointer: 0n,
  dataPointer: 0n,
  opcode: 0,
});
function sameX87(actual, expected, label) {
  sameBank(actual.registers, expected.registers, label + ' raw80');
  for (const field of [
    'controlWord',
    'statusWord',
    'tagWord',
    'instructionPointer',
    'dataPointer',
    'opcode',
  ])
    check(actual[field] === expected[field], label + ' ' + field);
}
function state(count, overrides = {}) {
  const registers = Array(16).fill(0n);
  registers[1] = BigInt(count);
  registers[4] = 0x9000n;
  for (const [index, value] of Object.entries(overrides)) registers[Number(index)] = value;
  return { registers, flags: 2n, rip: 0x1000n };
}
function context() {
  const data = () => ({
    selector: 16,
    base: 0n,
    limit: 0xffffffff,
    default32: true,
    usable: true,
    type: 'read-write',
    dpl: 0,
    present: true,
    conforming: false,
    accessed: true,
    long: false,
    granularity: true,
    available: false,
  });
  return {
    mode: 'long64',
    cpl: 0,
    segments: {
      cs: { ...data(), selector: 8, type: 'readable-code', default32: false, long: true },
      ss: data(),
      ds: data(),
      es: data(),
      fs: data(),
      gs: data(),
    },
    gdtr: { base: 0x6000n, limit: 0x17 },
    idtr: { base: 0x7000n, limit: 0xfff },
    ldtr: { selector: 0, valid: false, base: 0n, limit: 0, attributes: 0 },
    tr: { selector: 0, valid: false, base: 0n, limit: 0, attributes: 0 },
  };
}
async function create(side, code, controls = bank, compileLimits = {}) {
  const bytes = new Uint8Array(0x20000);
  bytes.set(hex(code), 0x1000);
  bytes.set(hex('0f0648cf'), 0x4000);
  put(bytes, 0x6008, 0x00af9b000000ffffn);
  put(bytes, 0x6010, 0x00cf93000000ffffn);
  bytes.set(hex('00400800008e00000000000000000000'), 0x7070);
  for (const [address, value] of [
    [0x10000, 0x11023n],
    [0x11000, 0x12023n],
    [0x12000, 0x13023n],
  ])
    put(bytes, address, value);
  for (let page = 0; page < 32; page++) put(bytes, 0x13000 + page * 8, BigInt(page * 4096) | 0x63n);
  return side.createCpu({
    compiler: side.compiler,
    limits: { ...limits, ...compileLimits },
    memoryModel: 'ia32e-paged',
    context: context(),
    paging: controls,
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
function assertBank(cpu, expected) {
  const actual = cpu.readPagingState();
  for (const field of ['cr0', 'cr2', 'cr3', 'cr4', 'efer'])
    check(actual[field] === expected[field], 'numeric controls retain ' + field);
  check(!('pdpte' in actual), 'IA32e has no captured legacy quartet');
}
function work(result, retired, pc) {
  check(
    result.reason === 'budget' && result.retired === BigInt(retired) && result.remaining === 0n,
    'exact completed numeric work',
  );
  check(result.repeatIterations === 0n && result.state.rip === BigInt(pc), 'numeric PC/repeat');
  check(
    result.state.event.kind === 'ready' && result.state.flags === 0x46n,
    'numeric final boundary',
  );
}
function retained(cpu) {
  let previous;
  return (result) => {
    const owners = cpu.inspectTranslations().map((artifact) => artifact.owner);
    check(
      owners.length > 0 && owners.length <= limits.maxCachedArtifacts,
      'bounded numeric owners',
    );
    if (previous) {
      check(
        result.resources.compilations === 0,
        'warm numeric control edits reuse installed owners',
      );
      sameBank(owners, previous, 'stable numeric owners');
    }
    previous = owners;
    return {
      retired: result.retired,
      resources: result.resources,
      timings: result.timings,
      residentOwners: owners.length,
      ownership: 'one context with live numeric admission; no numeric-control artifact keys',
    };
  };
}

export async function numericExtraKernel(side, name, requested) {
  if (!numericExtraNames.includes(name)) throw Error('unknown numeric extra workload');
  if (!Number.isSafeInteger(requested) || requested < 1) throw Error('invalid numeric iterations');
  const n = Math.min(requested, name === 'numeric-nm-handler-roundtrip' ? 256 : 2048);
  if (name === 'numeric-nm-handler-roundtrip' || name === 'numeric-live-control-toggle-loop') {
    const handler = name === 'numeric-nm-handler-roundtrip';
    // TS-set/FLD1/FSTP loop: seven source instructions plus CLTS/IRETQ per iteration.
    // Toggle loop: TS-set/CLTS, OSFXSR-off/on, PXOR/FNOP and DEC/JNZ: thirteen instructions.
    const code = handler
      ? '0f20c083c8080f22c0d9e8ddd8ffc975ef'
      : '0f20c083c8080f22c00f060f20e025fffdffff0f22e00d000200000f22e0660fefc0d9d0ffc975d8';
    const cpu = await create(side, code),
      retain = retained(cpu),
      retired = (handler ? 9 : 13) * n;
    return {
      cpu,
      units: n,
      unit: handler ? 'completed NM CLTS IRETQ retry' : 'guest numeric-control toggle iteration',
      prepare() {
        cpu.setPagingState(bank);
        cpu.setX87State(emptyX87());
        cpu.setXmmState(xmm());
        cpu.setMxcsr(0x1f80);
        cpu.setState(state(n));
      },
      run() {
        return cpu.run({
          budget: BigInt(retired),
          repeatBudget: 0n,
          ...(handler ? { eventDelivery: { budget: BigInt(n) } } : {}),
        });
      },
      validate(result) {
        work(result, retired, handler ? 0x1011 : 0x1028);
        const expectedRegisters = state(0).registers;
        expectedRegisters[0] = handler ? 0x8000003bn : 0x628n;
        sameBank(result.state.registers, expectedRegisters, 'numeric complete GPR bank');
        const expectedX87 = emptyX87();
        expectedX87.instructionPointer = handler ? 0x100bn : 0x1022n;
        if (handler) expectedX87.registers[7] = 0x3fff8000000000000000n;
        sameX87(cpu.readX87State(), expectedX87, 'numeric loop');
        const expectedXmm = xmm();
        if (!handler) expectedXmm[0] = 0n;
        sameBank(cpu.readXmmState(), expectedXmm, 'numeric XMM publication');
        check(cpu.readMxcsr() === 0x1f80, 'numeric loop MXCSR');
        assertBank(cpu, bank);
        if (handler) {
          check(
            result.deliveryAttempts === BigInt(n) && result.remainingDeliveryBudget === 0n,
            'one vector7 handler entry per completed roundtrip',
          );
          const frame = cpu.readPhysicalMemory(0x8fd8n, 40);
          const expected = new Uint8Array(40);
          [0x1009n, 8n, 0x10082n, 0x9000n, 16n].forEach((value, i) => put(expected, i * 8, value));
          sameBank(frame, expected, 'literal no-error vector7 frame');
        }
        return {
          ...retain(result),
          completedRoundTrips: handler ? n : 0,
          expectedAdmissionFaults: handler ? n : 0,
          deliveryAttempts: result.deliveryAttempts ?? 0n,
          expectedNumericControlChanges: (handler ? 2 : 4) * n,
        };
      },
    };
  }
  if (name === 'numeric-osfxsr0-fx-image-pair') {
    const disabled = { ...bank, cr4: 0x428n },
      cpu = await create(side, '480fae07480fae0fffc975f4', disabled),
      retain = retained(cpu),
      imageState = {
        ...emptyX87(),
        registers: Array.from({ length: 8 }, (_, i) => 0x3fff8000000000000000n + BigInt(i)),
        controlWord: 0x37e,
        statusWord: 0x8081,
        instructionPointer: 0x1122334455667788n,
        dataPointer: 0x8877665544332211n,
        opcode: 0x345,
      },
      expected = new Uint8Array(512).fill(0xa5);
    put(expected, 0, 0x37en, 2);
    put(expected, 2, 0x8081n, 2);
    expected[4] = 0;
    put(expected, 6, 0x345n, 2);
    put(expected, 8, 0x1122334455667788n);
    put(expected, 16, 0x8877665544332211n);
    put(expected, 24, 0x1f81n, 4);
    put(expected, 28, 0xffffn, 4);
    imageState.registers.forEach((value, i) => put(expected, 32 + i * 16, value, 10));
    xmm().forEach((value, i) => put(expected, 160 + i * 16, value, 16));
    return {
      cpu,
      units: n,
      unit: 'OSFXSR0 FXSAVE64 FXRSTOR64 pair',
      prepare() {
        cpu.setPagingState(disabled);
        cpu.setX87State(imageState);
        cpu.setXmmState(xmm());
        cpu.setMxcsr(0x1f81);
        cpu.writePhysicalMemory(0x5000n, new Uint8Array(512).fill(0xa5));
        cpu.setState(state(n, { 7: 0x5000n }));
      },
      run() {
        return cpu.run({ budget: BigInt(4 * n), repeatBudget: 0n });
      },
      validate(result) {
        work(result, 4 * n, 0x100c);
        sameBank(
          result.state.registers,
          state(0, { 7: 0x5000n }).registers,
          'FX complete GPR bank',
        );
        sameX87(cpu.readX87State(), imageState, 'FX preserves old x87 pending source');
        sameBank(cpu.readXmmState(), xmm(), 'FX OSFXSR0 full XMM bank');
        check(cpu.readMxcsr() === 0x1f81, 'FX OSFXSR0 MXCSR');
        sameBank(
          cpu.readPhysicalMemory(0x5000n, 512),
          expected,
          'FX defined bytes and reserved guards',
        );
        assertBank(cpu, disabled);
        return {
          ...retain(result),
          imagePairs: n,
          expectedNominalImageBytes: 1024 * n,
          note: 'nominal image span is not instrumented physical bus traffic; pending x87 remains1',
        };
      },
    };
  }
  const disabled = { ...bank, cr0: 0x8000003bn },
    cpu = await create(side, 'ffe0', disabled, { maxInstructions: 1, maxTranslationsPerRun: 1 });
  cpu.writePhysicalMemory(0x2000n, hex('d9d0'));
  return {
    cpu,
    units: 1,
    unit: 'cold quota reached numeric admission attempt',
    prepare() {
      cpu.writePhysicalMemory(0x1000n, hex('ffe0'));
      cpu.setPagingState(disabled);
      cpu.setX87State(emptyX87());
      cpu.setState(state(0, { 0: 0x2000n }));
    },
    run() {
      return cpu.run({ budget: 2n, repeatBudget: 0n });
    },
    validate(result) {
      check(
        result.reason === 'device-not-available' &&
          result.retired === 1n &&
          result.remaining === 1n,
        'cold quota retains required NM before second compilation',
      );
      check(
        result.resources.compilations === 1 && result.resources.nativeEntries === 1,
        'only cold JMP compiles and executes',
      );
      check(
        result.state.rip === 0x2000n && result.repeatIterations === 0n,
        'cold NM no failed progress',
      );
      check(
        result.deviceNotAvailable?.instructionPc === 0x2000n &&
          result.deviceNotAvailable.family === 'x87' &&
          result.deviceNotAvailable.controls.ts,
        'cold numeric provenance',
      );
      sameBank(result.state.registers, state(0, { 0: 0x2000n }).registers, 'cold NM GPR bank');
      sameX87(cpu.readX87State(), emptyX87(), 'cold NM no numeric effect');
      assertBank(cpu, disabled);
      return {
        retired: result.retired,
        admissionAttempts: 1,
        resources: result.resources,
        timings: result.timings,
        note: 'identical source-byte write deliberately makes JMP cold outside clock',
      };
    },
  };
}
