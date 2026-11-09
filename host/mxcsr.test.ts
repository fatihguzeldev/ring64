import assert from 'node:assert/strict';
import test from 'node:test';
import { Core } from './core.js';
import { createCpu } from './cpu.js';
import { captureInitialMemory } from './memory.js';

const options = () => ({
  compiler: new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)),
  code: { base: 0x1000n, bytes: Uint8Array.of(0x90) },
  ram: { base: 0x8000n, bytes: new Uint8Array(1) },
  limits: {
    maxInstructions: 32,
    maxSourceBytes: 256,
    maxArtifactBytes: 65536,
    maxCachedArtifacts: 8,
    maxCachedBytes: 1048576,
    maxTranslationsPerRun: 8,
  },
});
const layout = {
  size: 560,
  scalarSize: 176,
  registers: 0,
  flags: 128,
  rip: 136,
  remaining: 144,
  repeatRemaining: 168,
  interruptibility: 164,
  interruptibilityBytes: 4,
  xmm: 176,
  xmmBytes: 256,
  vectorScratch: 432,
  mxcsr: 448,
  mxcsrBytes: 4,
  x87: {
    offset: 456,
    bytes: 104,
    registers: 0,
    registerBytes: 10,
    controlWord: 80,
    statusWord: 82,
    tagWord: 84,
    opcode: 86,
    instructionPointer: 88,
    dataPointer: 96,
  },
  reasons: ['dispatch', 'simd-exception', 'general-protection'],
};
async function fixture(
  descriptor = layout,
  statePointer = 8192,
  memory = new WebAssembly.Memory({ initial: 1 }),
  missing?: string,
  inputPointer = 512,
) {
  let disposed = 0,
    imports = 0,
    inputLength = 0;
  const info = new TextEncoder().encode(JSON.stringify(descriptor));
  new Uint8Array(memory.buffer, 4096, info.length).set(info);
  const methods: Record<string, unknown> = {
    memory,
    core_input(length: number) {
      inputLength = length;
      return inputPointer | 0;
    },
    core_info_ptr: () => 4096,
    core_info_len: () => info.length,
    core_state_ptr: () => statePointer | 0,
    core_init_mapped: () => 0,
    core_dispose() {
      disposed++;
    },
    core_import_mxcsr() {
      assert.equal(inputLength, 4);
      imports++;
      new Uint8Array(memory.buffer, statePointer + descriptor.mxcsr, 4).set(
        new Uint8Array(memory.buffer, inputPointer, 4),
      );
      return 0;
    },
  };
  const original = WebAssembly.instantiate;
  WebAssembly.instantiate = (async () => ({
    exports: new Proxy(methods, {
      get(target, key) {
        if (key === missing) return undefined;
        return Reflect.get(target, key) ?? (() => 0);
      },
    }),
  })) as unknown as typeof original;
  try {
    const input = options();
    return {
      core: await Core.create(input.compiler, captureInitialMemory(input)),
      disposed: () => disposed,
      imports: () => imports,
      memory,
    };
  } catch (error) {
    return { error, disposed: () => disposed, imports: () => imports, memory };
  } finally {
    WebAssembly.instantiate = original;
  }
}

test('MXCSR transport is four little endian bytes and rejects invalid state before publication', async () => {
  const f = await fixture();
  assert.ok(f.core);
  const { core, memory } = f;
  for (const value of [0, 0x1f80, 0xffff, -0]) {
    core.setMxcsr(value);
    assert.equal(core.readMxcsr(), value === 0 ? 0 : value);
  }
  core.setMxcsr(0xa5c3);
  assert.deepEqual(new Uint8Array(memory.buffer, 8192 + 448, 4), Uint8Array.of(0xc3, 0xa5, 0, 0));
  const before = f.imports();
  for (const value of [NaN, Infinity, -1, 65536, 1.5, '1', 1n, null, {}, new Number(1)])
    assert.throws(() => core.setMxcsr(value as number), TypeError);
  assert.equal(f.imports(), before);
  assert.equal(core.readMxcsr(), 0xa5c3);
  core.dispose();
});

test('MXCSR layout rejects overlapping or malformed extents and disposes the initialized core', async () => {
  for (const descriptor of [
    { ...layout, mxcsr: 447 },
    { ...layout, mxcsrBytes: 3 },
    { ...layout, size: 451 },
    { ...layout, mxcsr: NaN },
    { ...layout, mxcsr: 0x100000000 },
  ]) {
    const f = await fixture(descriptor);
    assert.ok(f.error instanceof Error);
    assert.equal(f.disposed(), 1);
    assert.equal(f.imports(), 0);
  }
  const past = await fixture(layout, 65536 - 455);
  assert.ok(past.error instanceof RangeError);
  assert.equal(past.disposed(), 1);
  const missing = await fixture(layout, 8192, undefined, 'core_import_mxcsr');
  assert.match(String(missing.error), /core_import_mxcsr/);
});

test('MXCSR transport retains unsigned high wasm32 pointers and an exact-end extent', async () => {
  const memory = new WebAssembly.Memory({ initial: 32769 }),
    pointer = memory.buffer.byteLength - layout.size;
  assert.ok(pointer > 0x7fffffff);
  const f = await fixture(layout, pointer, memory, undefined, pointer - 512);
  assert.ok(f.core);
  f.core.setMxcsr(0xffff);
  assert.equal(f.core.readMxcsr(), 0xffff);
  f.core.dispose();
});

async function cpuFixture() {
  let value = 0x1f80,
    imports = 0;
  const state = { registers: Array<bigint>(16).fill(7n), flags: 0xcd7n, rip: 0x1000n };
  const bank = Array<bigint>(16).fill(0xa5n);
  const engine = {
    readMxcsr: () => value,
    setMxcsr(next: number) {
      value = next;
      imports++;
    },
    snapshot: () => structuredClone(state),
    readXmmState: () => [...bank],
    clearFault() {},
    boundaryObserved: () => false,
    current: () => ({ rip: 0x1000n, remaining: 1n, repeatRemaining: 0n }),
    probe: () => 'dispatch',
    compile: () => ({
      bytes: Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0),
      metadata: {
        entries: [0x1000n],
        instructionCount: 1,
        blockCount: 1,
        sourceBytes: 1,
        owner: 1n,
        contextVersion: 0n,
        dependencies: [],
        byteLength: 8,
      },
    }),
    dispose() {},
    valid: () => true,
    release() {},
  };
  const original = Core.create;
  Core.create = async () => engine as unknown as Core;
  try {
    return { cpu: await createCpu(options()), imports: () => imports, state, bank };
  } finally {
    Core.create = original;
  }
}

test('public MXCSR methods validate by value and preserve scalar and XMM projections', async () => {
  const { cpu, imports, state, bank } = await cpuFixture();
  try {
    assert.equal(cpu.readMxcsr(), 0x1f80);
    cpu.setMxcsr(0xffff);
    assert.equal(cpu.readMxcsr(), 0xffff);
    let coercions = 0;
    const invalid = {
      valueOf() {
        coercions++;
        return 1;
      },
    };
    for (const value of [invalid, '1', 1n, NaN, Infinity, -1, 65536, 1.1])
      assert.throws(() => cpu.setMxcsr(value as number), TypeError);
    assert.equal(coercions, 0);
    assert.equal(imports(), 1);
    assert.equal(cpu.readMxcsr(), 0xffff);
    assert.deepEqual(cpu.readState(), state);
    assert.deepEqual(cpu.readXmmState(), bank);
  } finally {
    cpu.dispose();
  }
  assert.throws(() => cpu.readMxcsr(), /disposed/);
  assert.throws(() => cpu.setMxcsr(0), /disposed/);
});

test('pending compilation and failed lifecycle reject MXCSR reads and imports', async () => {
  const { cpu, imports } = await cpuFixture();
  const compile = WebAssembly.compile;
  let rejectCompile!: (reason: Error) => void;
  WebAssembly.compile = () =>
    new Promise((_resolve, reject) => {
      rejectCompile = reject;
    });
  try {
    const running = cpu.run({ budget: 1n, repeatBudget: 0n });
    assert.throws(() => cpu.readMxcsr(), /running/);
    assert.throws(() => cpu.setMxcsr(3), /running/);
    assert.equal(imports(), 0);
    rejectCompile(new Error('controlled compile failure'));
    await assert.rejects(running, /engine failed/);
    assert.throws(() => cpu.readMxcsr(), /failed/);
    assert.throws(() => cpu.setMxcsr(3), /failed/);
    assert.equal(imports(), 0);
  } finally {
    WebAssembly.compile = compile;
    cpu.dispose();
  }
});
