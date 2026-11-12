// Literal raw80/status values from the independent special-form acceptance packets.
// No production decoder, arithmetic backend or execution-test helper is imported.
const ONE = 0x3fff8000000000000000n;
const INDEFINITE = 0xffffc000000000000000n;
const STATUS = 0xbaff;
const hex = (text) => Uint8Array.from(text.match(/../g) ?? [], (byte) => parseInt(byte, 16));
const put = (bytes, offset, value, width = 8) => {
  for (let i = 0; i < width; i++) bytes[offset + i] = Number((value >> BigInt(i * 8)) & 255n);
};
const check = (condition, label) => {
  if (!condition) throw Error(label);
};
const limits = {
  maxInstructions: 128,
  maxSourceBytes: 2048,
  maxArtifactBytes: 262144,
  maxCachedArtifacts: 32,
  maxCachedBytes: 4194304,
  maxTranslationsPerRun: 32,
};
const registers = (n) => {
  const result = Array.from({ length: 16 }, (_, i) => 0x1122334400000000n + BigInt(i));
  result[1] = BigInt(n);
  result[3] = 0x6000n;
  result[7] = 0x4ffbn;
  return result;
};
const state = (n) => ({
  registers: registers(n),
  rip: 0x1000n,
  flags: 2n,
  event: { kind: 'ready' },
  interruptibility: { sti: false, ss: false },
  interrupts: { irq: null, nmiPending: false, nmiBlocked: false },
});
const fp = (controlWord, tagWord, values) => ({
  registers: Array.from({ length: 8 }, (_, i) => values[i] ?? 0n),
  controlWord,
  statusWord: 0,
  tagWord,
  instructionPointer: 0n,
  dataPointer: 0x1234n,
  opcode: 0x345,
});

export const x87ExtraNames = [
  'x87-fbld-split-page',
  'x87-fbstp-split-page',
  'x87-fscale-overflow-masked',
  'x87-fscale-underflow-unmasked',
  'x87-fxtract-full-masked',
  'x87-fxtract-full-unmasked',
];

async function splitBcd(side, name, requested) {
  const store = name.includes('fbstp'),
    n = Math.min(requested, 65536);
  // FBLD [RDI]; FSTP ST(0), or FLD tbyte[RBX]; FBSTP [RDI]; DEC ECX; JNZ.
  const code = hex(store ? 'db2bdf37ffc975f8' : 'df27ddd8ffc975f8');
  const tables = new Uint8Array(0x4000);
  for (const [address, value] of [
    [0x10000, 0x11023n],
    [0x11000, 0x12023n],
    [0x12000, 0x13023n],
    [0x13008, 0x20023n],
    [0x13020, 0x30063n],
    [0x13028, 0x40063n],
    [0x13030, 0x50023n],
  ])
    put(tables, address - 0x10000, value);
  const head = new Uint8Array(7).fill(0xa5),
    tail = new Uint8Array(7).fill(0xa5);
  if (!store) {
    head.set(hex('4200000000'), 2);
    tail.set(hex('0000000080'));
  }
  const source = new Uint8Array(10);
  put(source, 0, 0x4000a000000000000000n, 10);
  const backings = [
    { id: 'tables', bytes: tables },
    { id: 'code', bytes: code },
    { id: 'head', bytes: head },
    { id: 'tail', bytes: tail },
    { id: 'source', bytes: source },
  ];
  const bases = [0x10000n, 0x20000n, 0x30ff9n, 0x40000n, 0x50000n];
  const cpu = await side.createCpu({
    compiler: side.compiler,
    limits,
    memoryModel: 'ia32e-paged',
    paging: { cr0: 0x80000033n, cr2: 0n, cr3: 0x10000n, cr4: 0x628n, efer: 0x500n },
    entry: 0x1000n,
    memoryLimits: { maxBackings: 5, maxMappings: 5, maxBackingBytes: 0x5000 },
    memory: {
      backings,
      mappings: backings.map((backing, i) => ({
        base: bases[i],
        backing: backing.id,
        offset: 0,
        length: backing.bytes.length,
        permissions: {
          read: true,
          write: i === 0 || (store && (i === 2 || i === 3)),
          execute: i === 1,
        },
      })),
    },
  });
  return {
    cpu,
    units: n,
    unit: 'completed split ten-byte BCD conversion in a balanced four-instruction loop',
    expectedRetired: BigInt(4 * n),
    prepare() {
      cpu.setState(state(n));
      cpu.setX87State(fp(0x37f, 0xffff, {}));
      if (store) {
        cpu.writePhysicalMemory(0x30ff9n, head);
        cpu.writePhysicalMemory(0x40000n, tail);
      }
    },
    validate() {
      const actual = cpu.readX87State();
      check(
        actual.tagWord === 0xffff && (actual.statusWord & STATUS) === (store ? 0x20 : 0),
        name + ' balanced stack/status',
      );
      check(
        actual.registers[7] === (store ? 0x4000a000000000000000n : 0xc004a800000000000000n),
        name + ' literal raw conversion payload',
      );
      check(
        actual.instructionPointer === 0x1002n &&
          actual.dataPointer === 0x4ffbn &&
          actual.opcode === 0x345,
        name + ' producer environment',
      );
      const expectedHead = head.slice(),
        expectedTail = tail.slice();
      if (store) {
        expectedHead.set(hex('0200000000'), 2);
        expectedTail.set(new Uint8Array(5));
      }
      for (const [address, expected] of [
        [0x30ff9n, expectedHead],
        [0x40000n, expectedTail],
        [0x50000n, source],
      ])
        check(
          cpu.readPhysicalMemory(address, expected.length).every((byte, i) => byte === expected[i]),
          name + ' complete physical guards/source',
        );
      const after = cpu.readState(),
        expectedRegisters = registers(0);
      check(
        after.rip === 0x1008n &&
          after.flags === 0x46n &&
          after.registers.every((value, i) => value === expectedRegisters[i]),
        name + ' raw scalar completion',
      );
      return {
        completedConversions: n,
        bcdPayloadBytes: 10 * n,
        additionalRaw80SourceReadBytes: store ? 10 * n : 0,
        expectedBcdFragmentsPerConversion: 2,
        fragmentGeometry:
          'five bytes before and five after linear page5000; disjoint physical pages; not access instrumentation',
        tableAD: 'all relevant A/D bits already set',
        owners: cpu.inspectTranslations(),
      };
    },
  };
}

export async function x87ExtraKernel(side, name, n) {
  if (!x87ExtraNames.includes(name)) throw Error('unknown x87 extra row: ' + name);
  if (name.endsWith('split-page')) return splitBcd(side, name, n);
  const extract = name.includes('fxtract'),
    unmasked = name.endsWith('unmasked');
  const controlWord = extract ? (unmasked ? 0x37e : 0x37f) : unmasked ? 0x36f : 0x37f;
  const values = extract
    ? Array(8).fill(ONE)
    : [
        unmasked ? 0x00018000000000000000n : 0x7ffeffffffffffffffffn,
        unmasked ? 0xbfff8000000000000000n : ONE,
      ];
  const code = hex((extract ? 'd9f4' : 'd9fd') + (unmasked ? '9b' : ''));
  const cpu = await side.createCpu({
    compiler: side.compiler,
    limits,
    code: { base: 0x1000n, bytes: code },
    ram: { base: 0x4000n, bytes: new Uint8Array(1) },
  });
  return {
    cpu,
    units: 1,
    unit: unmasked
      ? 'one exceptional producer plus one pending-consumer attempt; fixed packet'
      : 'one exceptional producer; fixed packet',
    prepare() {
      cpu.setState(state(0));
      cpu.setX87State(fp(controlWord, extract ? 0 : 0xfff0, values));
    },
    async run() {
      return cpu.run({ budget: unmasked ? 2n : 1n });
    },
    validate(result) {
      const actual = cpu.readX87State();
      const expected = [...values, ...Array(8 - values.length).fill(0n)];
      if (extract && !unmasked) {
        expected[0] = INDEFINITE;
        expected[7] = INDEFINITE;
      } else if (!extract)
        expected[0] = unmasked ? 0x60008000000000000000n : 0x7fff8000000000000000n;
      const sw = extract ? (unmasked ? 0x82c1 : 0x3a41) : unmasked ? 0x8090 : 0x228;
      const tag = extract ? (unmasked ? 0 : 0x8002) : unmasked ? 0xfff0 : 0xfff2;
      const opcode = unmasked ? (extract ? 0x1f4 : 0x1fd) : 0x345;
      check(
        result.reason === (unmasked ? 'x87-exception' : 'budget') &&
          result.retired === 1n &&
          result.repeatIterations === 0n,
        name + ' exact producer/consumer accounting',
      );
      check(
        result.remaining === (unmasked ? 1n : 0n) &&
          result.state.rip === 0x1002n &&
          result.state.flags === 2n,
        name + ' boundary',
      );
      check(
        result.state.registers.every((value, i) => value === registers(0)[i]),
        name + ' raw scalar preservation',
      );
      check(
        actual.controlWord === controlWord &&
          (actual.statusWord & STATUS) === (sw & STATUS) &&
          actual.tagWord === tag,
        name + ' defined status and tags',
      );
      check(
        actual.registers.every((value, i) => value === expected[i]),
        name + ' literal raw80 banks',
      );
      check(
        actual.instructionPointer === 0x1000n &&
          actual.dataPointer === 0x1234n &&
          actual.opcode === opcode,
        name + ' original producer environment',
      );
      if (unmasked) {
        const source = result.x87Exception;
        check(
          source?.vector === 16 &&
            source.instructionPc === 0x1002n &&
            source.pending === (extract ? 1 : 0x10),
          name + ' pending detector',
        );
        check(
          source.instructionPointer === 0x1000n && source.opcode === opcode,
          name + ' pending producer retained',
        );
      } else check(result.x87Exception === undefined, name + ' no pending exception report');
      return {
        attemptedProducers: 1,
        completedProducers: 1,
        pendingConsumerAttempts: unmasked ? 1 : 0,
        retired: result.retired,
        repeatIterations: result.repeatIterations,
        publicRuns: 1,
        resources: result.resources,
        timings: result.timings,
        owners: cpu.inspectTranslations(),
        timingCeiling:
          'fixed packet ignores requested iterations; zero/coarse clock samples have no precise per-unit latency',
      };
    },
  };
}
