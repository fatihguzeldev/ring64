import assert from 'node:assert/strict';
import test from 'node:test';
import { Core } from './core.js';
import { createCpu, type Options } from './cpu.js';
import { longSnapshot } from '../tests/support/context.js';

const limits = {
  maxInstructions: 32,
  maxSourceBytes: 256,
  maxArtifactBytes: 65536,
  maxCachedArtifacts: 8,
  maxCachedBytes: 1048576,
  maxTranslationsPerRun: 8,
};
const bank = () => ({
  star: 0x0020000800000000n,
  lstar: 0xffff800000001000n,
  fmask: 0x300n,
  sysenterCs: 0x12340008n,
  sysenterEip: 0xffff800000002000n,
  sysenterEsp: 0xffff800000004000n,
  kernelGsBase: 0xffff800000006000n,
});
const zero = () => ({
  star: 0n,
  lstar: 0n,
  fmask: 0n,
  sysenterCs: 0n,
  sysenterEip: 0n,
  sysenterEsp: 0n,
  kernelGsBase: 0n,
});

async function fixture(
  model: 'linear' | 'ia32e-paged' = 'ia32e-paged',
  transform?: (options: Options) => Options,
) {
  let fastSystem = zero();
  let failRead = false;
  const imports: ReturnType<typeof bank>[] = [];
  const scalar = {
    registers: Array<bigint>(16).fill(0n),
    flags: 0x202n,
    rip: 0x1000n,
    interruptibility: { sti: false, ss: false },
    event: { kind: 'ready' },
    interrupts: { irq: null, nmiPending: false, nmiBlocked: false },
  };
  const engine = {
    isPaged: model === 'ia32e-paged',
    readFastSystemState() {
      if (failRead) throw new Error('broken core projection');
      return { ...fastSystem };
    },
    setFastSystemState(input: ReturnType<typeof bank>) {
      if (input.star & 0xffffffffn) throw new TypeError('reserved STAR bits');
      imports.push(input);
      fastSystem = { ...input };
    },
    current: () => ({ rip: 0x1000n, remaining: 0n, repeatRemaining: 0n }),
    snapshot: () => structuredClone(scalar),
    eventKind: () => 'ready',
    hasQueuedInterrupts: () => false,
    prepareEntry: () => false,
    fault: () => undefined,
    segmentFault: () => undefined,
    alignmentFault: () => undefined,
    probe: () => 'dispatch',
    compile: (pc: bigint) => ({
      bytes: Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0),
      metadata: {
        entries: [pc],
        owner: 1n,
        contextVersion: 0n,
        boundaryObserved: false,
        byteLength: 8,
        instructionCount: 1,
        blockCount: 1,
        sourceBytes: 1,
        dependencies: [],
      },
    }),
    valid: () => true,
    release() {},
    releaseIo() {},
    dispose() {},
  };
  const original = Core.create;
  Core.create = async (_compiler, memory) => {
    fastSystem = { ...(memory.fastSystem ?? zero()) };
    return engine as unknown as Core;
  };
  try {
    const common = {
      compiler: new Uint8Array(),
      memory: {
        backings: [{ id: 'ram', bytes: Uint8Array.of(0x90, 2) }],
        mappings: [
          {
            base: 0x1000n,
            backing: 'ram',
            offset: 0,
            length: 2,
            permissions: { read: true, write: true, execute: true },
          },
        ],
      },
      entry: 0x1000n,
      memoryLimits: { maxBackings: 1, maxBackingBytes: 16, maxMappings: 1 },
      limits,
    };
    const options: Options =
      model === 'ia32e-paged'
        ? {
            ...common,
            memoryModel: model,
            paging: { cr0: 0x80010033n, cr2: 0n, cr3: 0x1000n, cr4: 0x628n, efer: 0x500n },
          }
        : common;
    const cpu = await createCpu(transform ? transform(options) : options);
    return {
      cpu,
      imports,
      failRead: () => {
        failRead = true;
      },
    };
  } finally {
    Core.create = original;
  }
}

test('fast-system construction captures a complete bank before later option getters', async () => {
  const source = bank();
  const reads = new Map<PropertyKey, number>();
  let outerReads = 0;
  const f = await fixture('ia32e-paged', (options) => {
    if (options.memoryModel !== 'ia32e-paged') assert.fail('expected paged fixture');
    return {
      ...options,
      get fastSystem() {
        outerReads++;
        return new Proxy(source, {
          get(target, key, receiver) {
            reads.set(key, (reads.get(key) ?? 0) + 1);
            return Reflect.get(target, key, receiver) as unknown;
          },
        });
      },
      get context() {
        source.lstar = 0n;
        return longSnapshot();
      },
    };
  });
  try {
    assert.deepEqual(f.cpu.readFastSystemState(), bank());
    assert.equal(outerReads, 1);
    assert.deepEqual(
      [...reads],
      ['star', 'lstar', 'fmask', 'sysenterCs', 'sysenterEip', 'sysenterEsp', 'kernelGsBase'].map(
        (key) => [key, 1],
      ),
    );
  } finally {
    f.cpu.dispose();
  }
});

test('fast-system omission initializes zeros while a linear CPU rejects even undefined presence', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.cpu.readFastSystemState(), zero());
  } finally {
    f.cpu.dispose();
  }
  let read = false;
  await assert.rejects(
    fixture('linear', (options) =>
      Object.defineProperty(options, 'fastSystem', {
        get() {
          read = true;
          return undefined;
        },
      }),
    ),
    TypeError,
  );
  assert.equal(read, false);
  for (const value of [undefined, null, {}, { ...bank(), kernelGsBase: undefined }])
    await assert.rejects(
      fixture('ia32e-paged', (options) => ({ ...options, fastSystem: value }) as Options),
      TypeError,
    );
});

test('fast-system API owns detached values and permits a valid outer idle capture after a nested setter', async () => {
  const f = await fixture();
  try {
    let reads = 0;
    f.cpu.setFastSystemState({
      ...bank(),
      get lstar() {
        reads++;
        f.cpu.setFastSystemState({ ...bank(), lstar: 0x2000n });
        return 0x3000n;
      },
    });
    assert.equal(reads, 1);
    assert.equal(f.cpu.readFastSystemState().lstar, 0x3000n);
    const detached = f.cpu.readFastSystemState();
    detached.lstar = 0n;
    assert.equal(f.cpu.readFastSystemState().lstar, 0x3000n);
    assert.equal(f.imports.length, 2);
    assert.throws(
      () =>
        f.cpu.setFastSystemState({
          ...bank(),
          star: 1n,
          get kernelGsBase() {
            f.cpu.setFastSystemState({ ...bank(), kernelGsBase: 0x4000n });
            return 0x5000n;
          },
        }),
      TypeError,
    );
    assert.equal(f.cpu.readFastSystemState().kernelGsBase, 0x4000n);
    assert.equal(f.imports.length, 3);
    assert.throws(() => f.cpu.setFastSystemState({ ...bank(), fmask: Object(0n) } as never));
    assert.equal(f.imports.length, 3);
  } finally {
    f.cpu.dispose();
  }
});

test('completed nested runs and disposal reject stale outer fast-system publication', async () => {
  for (const action of ['run', 'dispose'] as const) {
    const f = await fixture();
    let nested: Promise<unknown> | undefined;
    try {
      assert.throws(
        () =>
          f.cpu.setFastSystemState({
            ...bank(),
            get sysenterCs() {
              if (action === 'run') nested = f.cpu.run({ budget: 0n });
              else f.cpu.dispose();
              return 8n;
            },
          }),
        action === 'run' ? /run.*capture/ : /disposed/,
      );
      await nested;
      assert.deepEqual(f.imports, []);
    } finally {
      f.cpu.dispose();
    }
  }
});

test('fast-system methods reject wrong models and terminal lifecycles before reading input getters', async () => {
  for (const lifecycle of ['linear', 'disposed', 'failed'] as const) {
    const f = await fixture(lifecycle === 'linear' ? 'linear' : 'ia32e-paged');
    if (lifecycle === 'disposed') f.cpu.dispose();
    if (lifecycle === 'failed') {
      f.failRead();
      assert.throws(
        () => f.cpu.readFastSystemState(),
        (error: unknown) =>
          error instanceof Error &&
          error.message === 'cpu engine failed' &&
          error.cause instanceof Error &&
          error.cause.message === 'broken core projection',
      );
    }
    let touched = false;
    try {
      assert.throws(() => f.cpu.readFastSystemState(), /ia32e-paged|disposed|failed/);
      assert.throws(
        () =>
          f.cpu.setFastSystemState({
            ...bank(),
            get star() {
              touched = true;
              return bank().star;
            },
          }),
        /ia32e-paged|disposed|failed/,
      );
      assert.equal(touched, false);
      assert.deepEqual(f.imports, []);
    } finally {
      f.cpu.dispose();
    }
  }
});

test('fast-system access remains idle-only throughout compilation and after compilation failure', async () => {
  const f = await fixture();
  const compile = WebAssembly.compile;
  let rejectCompile: ((error: Error) => void) | undefined;
  WebAssembly.compile = () =>
    new Promise<WebAssembly.Module>((_resolve, reject) => {
      rejectCompile = reject;
    });
  try {
    const running = f.cpu.run({ budget: 1n });
    const rejected = assert.rejects(running, /failed/);
    assert.ok(rejectCompile, 'run reached the asynchronous browser compilation frontier');
    let touched = false;
    assert.throws(() => f.cpu.readFastSystemState(), /running/);
    assert.throws(
      () =>
        f.cpu.setFastSystemState({
          ...bank(),
          get star() {
            touched = true;
            return bank().star;
          },
        }),
      /running/,
    );
    assert.equal(touched, false);
    rejectCompile(new Error('expected compile rejection'));
    await rejected;
    assert.throws(() => f.cpu.readFastSystemState(), /failed/);
    assert.throws(() => f.cpu.setFastSystemState(bank()), /failed/);
    assert.deepEqual(f.imports, []);
  } finally {
    WebAssembly.compile = compile;
    f.cpu.dispose();
  }
});
