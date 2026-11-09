import assert from 'node:assert/strict';
import test from 'node:test';
import { captureXmmState, Core, type Interruptibility } from './core.js';
import { createCpu } from './cpu.js';
import { captureInitialMemory } from './memory.js';

const limits = {
  maxInstructions: 32,
  maxSourceBytes: 256,
  maxArtifactBytes: 65536,
  maxCachedArtifacts: 8,
  maxCachedBytes: 1048576,
  maxTranslationsPerRun: 8,
};
const options = () => ({
  compiler: new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)),
  code: { base: 0x1000n, bytes: Uint8Array.of(0x90) },
  ram: { base: 0x8000n, bytes: new Uint8Array(1) },
  limits,
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
  reasons: ['dispatch', 'alignment-fault'],
};

async function mockedCore(
  descriptor = layout,
  statePointer = 8192,
  memory = new WebAssembly.Memory({ initial: 1 }),
  missing?: string,
  inputPointer = 512,
) {
  let disposed = 0;
  let initialized = 0;
  let imported = 0;
  let inputLength = 0;
  const infoPointer = 4096;
  const json = new TextEncoder().encode(JSON.stringify(descriptor));
  new Uint8Array(memory.buffer, infoPointer, json.length).set(json);
  const methods: Record<string, unknown> = {
    memory,
    core_input(length: number) {
      inputLength = length;
      return inputPointer;
    },
    core_info_ptr: () => infoPointer,
    core_info_len: () => json.length,
    core_state_ptr: () => statePointer | 0,
    core_init_mapped() {
      initialized++;
      return 0;
    },
    core_dispose() {
      disposed++;
    },
    core_import_xmm() {
      imported++;
      assert.equal(inputLength, 256);
      new Uint8Array(memory.buffer, statePointer + descriptor.xmm, 256).set(
        new Uint8Array(memory.buffer, inputPointer, 256),
      );
      return 0;
    },
    core_import_state() {
      assert.equal(inputLength, 176);
      new Uint8Array(memory.buffer, statePointer, 144).set(
        new Uint8Array(memory.buffer, inputPointer, 144),
      );
      new Uint8Array(memory.buffer, statePointer + 164, 4).set(
        new Uint8Array(memory.buffer, inputPointer + 164, 4),
      );
      return 0;
    },
  };
  const exports = new Proxy(methods, {
    get(target, property) {
      if (property === missing) return undefined;
      return Reflect.get(target, property) ?? (() => 0);
    },
  });
  const instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = (async () => ({ exports })) as unknown as typeof instantiate;
  try {
    const input = options();
    const core = await Core.create(input.compiler, captureInitialMemory(input));
    return {
      core,
      memory,
      imported: () => imported,
      disposed: () => disposed,
      initialized: () => initialized,
    };
  } catch (error) {
    return {
      error,
      imported: () => imported,
      disposed: () => disposed,
      initialized: () => initialized,
    };
  } finally {
    WebAssembly.instantiate = instantiate;
  }
}

test('XMM capture reads array length and each slot once and rejects incomplete or invalid banks', () => {
  let lengthReads = 0;
  const reads = Array<number>(16).fill(0);
  const source = new Proxy(Array<bigint>(16).fill(0n), {
    get(target, property, receiver) {
      if (property === 'length') lengthReads++;
      if (typeof property === 'string' && /^\d+$/.test(property)) reads[Number(property)]!++;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  assert.deepEqual(captureXmmState(source), Array<bigint>(16).fill(0n));
  assert.equal(lengthReads, 1);
  assert.deepEqual(reads, Array<number>(16).fill(1));
  for (const value of [-1n, 1n << 128n, 1, '1', null, undefined]) {
    const bank = Array<bigint>(16).fill(0n);
    bank[15] = value as bigint;
    assert.throws(() => captureXmmState(bank), TypeError);
  }
  for (const source of [[], new Array(16), {}, Array<bigint>(17).fill(0n)])
    assert.throws(() => captureXmmState(source as bigint[]), TypeError);
  const bounds = Array<bigint>(16).fill((1n << 128n) - 1n);
  assert.deepEqual(captureXmmState(bounds), bounds);
});

test('XMM transport is little endian, owns snapshots, and keeps scalar imports at 176 bytes', async () => {
  const fixture = await mockedCore();
  assert.ok(fixture.core);
  const { core, memory } = fixture;
  const bank = Array.from(
    { length: 16 },
    (_, index) => (BigInt(index + 1) << 120n) | (0x1122334455667788n << 64n) | BigInt(index + 1),
  );
  core.setXmmState(bank);
  assert.deepEqual(core.readXmmState(), bank);
  assert.deepEqual(
    new Uint8Array(memory.buffer, 8192 + 176, 16),
    Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11 | 1),
  );
  const snapshot = core.readXmmState();
  snapshot[0] = 0n;
  assert.deepEqual(core.readXmmState(), bank);
  core.setState({ registers: Array<bigint>(16).fill(9n), flags: 2n, rip: 0x1000n });
  assert.deepEqual(core.readXmmState(), bank);
  assert.throws(() => core.setXmmState([...bank.slice(0, 15), -1n]), TypeError);
  assert.equal(fixture.imported(), 1);
  assert.deepEqual(core.readXmmState(), bank);
  core.dispose();
});

test('XMM layout rejects incompatible extents and cleans up the initialized core', async () => {
  for (const descriptor of [
    { ...layout, xmm: 175 },
    { ...layout, xmmBytes: 255 },
    { ...layout, size: 431 },
    { ...layout, scalarSize: 448 },
    { ...layout, xmm: 193 },
    { ...layout, vectorScratch: 431 },
    { ...layout, interruptibility: 160 },
    { ...layout, interruptibilityBytes: 8 },
  ]) {
    const fixture = await mockedCore(descriptor);
    assert.ok(fixture.error instanceof Error);
    assert.equal(fixture.disposed(), 1);
    assert.equal(fixture.imported(), 0);
  }
  const outside = await mockedCore(layout, 65536 - 447);
  assert.ok(outside.error instanceof RangeError);
  assert.equal(outside.disposed(), 1);
  for (const name of ['core_import_xmm', 'core_vector_load', 'core_vector_store']) {
    const missing = await mockedCore(layout, 8192, undefined, name);
    assert.match(String(missing.error), new RegExp(name));
    assert.equal(missing.imported(), 0);
  }
});

test('scalar boundary transport uses existing padding and returns detached snapshots', async () => {
  const fixture = await mockedCore();
  assert.ok(fixture.core);
  const { core, memory } = fixture;
  try {
    for (const [interruptibility, bits] of [
      [{ sti: false, ss: false }, 0],
      [{ sti: true, ss: false }, 1],
      [{ sti: false, ss: true }, 2],
    ] as [Interruptibility, number][]) {
      core.setState({
        registers: Array<bigint>(16).fill(9n),
        flags: 0x202n,
        rip: 0x1000n,
        interruptibility,
      });
      assert.equal(new DataView(memory.buffer).getUint32(8192 + 164, true), bits);
      const snapshot = core.snapshot();
      assert.deepEqual(snapshot.interruptibility, interruptibility);
      snapshot.interruptibility.sti = !snapshot.interruptibility.sti;
      snapshot.registers[0] = 99n;
      assert.deepEqual(core.snapshot().interruptibility, interruptibility);
      assert.equal(core.snapshot().registers[0], 9n);
    }
    core.setState({ registers: Array<bigint>(16).fill(1n), flags: 2n, rip: 0x2000n });
    assert.deepEqual(core.snapshot().interruptibility, { sti: false, ss: false });
  } finally {
    core.dispose();
  }
});

test('required arithmetic and boundary helpers reject construction before core initialization', async () => {
  for (const name of [
    'core_multiply_high',
    'core_divide',
    'core_divide_failed',
    'core_flags',
    'core_debug_step',
  ]) {
    const missing = await mockedCore(layout, 8192, undefined, name);
    missing.core?.dispose();
    assert.match(String(missing.error), new RegExp(name));
    assert.equal(missing.initialized(), 0);
    assert.equal(missing.disposed(), 0);
    assert.equal(missing.imported(), 0);
  }
});

test('unsigned wasm32 XMM transport supports an extent ending at private memory end above 2GiB', async () => {
  const memory = new WebAssembly.Memory({ initial: 32769 });
  const pointer = memory.buffer.byteLength - layout.size;
  assert.ok(pointer > 0x7fffffff);
  const fixture = await mockedCore(layout, pointer, memory, undefined, pointer - 512);
  assert.ok(fixture.core);
  const bank = Array.from({ length: 16 }, (_, index) => BigInt(index) << 120n);
  fixture.core.setXmmState(bank);
  assert.deepEqual(fixture.core.readXmmState(), bank);
  fixture.core.dispose();
});

test('missing standard SIMD rejects construction before allocating a Core', async () => {
  const validate = WebAssembly.validate;
  const create = Core.create;
  let calls = 0;
  WebAssembly.validate = () => false;
  Core.create = async () => {
    calls++;
    throw new Error('must not allocate');
  };
  try {
    await assert.rejects(createCpu(options()), {
      name: 'TypeError',
      message: 'WebAssembly SIMD is required',
    });
    assert.equal(calls, 0);
  } finally {
    WebAssembly.validate = validate;
    Core.create = create;
  }
});

async function cpuFixture() {
  let bank = Array<bigint>(16).fill(0n);
  let state = { registers: Array<bigint>(16).fill(0n), flags: 2n, rip: 0x1000n };
  const engine = {
    readXmmState: () => [...bank],
    setXmmState: (next: bigint[]) => {
      bank = [...next];
    },
    snapshot: () => structuredClone(state),
    setState: (next: typeof state) => {
      state = structuredClone(next);
    },
    dispose() {},
  };
  const create = Core.create;
  Core.create = async () => engine as unknown as Core;
  try {
    return await createCpu(options());
  } finally {
    Core.create = create;
  }
}

test('reentrant XMM imports publish complete banks last and retain independent scalar effects', async () => {
  const cpu = await cpuFixture();
  try {
    const outer = Array<bigint>(16).fill(3n);
    Object.defineProperty(outer, 0, {
      get() {
        cpu.setXmmState(Array<bigint>(16).fill(7n));
        cpu.setState({ registers: Array<bigint>(16).fill(9n), flags: 2n, rip: 0x2000n });
        return 3n;
      },
    });
    cpu.setXmmState(outer);
    assert.deepEqual(cpu.readXmmState(), Array<bigint>(16).fill(3n));
    assert.equal(cpu.readState().rip, 0x2000n);
    outer[15] = -1n;
    assert.throws(() => cpu.setXmmState(outer), TypeError);
    assert.deepEqual(cpu.readXmmState(), Array<bigint>(16).fill(7n));
    assert.equal(cpu.readState().rip, 0x2000n);
  } finally {
    cpu.dispose();
  }
});

test('disposal during XMM capture prevents publication and later input access', async () => {
  const cpu = await cpuFixture();
  const bank = Array<bigint>(16).fill(1n);
  Object.defineProperty(bank, 0, {
    get() {
      cpu.dispose();
      return 1n;
    },
  });
  assert.throws(() => cpu.setXmmState(bank), /disposed/);
  assert.throws(() => cpu.readXmmState(), /disposed/);
  let reads = 0;
  const later = new Proxy(bank, {
    get(target, property, receiver) {
      reads++;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  assert.throws(() => cpu.setXmmState(later), /disposed/);
  assert.equal(reads, 0);
});
