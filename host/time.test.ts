import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createCpu, type Cpu, type Options } from './index.js';
import { longSnapshot } from '../tests/support/context.js';
import { validateTimeLayout } from './time.js';

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
function options(model: 'linear' | 'ia32e-paged' | 'physical' = 'linear'): Options {
  const common = {
    compiler,
    limits,
    entry: 0x1000n,
    memoryLimits: { maxBackings: 1, maxBackingBytes: 16, maxMappings: 1 },
    memory: {
      backings: [{ id: 'code', bytes: Uint8Array.of(0x90, 0x90) }],
      mappings: [
        {
          base: 0x1000n,
          backing: 'code',
          offset: 0,
          length: 2,
          permissions: { read: true, write: true, execute: true },
        },
      ],
    },
  };
  if (model === 'ia32e-paged')
    return {
      ...common,
      memoryModel: model,
      paging: { cr0: 0x80000033n, cr2: 0n, cr3: 0n, cr4: 0x628n, efer: 0x500n },
    };
  return model === 'physical'
    ? {
        ...common,
        memoryModel: model,
        context: longSnapshot(),
        paging: { cr0: 0x80000033n, cr2: 0n, cr3: 0n, cr4: 0x628n, efer: 0x500n },
      }
    : common;
}
function otherState(cpu: Cpu) {
  return {
    scalar: cpu.readState(),
    context: cpu.readContext(),
    debug: cpu.readDebugState(),
    xmm: cpu.readXmmState(),
    x87: cpu.readX87State(),
    mxcsr: cpu.readMxcsr(),
    artifacts: cpu.inspectTranslations(),
  };
}

test('time transport rejects overlapping, truncated and noninteger layout records', () => {
  const layout = { offset: 768, size: 16, tsc: 0, tscAux: 8 };
  validateTimeLayout(layout, 784, 768);
  for (const changed of [
    { offset: 767 },
    { offset: 769 },
    { size: 11 },
    { tsc: 9 },
    { tscAux: 7 },
    { tscAux: 13 },
    { tsc: -1 },
    { size: 1.5 },
    { offset: NaN },
    { tscAux: Infinity },
  ])
    assert.throws(() => validateTimeLayout({ ...layout, ...changed }, 784, 768), /time layout/);
  assert.throws(() => validateTimeLayout(null as never, 784, 768), /time layout/);
});

test('time bank owns detached unsigned values in every memory model without changing other state', async () => {
  for (const model of ['linear', 'ia32e-paged', 'physical'] as const) {
    const cpu = await createCpu(options(model));
    try {
      assert.deepEqual(cpu.readTimeState(), { tsc: 0n, tscAux: 0 });
      const before = otherState(cpu);
      const source = { tsc: 0xffffffffffffffffn, tscAux: 0xffffffff };
      cpu.setTimeState(source);
      source.tsc = 0n;
      const detached = cpu.readTimeState();
      detached.tscAux = 0;
      assert.deepEqual(cpu.readTimeState(), { tsc: 0xffffffffffffffffn, tscAux: 0xffffffff });
      assert.deepEqual(otherState(cpu), before);
      cpu.setState(cpu.readState());
      cpu.setContext(cpu.readContext());
      assert.deepEqual(cpu.readTimeState(), { tsc: 0xffffffffffffffffn, tscAux: 0xffffffff });
      cpu.setTimeState({ tsc: 0n, tscAux: -0 });
      assert.equal(Object.is(cpu.readTimeState().tscAux, -0), false);
    } finally {
      cpu.dispose();
    }
  }
});

test('time rejection is atomic for incomplete, boxed and out-of-range fields', async () => {
  const cpu = await createCpu(options());
  try {
    cpu.setTimeState({ tsc: 100n, tscAux: 7 });
    const before = otherState(cpu);
    const invalid: unknown[] = [undefined, null, [], {}, { tsc: 0n }, { tscAux: 0 }];
    for (const tsc of [-1n, 1n << 64n, 0, '0', Object(0n), null, undefined])
      invalid.push({ tsc, tscAux: 0 });
    for (const tscAux of [-1, 2 ** 32, 0.5, NaN, Infinity, 0n, '0', Object(0), null, undefined])
      invalid.push({ tsc: 0n, tscAux });
    for (const input of invalid) {
      assert.throws(() => cpu.setTimeState(input as never), TypeError);
      assert.deepEqual(cpu.readTimeState(), { tsc: 100n, tscAux: 7 });
      assert.deepEqual(otherState(cpu), before);
    }
  } finally {
    cpu.dispose();
  }
});

test('time repair preserves a pending page-fault source, queue and SS shadow', async () => {
  const cpu = await createCpu(options('ia32e-paged'));
  try {
    cpu.setState({
      ...cpu.readState(),
      flags: 0x202n,
      interruptibility: { sti: false, ss: true },
      event: {
        kind: 'pending',
        exception: {
          vector: 14,
          instructionPc: 0xff0n,
          returnPc: 0x1000n,
          savedFlags: 0x10202n,
          errorCode: 6,
          pageFaultAddress: 0x501000n,
        },
      },
      interrupts: { irq: 0x31, nmiPending: true, nmiBlocked: true },
    });
    const before = otherState(cpu);
    cpu.setTimeState({ tsc: 0x8000000000000000n, tscAux: 0xffffffff });
    assert.deepEqual(otherState(cpu), before);
    assert.equal((await cpu.run({ budget: 1n })).reason, 'pending-exception');
    assert.deepEqual(cpu.readTimeState(), { tsc: 0x8000000000000000n, tscAux: 0xffffffff });
    assert.deepEqual(otherState(cpu), before);
  } finally {
    cpu.dispose();
  }
});

test('time capture reads named fields once and preserves nested input effects on rejection', async () => {
  const cpu = await createCpu(options());
  try {
    const reads: string[] = [];
    cpu.setTimeState({
      get tsc() {
        reads.push('tsc');
        return 0x8000000000000000n;
      },
      get tscAux() {
        reads.push('tscAux');
        return 0x89abcdef;
      },
    });
    assert.deepEqual(reads, ['tsc', 'tscAux']);
    assert.throws(
      () =>
        cpu.setTimeState({
          tsc: -1n,
          get tscAux() {
            cpu.setTimeState({ tsc: 200n, tscAux: 9 });
            return 0;
          },
        }),
      TypeError,
    );
    assert.deepEqual(cpu.readTimeState(), { tsc: 200n, tscAux: 9 });
    let nested: Promise<unknown> | undefined;
    assert.throws(
      () =>
        cpu.setTimeState({
          get tsc() {
            nested = cpu.run({ budget: 0n });
            return 1n;
          },
          tscAux: 0,
        }),
      /run.*capture/,
    );
    await nested;
    assert.deepEqual(cpu.readTimeState(), { tsc: 200n, tscAux: 9 });
  } finally {
    cpu.dispose();
  }
});

test('physical reset during time capture remains effective and rejects stale publication', async () => {
  const cpu = await createCpu(options('physical'));
  try {
    cpu.setTimeState({ tsc: 100n, tscAux: 7 });
    assert.throws(
      () =>
        cpu.setTimeState({
          get tsc() {
            cpu.reset();
            return 300n;
          },
          tscAux: 9,
        }),
      /reset.*capture/,
    );
    assert.deepEqual(cpu.readTimeState(), { tsc: 0n, tscAux: 0 });
  } finally {
    cpu.dispose();
  }
});

test('a later capture accessor preserves exact exceptions and earlier nested effects without enumeration', async () => {
  const cpu = await createCpu(options());
  try {
    cpu.setTimeState({ tsc: 100n, tscAux: 7 });
    const marker = { source: 'second accessor' };
    const reads: PropertyKey[] = [];
    const input = new Proxy(
      {
        get tsc() {
          cpu.setTimeState({ tsc: 200n, tscAux: 9 });
          cpu.setState({ ...cpu.readState(), flags: 0x402n });
          return 300n;
        },
        get tscAux(): number {
          throw marker;
        },
        get unrelated() {
          return assert.fail('time capture must not enumerate unrelated properties');
        },
      },
      {
        get(target, key, receiver) {
          reads.push(key);
          return Reflect.get(target, key, receiver);
        },
        ownKeys() {
          assert.fail('time capture must not enumerate input keys');
        },
      },
    );
    assert.throws(
      () => cpu.setTimeState(input),
      (error) => error === marker,
    );
    assert.deepEqual(reads, ['tsc', 'tscAux']);
    assert.deepEqual(cpu.readTimeState(), { tsc: 200n, tscAux: 9 });
    assert.equal(cpu.readState().flags, 0x402n);
    cpu.setTimeState({ tsc: 400n, tscAux: 11 });
    assert.deepEqual(cpu.readTimeState(), { tsc: 400n, tscAux: 11 });
  } finally {
    cpu.dispose();
  }
});

test('a completed accessor run retains its real NOP tick while rejecting a stale time import', async () => {
  const cpu = await createCpu(options());
  try {
    await cpu.run({ budget: 1n });
    cpu.setState({ ...cpu.readState(), rip: 0x1000n });
    cpu.setTimeState({ tsc: 100n, tscAux: 7 });
    let nested: Promise<unknown> | undefined;
    assert.throws(
      () =>
        cpu.setTimeState({
          get tsc() {
            nested = cpu.run({ budget: 1n });
            return 300n;
          },
          tscAux: 9,
        }),
      /run.*capture/,
    );
    await nested;
    assert.deepEqual(cpu.readTimeState(), { tsc: 101n, tscAux: 7 });
  } finally {
    cpu.dispose();
  }
});

test('I/O callbacks cannot inspect or repair their running CPU time bank', async () => {
  const second = await createCpu(options());
  let cpu: Cpu | undefined;
  const setup = options();
  if (!('memory' in setup)) assert.fail('mapped fixture required');
  setup.memory.backings[0]!.bytes = Uint8Array.of(0xe4, 0x22);
  const first = await createCpu({
    ...setup,
    io: {
      read() {
        assert.throws(() => cpu!.readTimeState(), /running/);
        let touched = false;
        assert.throws(
          () =>
            cpu!.setTimeState({
              get tsc() {
                touched = true;
                return 0n;
              },
              tscAux: 0,
            }),
          /running/,
        );
        assert.equal(touched, false);
        second.setTimeState({ tsc: 200n, tscAux: 9 });
        return 0x55;
      },
      write() {},
    },
  });
  cpu = first;
  try {
    assert.equal((await first.run({ budget: 1n })).retired, 1n);
    assert.deepEqual(first.readTimeState(), { tsc: 1n, tscAux: 0 });
    assert.deepEqual(second.readTimeState(), { tsc: 200n, tscAux: 9 });
  } finally {
    first.dispose();
    second.dispose();
  }
});

test('fatal provider failure rejects time access before touching setter input', async () => {
  const setup = options();
  if (!('memory' in setup)) assert.fail('mapped fixture required');
  setup.memory.backings[0]!.bytes = Uint8Array.of(0xe4, 0x22);
  const cpu = await createCpu({
    ...setup,
    io: {
      read() {
        throw new Error('provider failed');
      },
      write() {},
    },
  });
  try {
    await assert.rejects(cpu.run({ budget: 1n }), /engine failed/);
    assert.throws(() => cpu.readTimeState(), /failed/);
    let touched = false;
    assert.throws(
      () =>
        cpu.setTimeState({
          get tsc() {
            touched = true;
            return 0n;
          },
          tscAux: 0,
        }),
      /failed/,
    );
    assert.equal(touched, false);
  } finally {
    cpu.dispose();
  }
});

test('time methods reject disposal before touching caller fields and never share an instance bank', async () => {
  const first = await createCpu(options()),
    second = await createCpu(options());
  try {
    first.setTimeState({ tsc: 100n, tscAux: 7 });
    assert.deepEqual(second.readTimeState(), { tsc: 0n, tscAux: 0 });
    let touched = false;
    assert.throws(
      () =>
        first.setTimeState({
          get tsc() {
            first.dispose();
            return 300n;
          },
          tscAux: 9,
        }),
      /disposed/,
    );
    assert.throws(() => first.readTimeState(), /disposed/);
    assert.throws(
      () =>
        first.setTimeState({
          get tsc() {
            touched = true;
            return 0n;
          },
          tscAux: 0,
        }),
      /disposed/,
    );
    assert.equal(touched, false);
  } finally {
    first.dispose();
    second.dispose();
  }
});
