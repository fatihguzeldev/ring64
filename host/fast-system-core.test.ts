import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createCpu, type Cpu, type FastSystemState, type Options } from './index.js';

const compiler = await WebAssembly.compile(
  new Uint8Array(await readFile(new URL('../build/ring64.wasm', import.meta.url))),
);
const limits = {
  maxInstructions: 32,
  maxSourceBytes: 256,
  maxArtifactBytes: 65536,
  maxCachedArtifacts: 8,
  maxCachedBytes: 1048576,
  maxTranslationsPerRun: 8,
};
const bank = (): FastSystemState => ({
  star: 0xfff8000400000000n,
  lstar: 0xffff800000001000n,
  fmask: 0xffffffffn,
  sysenterCs: 0xffff0008n,
  sysenterEip: 0x7fffffffffffn,
  sysenterEsp: 0xffff800000000000n,
  kernelGsBase: 0xffffffffffffffffn,
});
const zero: FastSystemState = {
  star: 0n,
  lstar: 0n,
  fmask: 0n,
  sysenterCs: 0n,
  sysenterEip: 0n,
  sysenterEsp: 0n,
  kernelGsBase: 0n,
};
const mapping = {
  base: 0x8000000000000n,
  backing: 'guard',
  offset: 0,
  length: 16,
  permissions: { read: true, write: true, execute: true },
};
function options(fastSystem?: FastSystemState): Options {
  return {
    compiler,
    limits,
    memoryModel: 'ia32e-paged',
    paging: { cr0: 0x80010033n, cr2: 0x123456789abcdef0n, cr3: 0x1000n, cr4: 0x628n, efer: 0x501n },
    ...(fastSystem === undefined ? {} : { fastSystem }),
    entry: 0x400000n,
    memoryLimits: { maxBackings: 1, maxBackingBytes: 16, maxMappings: 1 },
    memory: {
      backings: [{ id: 'guard', bytes: Uint8Array.from({ length: 16 }, (_, i) => i) }],
      mappings: [mapping],
    },
  };
}
function otherState(cpu: Cpu) {
  return {
    scalar: cpu.readState(),
    context: cpu.readContext(),
    paging: cpu.readPagingState(),
    debug: cpu.readDebugState(),
    x87: cpu.readX87State(),
    xmm: cpu.readXmmState(),
    mxcsr: cpu.readMxcsr(),
    bytes: cpu.readPhysicalMemory(mapping.base, 16),
  };
}

test('real core transports a detached fast-system bank without walking any pointer or root', async () => {
  const cpu = await createCpu(options());
  try {
    assert.deepEqual(cpu.readFastSystemState(), zero);
    const before = otherState(cpu);
    const source = bank();
    cpu.setFastSystemState(source);
    source.lstar = 0n;
    assert.deepEqual(cpu.readFastSystemState(), bank());
    assert.deepEqual(otherState(cpu), before);
    const detached = cpu.readFastSystemState();
    detached.kernelGsBase = 0n;
    assert.deepEqual(cpu.readFastSystemState(), bank());
  } finally {
    cpu.dispose();
  }
  const explicit = await createCpu(options(bank()));
  try {
    assert.deepEqual(explicit.readFastSystemState(), bank());
    assert.equal(explicit.readPagingState().efer, 0x501n);
  } finally {
    explicit.dispose();
  }
});

test('real normalized-bank rejection is atomic for reserved fields and every noncanonical pointer', async () => {
  const cpu = await createCpu(options(bank()));
  const invalid: Partial<FastSystemState>[] = [
    { star: bank().star | 1n },
    { fmask: 0x100000000n },
    { sysenterCs: 0x100000000n },
  ];
  for (const field of ['lstar', 'sysenterEip', 'sysenterEsp', 'kernelGsBase'] as const)
    for (const value of [0x800000000000n, 0xffff7fffffffffffn]) invalid.push({ [field]: value });
  try {
    const before = otherState(cpu);
    for (const changed of invalid) {
      assert.throws(() => cpu.setFastSystemState({ ...bank(), ...changed }), TypeError);
      assert.deepEqual(cpu.readFastSystemState(), bank());
      assert.deepEqual(otherState(cpu), before);
      await assert.rejects(createCpu(options({ ...bank(), ...changed })), TypeError);
    }
  } finally {
    cpu.dispose();
  }
});

test('real fast-system repair preserves a frozen PF source and unrelated bank, queue and shadow state', async () => {
  const cpu = await createCpu(options());
  try {
    cpu.setState({
      registers: Array.from({ length: 16 }, (_, i) => 0x1122334400000000n + BigInt(i)),
      flags: 0x202n,
      rip: 0x400000n,
      interruptibility: { sti: false, ss: true },
      event: {
        kind: 'pending',
        exception: {
          vector: 14,
          instructionPc: 0x3fff70n,
          returnPc: 0x400000n,
          savedFlags: 0x10202n,
          errorCode: 6,
          pageFaultAddress: 0x501000n,
        },
      },
      interrupts: { irq: 0x31, nmiPending: true, nmiBlocked: true },
    });
    const before = otherState(cpu);
    cpu.setFastSystemState(bank());
    assert.deepEqual(otherState(cpu), before);
    assert.deepEqual(cpu.readFastSystemState(), bank());
    const result = await cpu.run({ budget: 1n });
    assert.equal(result.reason, 'pending-exception');
    assert.equal(result.retired, 0n);
    assert.deepEqual(result.state, before.scalar);
    assert.deepEqual(cpu.readFastSystemState(), bank());
  } finally {
    cpu.dispose();
  }
});

test('real SS-deferred checkpoint survives fast-system repair independently of the current debug bank', async () => {
  const cpu = await createCpu(options(bank()));
  try {
    cpu.setState({
      ...cpu.readState(),
      interruptibility: { sti: false, ss: true },
      debugContinuation: { breakpoints: 5, originPc: 0x3fff00n },
    });
    const before = otherState(cpu);
    cpu.setFastSystemState({ ...bank(), fmask: 0n, kernelGsBase: 0x7000n });
    assert.deepEqual(otherState(cpu), before);
    assert.deepEqual(cpu.readFastSystemState(), { ...bank(), fmask: 0n, kernelGsBase: 0x7000n });
  } finally {
    cpu.dispose();
  }
});

test('real scalar, context, paging, mapping and memory administration preserve the fast-system authority', async () => {
  const cpu = await createCpu(options(bank()));
  try {
    cpu.setState({ ...cpu.readState(), rip: 0x500000n });
    assert.deepEqual(cpu.readFastSystemState(), bank());
    cpu.setContext(cpu.readContext());
    assert.deepEqual(cpu.readFastSystemState(), bank());
    cpu.setPagingState({ ...cpu.readPagingState(), cr2: 0x800000000000n, efer: 0xd01n });
    assert.deepEqual(cpu.readFastSystemState(), bank());
    cpu.setMappings([mapping]);
    assert.deepEqual(cpu.readFastSystemState(), bank());
    cpu.writePhysicalMemory(mapping.base + 7n, Uint8Array.of(0x91));
    assert.deepEqual(cpu.readFastSystemState(), bank());
    assert.deepEqual(cpu.readPhysicalMemory(mapping.base + 6n, 3), Uint8Array.of(6, 0x91, 8));
  } finally {
    cpu.dispose();
  }
});
