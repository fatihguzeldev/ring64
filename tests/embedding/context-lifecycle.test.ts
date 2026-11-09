import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Core } from '../../host/core.js';
import {
  createCpu,
  type Cpu,
  type ExecutionContext,
  type LoadedSegment,
  type RunResult,
} from '../../host/index.js';
import { LIMITS, changed, hex, initial } from '../support/fixture.js';
import { longSnapshot } from '../support/context.js';

const compiler = await WebAssembly.compile(
  new Uint8Array(await readFile(new URL('../../build/ring64.wasm', import.meta.url))),
);
const long = (fsBase = 0n): ExecutionContext => ({ mode: 'long64', fsBase, gsBase: 0n });
const segment = (type: LoadedSegment['type'] = 'read-write'): LoadedSegment => ({
  base: 0n,
  limit: 0xffffffff,
  default32: true,
  usable: true,
  type,
});
function protectedContext(): Extract<ExecutionContext, { segments: unknown }> {
  return {
    mode: 'protected',
    segments: {
      cs: segment('readable-code'),
      ss: segment(),
      ds: segment(),
      es: segment(),
      fs: segment(),
      gs: segment(),
    },
  };
}
function options() {
  return {
    compiler,
    code: { base: 0x1000n, bytes: hex('b801000000') },
    ram: { base: 0x4000n, bytes: new Uint8Array(8) },
    limits: LIMITS,
  };
}
async function warm(cpu: Cpu): Promise<void> {
  cpu.setState(initial());
  assert.equal((await cpu.run({ budget: 1n })).resources.compilations, 1);
  cpu.setState(initial());
}

test('a context getter may complete cached execution and publication preserves its final raw State', async () => {
  const cpu = await createCpu(options());
  let nested: Promise<RunResult> | undefined;
  try {
    await warm(cpu);
    const source = initial(0x1000n, { 0: 0x1122334455667788n }, 0x8d7n);
    cpu.setState(source);
    let reads = 0;
    const input: ExecutionContext = {
      mode: 'long64',
      get fsBase() {
        reads++;
        nested = cpu.run({ budget: 1n });
        return 0x100n;
      },
      gsBase: 0n,
    };
    cpu.setContext(input);
    assert.equal(reads, 1);
    assert.ok(nested);
    const result = await nested;
    assert.equal(result.resources.compilations, 0);
    assert.deepEqual(result.state, changed(source, 0x1005n, { 0: 1n }));
    assert.deepEqual(cpu.readState(), result.state);
    assert.deepEqual(cpu.readContext(), longSnapshot(0x100n));
    assert.deepEqual(cpu.inspectTranslations(), []);
  } finally {
    await nested;
    cpu.dispose();
  }
});

test('cold execution started by a context getter rejects overlapping publication and inspection', async () => {
  const cpu = await createCpu(options());
  let nested: Promise<RunResult> | undefined;
  const source = initial(0x1000n, { 0: 0xfedcba9876543210n }, 0x97n);
  cpu.setState(source);
  try {
    assert.throws(
      () =>
        cpu.setContext({
          mode: 'long64',
          get fsBase() {
            nested = cpu.run({ budget: 1n });
            assert.throws(() => cpu.readContext(), /running/);
            assert.throws(() => cpu.setContext(long()), /running/);
            return 0x100n;
          },
          gsBase: 0n,
        }),
      /running/,
    );
    assert.ok(nested);
    const result = await nested;
    assert.equal(result.resources.compilations, 1);
    assert.deepEqual(result.state, changed(source, 0x1005n, { 0: 1n }));
    assert.deepEqual(cpu.readContext(), longSnapshot());
    assert.deepEqual(cpu.readState(), result.state);
  } finally {
    await nested;
    cpu.dispose();
  }
});

test('context capture preserves successful nested changes even when the outer loaded profile is rejected', async () => {
  const cpu = await createCpu(options());
  try {
    await warm(cpu);
    const source = initial(0x123456789abcdef0n, { 0: 0x8877665544332211n }, 0x8d7n);
    const input = protectedContext();
    input.segments.cs.type = 'read-write';
    let reads = 0;
    Object.defineProperty(input.segments.ds, 'base', {
      get() {
        reads++;
        cpu.setState(source);
        cpu.writeMemory(0x4000n, hex('12345678'));
        cpu.setContext(long(0x200n));
        return 0n;
      },
    });
    assert.throws(() => cpu.setContext(input), TypeError);
    assert.equal(reads, 1);
    assert.deepEqual(cpu.readState(), source);
    assert.deepEqual(cpu.readMemory(0x4000n, 8), hex('1234567800000000'));
    assert.deepEqual(cpu.readContext(), longSnapshot(0x200n));
    assert.deepEqual(cpu.inspectTranslations(), []);
  } finally {
    cpu.dispose();
  }
});

test('equality uses the context current after getters and reordered loaded caches keep owners', async () => {
  const cpu = await createCpu({ ...options(), context: protectedContext() });
  try {
    await warm(cpu);
    const owners = cpu.inspectTranslations();
    const profile = protectedContext();
    const reordered = Object.fromEntries(
      Object.entries(profile.segments)
        .reverse()
        .map(([name, s]) => [
          name,
          {
            type: s.type,
            usable: s.usable,
            default32: s.default32,
            limit: s.limit,
            base: s.base,
          },
        ]),
    ) as typeof profile.segments;
    cpu.setContext({ segments: reordered, mode: 'protected' });
    assert.deepEqual(cpu.inspectTranslations(), owners);
    assert.equal((await cpu.run({ budget: 1n })).resources.compilations, 0);

    cpu.setContext(long());
    const raw = initial(0xffffffff12345678n, { 8: 0xabcdef1122334455n }, 0x8d7n);
    cpu.setContext({
      mode: 'long64',
      get fsBase() {
        cpu.setContext(long(0x300n));
        cpu.setState(raw);
        return 0n;
      },
      gsBase: 0n,
    });
    assert.deepEqual(cpu.readContext(), longSnapshot());
    assert.deepEqual(cpu.readState(), raw);
    assert.deepEqual(cpu.inspectTranslations(), []);
  } finally {
    cpu.dispose();
  }
});

test('disposal inside a context getter prevents publication and future getters are never read', async () => {
  const cpu = await createCpu(options());
  assert.throws(
    () =>
      cpu.setContext({
        mode: 'long64',
        get fsBase() {
          cpu.dispose();
          return 0n;
        },
        gsBase: 0n,
      }),
    /disposed/,
  );
  let reads = 0;
  assert.throws(
    () =>
      cpu.setContext({
        get mode() {
          reads++;
          return 'long64' as const;
        },
        fsBase: 0n,
        gsBase: 0n,
      }),
    /disposed/,
  );
  assert.equal(reads, 0);
  assert.throws(() => cpu.readContext(), /disposed/);
  assert.doesNotThrow(() => cpu.dispose());
});

test('unexpected context engine failures retain failed lifecycle before any later input reads', async () => {
  const cpu = await createCpu(options());
  const original = Core.prototype.setContext;
  const failure = new Error('injected context engine failure');
  try {
    Core.prototype.setContext = () => {
      throw failure;
    };
    assert.throws(
      () => cpu.setContext(long(0x100n)),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'cpu engine failed');
        assert.equal(error.cause, failure);
        return true;
      },
    );
  } finally {
    Core.prototype.setContext = original;
  }
  let reads = 0;
  assert.throws(
    () =>
      cpu.setContext({
        get mode() {
          reads++;
          return 'long64' as const;
        },
        fsBase: 0n,
        gsBase: 0n,
      }),
    /failed/,
  );
  assert.equal(reads, 0);
  assert.throws(() => cpu.readContext(), /failed/);
  cpu.dispose();
  assert.doesNotThrow(() => cpu.dispose());
});
