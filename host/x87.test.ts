import assert from 'node:assert/strict';
import test from 'node:test';
import { captureX87State, type X87State } from './x87.js';
import { Core } from './core.js';
import { captureInitialMemory } from './memory.js';
import { createCpu } from './cpu.js';

const layout = {
  size: 608,
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
  event: {
    offset: 560,
    bytes: 40,
    kind: 0,
    vector: 4,
    instructionPc: 8,
    returnPc: 16,
    savedFlags: 24,
    errorCode: 32,
    hasErrorCode: 36,
  },
  reasons: ['dispatch', 'x87-exception'],
};

const options = () => ({
  compiler: new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)),
  code: { base: 0x1000n, bytes: Uint8Array.of(0x90) },
  ram: { base: 0x4000n, bytes: new Uint8Array(16) },
  limits: {
    maxInstructions: 32,
    maxSourceBytes: 256,
    maxArtifactBytes: 65536,
    maxCachedArtifacts: 8,
    maxCachedBytes: 1048576,
    maxTranslationsPerRun: 8,
  },
});

async function fixture(
  descriptor = layout,
  missing?: string,
  memory = new WebAssembly.Memory({ initial: 1 }),
  statePointer = 8192,
  inputPointer = 512,
) {
  const info = new TextEncoder().encode(JSON.stringify(descriptor));
  new Uint8Array(memory.buffer, 4096, info.length).set(info);
  let initialized = 0,
    disposed = 0,
    imported = 0,
    length = 0;
  const methods: Record<string, unknown> = {
    memory,
    core_init_mapped() {
      initialized++;
      return 0;
    },
    core_dispose() {
      disposed++;
    },
    core_state_ptr: () => statePointer | 0,
    core_info_ptr: () => 4096,
    core_info_len: () => info.length,
    core_input(n: number) {
      length = n;
      return inputPointer | 0;
    },
    core_import_x87() {
      assert.equal(length, 104);
      imported++;
      new Uint8Array(memory.buffer, statePointer + descriptor.x87.offset, 104).set(
        new Uint8Array(memory.buffer, inputPointer, 104),
      );
      return 0;
    },
  };
  const original = WebAssembly.instantiate;
  WebAssembly.instantiate = (async () => ({
    exports: new Proxy(methods, {
      get(target, key) {
        return key === missing ? undefined : (Reflect.get(target, key) ?? (() => 0));
      },
    }),
  })) as unknown as typeof original;
  try {
    const input = options();
    return {
      core: await Core.create(input.compiler, captureInitialMemory(input)),
      memory,
      initialized: () => initialized,
      disposed: () => disposed,
      imported: () => imported,
    };
  } catch (error) {
    return {
      error,
      memory,
      initialized: () => initialized,
      disposed: () => disposed,
      imported: () => imported,
    };
  } finally {
    WebAssembly.instantiate = original;
  }
}

const state = (): X87State => ({
  registers: Array.from({ length: 8 }, (_, i) => (BigInt(i + 1) << 72n) | BigInt(i)),
  controlWord: 0x037f,
  statusWord: 0x0200,
  tagWord: 0xffff,
  instructionPointer: (1n << 64n) - 1n,
  dataPointer: 0x8877665544332211n,
  opcode: 0x7ff,
});

test('x87 capture owns eight physical raw80 banks and reads each input once', () => {
  const input = state();
  const reads = new Map<PropertyKey, number>();
  const arrayReads = new Map<PropertyKey, number>();
  input.registers = new Proxy(input.registers, {
    get(target, key, receiver) {
      arrayReads.set(key, (arrayReads.get(key) ?? 0) + 1);
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  const source = new Proxy(input, {
    get(target, key, receiver) {
      reads.set(key, (reads.get(key) ?? 0) + 1);
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  const captured = captureX87State(source);
  assert.deepEqual(captured, state());
  assert.deepEqual([...reads.values()], Array<number>(7).fill(1));
  assert.equal(arrayReads.get('length'), 1);
  for (let i = 0; i < 8; i++) assert.equal(arrayReads.get(String(i)), 1);
  input.registers[0] = 0n;
  assert.notEqual(captured.registers[0], 0n);
});

test('x87 capture rejects invalid raw banks and fields without coercion', () => {
  const inherited = Array<bigint>(8).fill(0n);
  delete inherited[0];
  const prototype = Object.create(Array.prototype) as object;
  Object.defineProperty(prototype, '0', { value: 1n });
  Object.setPrototypeOf(inherited, prototype);
  assert.throws(() => captureX87State({ ...state(), registers: inherited }), TypeError);
  for (const invalid of [[], new Array(8), new BigUint64Array(8), Array<bigint>(9).fill(0n)])
    assert.throws(() => captureX87State({ ...state(), registers: invalid as bigint[] }), TypeError);
  for (const invalid of [-1n, 1n << 80n, 1, '1', undefined, null]) {
    const input = state();
    input.registers[7] = invalid as bigint;
    assert.throws(() => captureX87State(input), TypeError);
  }
  for (const key of ['controlWord', 'statusWord', 'tagWord', 'opcode'] as const)
    for (const invalid of [-1, 65536, NaN, Infinity, 1.2, '1', 1n, null, new Number(1)])
      assert.throws(() => captureX87State({ ...state(), [key]: invalid }), TypeError);
  assert.throws(() => captureX87State({ ...state(), opcode: 0x800 }), TypeError);
  for (const key of ['instructionPointer', 'dataPointer'] as const)
    for (const invalid of [-1n, 1n << 64n, 1, '1', null, new Number(1)])
      assert.throws(() => captureX87State({ ...state(), [key]: invalid }), TypeError);
  assert.throws(() => captureX87State(null as unknown as X87State), TypeError);
});

test('x87 raw checkpoints preserve tags but require ES and B to match pending masks', () => {
  const pending = { ...state(), controlWord: 0x037b, statusWord: 0xa884 };
  assert.deepEqual(captureX87State(pending), pending);
  for (const statusWord of [0x2804, 0x2884, 0xa804])
    assert.throws(() => captureX87State({ ...pending, statusWord }), TypeError);
  assert.throws(() => captureX87State({ ...state(), statusWord: 0x8080 }), TypeError);
  assert.deepEqual(captureX87State({ ...state(), controlWord: 0x017f }).controlWord, 0x017f);
  const zero = captureX87State({ ...state(), opcode: -0, statusWord: -0, tagWord: -0 });
  assert.equal(Object.is(zero.opcode, -0), false);
  assert.equal(zero.tagWord, 0);
});

test('x87 transport uses exact little-endian raw80 payloads and owns snapshots', async () => {
  const f = await fixture();
  assert.ok(f.core);
  try {
    const input = state();
    f.core.setX87State(input);
    assert.deepEqual(f.core.readX87State(), input);
    assert.deepEqual(
      new Uint8Array(f.memory.buffer, 8192 + 456, 10),
      Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0, 1),
    );
    const copy = f.core.readX87State();
    copy.registers[7] = 0n;
    copy.controlWord = 0;
    assert.deepEqual(f.core.readX87State(), input);
    assert.throws(() => f.core!.setX87State({ ...input, statusWord: 0x8080 }), TypeError);
    assert.equal(f.imported(), 1);
    assert.deepEqual(f.core.readX87State(), input);
  } finally {
    f.core.dispose();
  }
});

test('x87 layout rejects overlap, missing fields and extent overflow with cleanup', async () => {
  for (const x87 of [
    { ...layout.x87, offset: 448 },
    { ...layout.x87, bytes: 103 },
    { ...layout.x87, registerBytes: 16 },
    { ...layout.x87, controlWord: 79 },
    { ...layout.x87, dataPointer: 95 },
    { ...layout.x87, opcode: NaN },
    undefined,
  ]) {
    const f = await fixture({ ...layout, x87 } as typeof layout);
    assert.ok(f.error instanceof Error);
    assert.equal(f.disposed(), 1);
    assert.equal(f.initialized(), 1);
    assert.equal(f.imported(), 0);
  }
  const past = await fixture(layout, undefined, undefined, 65536 - 559);
  assert.ok(past.error instanceof RangeError);
  assert.equal(past.disposed(), 1);
  for (const name of ['core_import_x87', 'core_x87']) {
    const f = await fixture(layout, name);
    assert.match(String(f.error), new RegExp(name));
    assert.equal(f.initialized(), 0);
    assert.equal(f.disposed(), 0);
  }
});

test('x87 state and import pointers retain unsigned wasm32 values through exact memory end', async () => {
  const memory = new WebAssembly.Memory({ initial: 32769 });
  const at = memory.buffer.byteLength - layout.size;
  assert.ok(at > 0x7fffffff);
  const f = await fixture(layout, undefined, memory, at, at - 512);
  assert.ok(f.core);
  try {
    f.core.setX87State(state());
    assert.deepEqual(f.core.readX87State(), state());
  } finally {
    f.core.dispose();
  }
});

async function publicFixture() {
  let x87 = state(),
    scalar = { registers: Array<bigint>(16).fill(0n), flags: 2n, rip: 0x1000n };
  let xmm = Array<bigint>(16).fill(0n),
    mxcsr = 0x1f80;
  let imports = 0;
  const engine = {
    configureDelivery() {},
    eventKind: () => 'ready',
    stageException: () => false,
    deliverException: () => 'dispatch',
    readX87State: () => structuredClone(x87),
    setX87State(next: X87State) {
      x87 = structuredClone(next);
      imports++;
    },
    snapshot: () => structuredClone(scalar),
    setState(next: typeof scalar) {
      scalar = structuredClone(next);
    },
    readXmmState: () => [...xmm],
    setXmmState(next: bigint[]) {
      xmm = [...next];
    },
    readMxcsr: () => mxcsr,
    setMxcsr(next: number) {
      mxcsr = next;
    },
    clearFault() {},
    prepareEntry: () => false,
    boundaryObserved: () => false,
    dispose() {},
    release() {},
    valid: () => true,
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
  };
  const original = Core.create;
  Core.create = async () => engine as unknown as Core;
  try {
    return { cpu: await createCpu(options()), imports: () => imports };
  } finally {
    Core.create = original;
  }
}

test('reentrant x87 capture replaces its whole projection last and preserves other nested effects', async () => {
  const { cpu } = await publicFixture();
  const inner = { ...state(), controlWord: 0x37b, statusWord: 0xa884 };
  try {
    const outer = state();
    Object.defineProperty(outer.registers, 0, {
      get() {
        cpu.setX87State(inner);
        cpu.setState({ registers: Array<bigint>(16).fill(9n), flags: 2n, rip: 0x2222n });
        cpu.setXmmState(Array<bigint>(16).fill(7n));
        cpu.setMxcsr(0xffff);
        return state().registers[0];
      },
    });
    cpu.setX87State(outer);
    assert.deepEqual(cpu.readX87State(), state());
    assert.equal(cpu.readState().rip, 0x2222n);
    assert.deepEqual(cpu.readXmmState(), Array<bigint>(16).fill(7n));
    assert.equal(cpu.readMxcsr(), 0xffff);
    outer.opcode = 0x800;
    assert.throws(() => cpu.setX87State(outer), TypeError);
    assert.deepEqual(cpu.readX87State(), inner);
  } finally {
    cpu.dispose();
  }
});

test('x87 lifecycle gates precede input capture and reject publication after disposal', async () => {
  const { cpu, imports } = await publicFixture();
  const input = state();
  Object.defineProperty(input.registers, 0, {
    get() {
      cpu.dispose();
      return 0n;
    },
  });
  assert.throws(() => cpu.setX87State(input), /disposed/);
  assert.equal(imports(), 0);
  let reads = 0;
  const later = new Proxy(state(), {
    get(target, key, receiver) {
      reads++;
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  assert.throws(() => cpu.setX87State(later), /disposed/);
  assert.throws(() => cpu.readX87State(), /disposed/);
  assert.equal(reads, 0);
});

test('running, pending compilation and failed states reject x87 projection access', async () => {
  const { cpu, imports } = await publicFixture();
  const original = WebAssembly.compile;
  let reject!: (reason: Error) => void;
  WebAssembly.compile = () =>
    new Promise((_, failed) => {
      reject = failed;
    });
  try {
    const running = cpu.run({ budget: 1n, repeatBudget: 0n });
    assert.throws(() => cpu.readX87State(), /running/);
    assert.throws(() => cpu.setX87State(state()), /running/);
    assert.equal(imports(), 0);
    reject(new Error('controlled x87 lifecycle compile failure'));
    await assert.rejects(running, /engine failed/);
    assert.throws(() => cpu.readX87State(), /failed/);
    assert.throws(() => cpu.setX87State(state()), /failed/);
    assert.equal(imports(), 0);
  } finally {
    WebAssembly.compile = original;
    cpu.dispose();
  }
});
