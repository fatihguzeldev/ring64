import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createCpu } from '../../host/index.js';
import type { ExecutionContext, LoadedSegment } from '../../host/context.js';
import { LIMITS, initial, hex } from '../support/fixture.js';
import { longSnapshot, protectedSnapshot } from '../support/context.js';

const compiler = await WebAssembly.compile(
  new Uint8Array(await readFile(new URL('../../build/ring64.wasm', import.meta.url))),
);
function segment(type: LoadedSegment['type'] = 'read-write'): LoadedSegment {
  return { base: 0n, limit: 0xffffffff, default32: true, usable: true, type };
}
function context(): ExecutionContext {
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
    code: { base: 0x1000n, bytes: hex('40b878563412') },
    ram: { base: 0x4000n, bytes: new Uint8Array(32) },
    limits: LIMITS,
  };
}

test('default context and identical imports preserve raw State and warm owners', async () => {
  const cpu = await createCpu(options());
  try {
    assert.deepEqual(cpu.readContext(), longSnapshot());
    const state = initial();
    cpu.setState(state);
    const first = await cpu.run({ budget: 1n });
    const owners = cpu.inspectTranslations();
    cpu.setState(state);
    cpu.setContext({ gsBase: 0n, mode: 'long64', fsBase: 0n });
    assert.deepEqual(cpu.readState(), state);
    assert.deepEqual(Object.keys(cpu.readState()).sort(), [
      'event',
      'flags',
      'interruptibility',
      'interrupts',
      'registers',
      'rip',
    ]);
    assert.deepEqual(cpu.inspectTranslations(), owners);
    const again = await cpu.run({ budget: 1n });
    assert.equal(again.resources.compilations, 0);
    assert.deepEqual(again.state, first.state);
  } finally {
    cpu.dispose();
  }
});

test('meaningful context changes retire all entries without changing raw banks flags or RIP', async () => {
  const cpu = await createCpu(options());
  try {
    await cpu.run({ budget: 1n });
    const state = initial(0x1000n, { 0: 0x1122334455667788n }, 0x8d7n);
    cpu.setState(state);
    const input = context();
    cpu.setContext(input);
    assert.deepEqual(cpu.readState(), state);
    assert.deepEqual(cpu.inspectTranslations(), []);
    assert.deepEqual(cpu.readContext(), protectedSnapshot());
    assert.notEqual(input.mode, 'long64');
    if (input.mode === 'long64') assert.fail();
    input.segments.ds.base = 0x1234n;
    const observed = cpu.readContext();
    if (observed.mode === 'long64') assert.fail();
    assert.equal(observed.segments.ds.base, 0n);
    observed.segments.cs.base = 7n;
    assert.equal((cpu.readContext() as typeof observed).segments.cs.base, 0n);
    const result = await cpu.run({ budget: 1n });
    assert.equal(result.reason, 'budget');
    assert.equal(result.state.rip, 0x1001n);
    assert.equal(result.state.registers[0], 0x1122334455667789n);
    assert.equal(result.state.flags, 3n);
  } finally {
    cpu.dispose();
  }
});

test('construction snapshots context before asynchronous work and rejects invalid loaded profiles', async () => {
  const input = context();
  const pending = createCpu({ ...options(), context: input });
  if (input.mode === 'long64') assert.fail();
  input.segments.cs.default32 = false;
  const cpu = await pending;
  try {
    const observed = cpu.readContext();
    if (observed.mode === 'long64') assert.fail();
    assert.equal(observed.segments.cs.default32, true);
    for (const kind of ['cs', 'ss', 'virtual8086'] as const) {
      const bad = context();
      if (bad.mode === 'long64') assert.fail();
      if (kind === 'cs') bad.segments.cs.type = 'read-write';
      else if (kind === 'ss') bad.segments.ss.usable = false;
      else bad.mode = 'virtual8086';
      const before = cpu.readContext();
      assert.throws(() => cpu.setContext(bad), TypeError);
      assert.deepEqual(cpu.readContext(), before);
    }
  } finally {
    cpu.dispose();
  }
});
