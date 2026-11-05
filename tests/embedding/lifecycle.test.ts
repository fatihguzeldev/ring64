import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createCpu, type Limits } from '../../host/index.js';
import type { State } from '../../host/index.js';

const compiler = await WebAssembly.compile(
  new Uint8Array(await readFile(new URL('../../build/ring64.wasm', import.meta.url))),
);
const CODE = 0x1000n;
const RAM = 0x1_0000_4000n;
const limits: Limits = {
  maxInstructions: 64,
  maxSourceBytes: 256,
  maxArtifactBytes: 65536,
  maxCachedArtifacts: 8,
  maxCachedBytes: 262144,
  maxTranslationsPerRun: 8,
};

function state(seed = 0x1122_3344_0000_0000n, flags = 2n): State {
  const registers = Array.from({ length: 16 }, (_, index) => seed + BigInt(index));
  registers[3] = RAM;
  return { registers, flags, rip: CODE };
}

test('large host copies grow core memory without invalidating state or cached generated code', async () => {
  const observed: { memory?: WebAssembly.Memory } = {};
  const instantiate = WebAssembly.instantiate;
  const observeInstantiation = async (
    input: WebAssembly.Module | BufferSource,
    imports?: WebAssembly.Imports,
  ) => {
    const result =
      input instanceof WebAssembly.Module
        ? await instantiate(input, imports)
        : await instantiate(input, imports);
    const instance = result instanceof WebAssembly.Instance ? result : result.instance;
    if (instance.exports.memory instanceof WebAssembly.Memory)
      observed.memory = instance.exports.memory;
    return result;
  };
  const size = 16 * 1024 * 1024;
  const cpu = await (async () => {
    WebAssembly.instantiate = observeInstantiation as typeof WebAssembly.instantiate;
    try {
      return await createCpu({
        compiler,
        code: { base: CODE, bytes: Uint8Array.of(0x8b, 0x03, 0x83, 0xc0, 1, 0x89, 0x03) },
        ram: { base: RAM, bytes: new Uint8Array(size) },
        limits,
      });
    } finally {
      WebAssembly.instantiate = instantiate;
    }
  })();
  try {
    assert.ok(observed.memory instanceof WebAssembly.Memory);
    const initial = state();
    cpu.setState(initial);
    const first = await cpu.run({ budget: 4n, stop: CODE + 7n });
    assert.equal(first.reason, 'stop');
    assert.equal(first.resources.compilations, 1);
    assert.equal(first.state.registers[0], 1n);
    const before = observed.memory.buffer.byteLength;

    const input = new Uint8Array(size);
    for (let index = 0; index < input.length; index++) input[index] = (index * 29 + 17) & 255;
    input.set([0x78, 0x56, 0x34, 0x12]);
    cpu.writeMemory(RAM, input);
    const readback = cpu.readMemory(RAM, size);
    assert.deepEqual(readback, input);
    assert.ok(
      observed.memory.buffer.byteLength > before,
      'the real core allocation must grow memory',
    );
    readback[0] = 0xff;
    assert.deepEqual(cpu.readMemory(RAM, 4), Uint8Array.of(0x78, 0x56, 0x34, 0x12));

    cpu.setState(initial);
    const resumed = await cpu.run({ budget: 4n, stop: CODE + 7n });
    const expected = state();
    expected.registers[0] = 0x1234_5679n;
    expected.rip = CODE + 7n;
    assert.equal(resumed.reason, 'stop');
    assert.equal(resumed.retired, 3n);
    assert.equal(resumed.remaining, 1n);
    assert.deepEqual(resumed.state, expected);
    assert.equal(resumed.resources.compilations, 0);
    assert.ok(resumed.resources.cacheHits > 0);
    input[0] = 0x79;
    assert.deepEqual(cpu.readMemory(RAM, size), input);
    assert.deepEqual(cpu.readState(), expected);
  } finally {
    cpu.dispose();
  }
});

test('browser compilation rejection leaves a failed instance with disposal as its only operation', async () => {
  const initial = state();
  const cpu = await createCpu({
    compiler,
    code: { base: CODE, bytes: Uint8Array.of(0xb8, 1, 0, 0, 0) },
    ram: { base: RAM, bytes: new Uint8Array(8) },
    limits,
  });
  const compile = WebAssembly.compile;
  const rejection = new WebAssembly.CompileError('injected browser compilation rejection');
  let attempts = 0;
  cpu.setState(initial);
  try {
    try {
      WebAssembly.compile = async () => {
        attempts++;
        throw rejection;
      };
      await assert.rejects(cpu.run({ budget: 1n }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'cpu engine failed');
        assert.equal(error.cause, rejection);
        return true;
      });
      assert.equal(attempts, 1);
    } finally {
      WebAssembly.compile = compile;
    }
    assert.throws(() => cpu.readState(), /cpu is failed/);
    assert.throws(() => cpu.setState(initial), /cpu is failed/);
    assert.throws(() => cpu.readMemory(RAM, 1), /cpu is failed/);
    assert.throws(() => cpu.writeMemory(RAM, Uint8Array.of(1)), /cpu is failed/);
    assert.throws(() => cpu.inspectTranslations(), /cpu is failed/);
    await assert.rejects(cpu.run({ budget: 0n }), /cpu is failed/);
  } finally {
    cpu.dispose();
  }
  assert.throws(() => cpu.readState(), /cpu is disposed/);
  await assert.rejects(cpu.run({ budget: 0n }), /cpu is disposed/);
  assert.doesNotThrow(() => cpu.dispose());
});

test('cpus sharing one compiled core module keep code, state, ram and artifacts independent', async () => {
  const firstState = state();
  const secondState = state(0x8877_6655_0000_0000n, 0x97n);
  const first = await createCpu({
    compiler,
    code: { base: CODE, bytes: Uint8Array.of(0xb8, 0x11, 0, 0, 0, 0x89, 0x03) },
    ram: { base: RAM, bytes: new Uint8Array(8).fill(0xa5) },
    limits,
  });
  try {
    first.setState(firstState);
    const second = await createCpu({
      compiler,
      code: { base: CODE, bytes: Uint8Array.of(0xb8, 0x22, 0, 0, 0, 0x89, 0x03) },
      ram: { base: RAM, bytes: new Uint8Array(8).fill(0x5a) },
      limits,
    });
    try {
      second.setState(secondState);
      assert.deepEqual(first.readState(), firstState);
      const firstRun = await first.run({ budget: 3n, stop: CODE + 7n });
      const firstExpected = state();
      firstExpected.registers[0] = 0x11n;
      firstExpected.rip = CODE + 7n;
      assert.equal(firstRun.reason, 'stop');
      assert.deepEqual(firstRun.state, firstExpected);
      assert.equal(firstRun.resources.compilations, 1);
      assert.deepEqual(second.readState(), secondState);
      assert.deepEqual(second.readMemory(RAM, 8), new Uint8Array(8).fill(0x5a));

      const secondRun = await second.run({ budget: 3n, stop: CODE + 7n });
      const secondExpected = state(0x8877_6655_0000_0000n, 0x97n);
      secondExpected.registers[0] = 0x22n;
      secondExpected.rip = CODE + 7n;
      assert.equal(secondRun.reason, 'stop');
      assert.deepEqual(secondRun.state, secondExpected);
      assert.equal(secondRun.resources.compilations, 1);
      assert.deepEqual(first.readState(), firstExpected);
      assert.deepEqual(
        first.readMemory(RAM, 8),
        Uint8Array.of(0x11, 0, 0, 0, 0xa5, 0xa5, 0xa5, 0xa5),
      );
      assert.deepEqual(
        second.readMemory(RAM, 8),
        Uint8Array.of(0x22, 0, 0, 0, 0x5a, 0x5a, 0x5a, 0x5a),
      );

      first.setState(firstState);
      const cached = await first.run({ budget: 3n, stop: CODE + 7n });
      assert.deepEqual(cached.state, firstExpected);
      assert.equal(cached.resources.compilations, 0);
      assert.deepEqual(second.readState(), secondExpected);
    } finally {
      second.dispose();
    }
  } finally {
    first.dispose();
  }
});
