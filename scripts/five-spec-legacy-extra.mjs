// New behavior characterization, not an executable-old-baseline comparison.
const limits = {
  maxInstructions: 128,
  maxSourceBytes: 2048,
  maxArtifactBytes: 262144,
  maxCachedArtifacts: 32,
  maxCachedBytes: 4194304,
  maxTranslationsPerRun: 32,
};
const hex = (source) => Uint8Array.from(source.match(/../g) ?? [], (b) => parseInt(b, 16));
const check = (condition, message) => {
  if (!condition) throw Error(message);
};
const put = (bytes, offset, value, width = 8) => {
  for (let i = 0; i < width; i++) bytes[offset + i] = Number((value >> BigInt(i * 8)) & 255n);
};
const loop = (body) => {
  const bytes = hex(body);
  return Uint8Array.of(...bytes, 0xff, 0xc9, 0x75, 256 - bytes.length - 4, 0x82);
};

export const legacyExtraNames = [
  'legacy32-pse36-4m-rmw',
  'legacy-pae-2m-rmw',
  'legacy-pae-same-root-cr3-capture',
  'legacy-pae-pse-toggle-capture',
];

function context32() {
  const data = () => ({
    selector: 0x10,
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
    mode: 'protected',
    cpl: 0,
    segments: {
      cs: { ...data(), selector: 8, type: 'readable-code' },
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

export async function legacyExtraKernel(side, name, requested) {
  check(legacyExtraNames.includes(name), 'unknown extra legacy workload');
  check(Number.isSafeInteger(requested) && requested > 0, 'positive explicit iteration count');
  const pse36 = name === 'legacy32-pse36-4m-rmw',
    sameRoot = name === 'legacy-pae-same-root-cr3-capture',
    toggle = name === 'legacy-pae-pse-toggle-capture',
    writer = sameRoot || toggle,
    n = writer ? Math.min(requested, 64) : requested,
    instructions = sameRoot ? 4 : toggle ? 6 : 3,
    code = loop(sameRoot ? '0f22d80f20da' : toggle ? '0f22e00f20e20f22e30f20e6' : 'ff03'),
    source = new Uint8Array(0x30000),
    data = new Uint8Array(16).fill(0xa5),
    dataBase = pse36 ? 0x100000000n : 0x400000n,
    dataLinear = pse36 ? 0x400004n : 0x200004n,
    leaf = pse36 ? 0x10004n : 0x12008n,
    leafWord = pse36 ? 0x20e3n : 0x4000e3n;
  source.set(code, 0x20000);
  let bank;
  if (pse36) {
    put(source, 0x10000, 0x11023n, 4);
    put(source, 0x10004, 0x20e3n, 4);
    put(source, 0x11004, 0x20023n, 4);
    bank = { cr0: 0x80000033n, cr2: 0xdeadn, cr3: 0x10000n, cr4: 0x618n, efer: 0n };
  } else {
    put(source, 0x14000, 0x12001n);
    put(source, 0x12000, 0x13023n);
    put(source, 0x12008, 0x4000e3n);
    put(source, 0x13008, 0x20023n);
    bank = {
      cr0: 0x80000033n,
      cr2: 0xdeadn,
      cr3: 0x14000n,
      cr4: 0x628n,
      efer: 0n,
      pdpte: [0x12001n, 0n, 0n, 0n],
    };
  }
  const cpu = await side.createCpu({
    compiler: side.compiler,
    limits: {
      ...limits,
      maxTranslationsPerRun: writer ? 6 * n + 16 : limits.maxTranslationsPerRun,
    },
    memoryModel: 'physical',
    context: context32(),
    paging: bank,
    entry: 0x1000n,
    memoryLimits: { maxBackings: 2, maxMappings: 2, maxBackingBytes: source.length + data.length },
    memory: {
      backings: [
        { id: 'source', bytes: source },
        { id: 'data', bytes: data },
      ],
      mappings: [
        {
          base: 0n,
          backing: 'source',
          offset: 0,
          length: source.length,
          permissions: { read: true, write: true, execute: true },
        },
        {
          base: dataBase,
          backing: 'data',
          offset: 0,
          length: data.length,
          permissions: { read: true, write: true, execute: false },
        },
      ],
    },
  });
  let validated = false;
  return {
    cpu,
    units: n,
    unit: writer
      ? 'complete control-write/readback loop iteration; capped at64'
      : 'warm large-page prepared dword RMW',
    expectedRetired: BigInt(instructions * n),
    prepare() {
      const registers = Array(16).fill(0n);
      registers[1] = BigInt(n);
      registers[0] = sameRoot ? 0x14000n : toggle ? 0x638n : 0n;
      registers[3] = toggle ? 0x628n : dataLinear;
      cpu.setState({ registers, rip: 0x1000n, flags: 2n });
      if (!writer) cpu.writePhysicalMemory(dataBase + 4n, new Uint8Array(4));
    },
    async run() {
      return cpu.run({ budget: BigInt(instructions * n), repeatBudget: 0n });
    },
    validate(result) {
      const firstInvocation = !validated,
        expectedEntries = writer ? (toggle ? 4 : 2) * n + 1 : 1,
        expectedCompilations = writer
          ? (toggle ? 2 : 1) * n + (firstInvocation ? 1 : 0)
          : firstInvocation ? 1 : 0,
        state = result.state,
        controls = cpu.readPagingState(),
        output = cpu.readPhysicalMemory(dataBase, 16),
        expected = data.slice();
      check(
        result.reason === 'budget' && result.retired === BigInt(instructions * n) &&
          result.remaining === 0n && result.repeatIterations === 0n &&
          result.remainingRepeatBudget === 0n,
        name + ' exact work and allowance',
      );
      check(
        result.resources.nativeEntries === expectedEntries &&
          result.resources.compilations === expectedCompilations &&
          result.resources.cacheHits === expectedEntries - expectedCompilations &&
          result.resources.dispatches === expectedEntries - 1 &&
          result.resources.pagingRestarts === 0,
        name + ' exact native entry compilation and dispatch work',
      );
      if (!writer) put(expected, 4, BigInt(n), 4);
      check(output.every((byte, i) => byte === expected[i]), name + ' complete guarded bytes');
      check(state.rip === 0x1000n + BigInt(code.length - 1), name + ' exact final PC');
      check(state.registers[1] === 0n && state.flags === 0x46n, name + ' DEC/JNZ completion');
      check(
        controls.cr0 === bank.cr0 && controls.cr2 === 0xdeadn && controls.cr3 === bank.cr3 &&
          controls.cr4 === bank.cr4 && controls.efer === 0n,
        name + ' unchanged final controls',
      );
      const entry = cpu.readPhysicalMemory(leaf, pse36 ? 4 : 8);
      check(
        new DataView(entry.buffer, entry.byteOffset, entry.byteLength)[
          pse36 ? 'getUint32' : 'getBigUint64'
        ](0, true) === (pse36 ? Number(leafWord) : leafWord),
        name + ' warm accessed/dirty leaf unchanged',
      );
      if (sameRoot) check(state.registers[2] === 0x14000n, name + ' CR3 readback');
      if (toggle)
        check(
          state.registers[2] === 0x638n && state.registers[6] === 0x628n,
          name + ' both CR4 readbacks',
        );
      if (!pse36) {
        check(
          controls.pdpte.join(',') === '73729,0,0,0',
          name + ' captured quartet unchanged',
        );
        const root = cpu.readPhysicalMemory(0x14000n, 32);
        check(
          root.every((byte, i) => byte === source[0x14000 + i]),
          name + ' quartet RAM receives no A/D writes',
        );
      }
      validated = true;
      return {
        retired: result.retired,
        repeatIterations: result.repeatIterations,
        resources: result.resources,
        timings: result.timings,
        family: pse36 ? 'nonPAE-PSE36-4MiB' : 'legacyPAE',
        requestedIterations: requested,
        effectiveIterations: n,
        loopInstructions: instructions,
        controlWrites: writer ? (toggle ? 2 : 1) * n : 0,
        controlReadbacks: writer ? (toggle ? 2 : 1) * n : 0,
        expectedPdpteLoads: writer ? (toggle ? 2 : 1) * n : 0,
        expectedPdpteSlotReads: writer ? (toggle ? 8 : 4) * n : 0,
        expectedPdpteReadBytes: writer ? (toggle ? 64 : 32) * n : 0,
        largeLeafBytes: writer ? undefined : pse36 ? 4194304 : 2097152,
        dataPhysicalAddress: writer ? undefined : dataBase + 4n,
        dataLinearAddress: writer ? undefined : dataLinear,
        warmLeafAccessedDirty: true,
        nativeWalkBoundaryReference: {
          test: 'family_specialization_preserves_literal_entry_access_traces_and_geometry',
          scope: 'native entry-access callback traces for4KiB leaves; not full-engine physical counters',
          entryWidth: pse36 ? 4 : 8,
          warmReadCallbacks: 2,
          coldReadAndUpdateCallbacks: 4,
          coldFetchCoherenceCallbacks: 7,
          capturedPdpteRamCallbacks: 0,
        },
        expectedResourceWork: {
          nativeEntries: expectedEntries,
          compilations: expectedCompilations,
        },
        ownerWarmth: writer ? 'each guest writer destructively fences; public compilation included' :
          'source and data A/D preseeded; first invocation still compiles the generated unit',
        clockCeiling: n < 32
          ? 'tiny checked batch; clock-floor observations are not latency estimates'
          : 'synthetic checked batch; compare repeated samples and report timer uncertainty',
      };
    },
  };
}
