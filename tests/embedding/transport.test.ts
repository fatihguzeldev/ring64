import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createCpu } from '../../host/index.js';
import { Core, type GeneratedRun } from '../../host/core.js';
import { LIMITS, initial } from '../support/fixture.js';

const compiler = await WebAssembly.compile(
  new Uint8Array(await readFile(new URL('../../build/ring64.wasm', import.meta.url))),
);
const exports = WebAssembly.Module.exports(compiler)
  .filter(({ kind }) => kind === 'function')
  .map(({ name }) => name);
const encoder = new TextEncoder();

function unsigned(value: number): number[] {
  const bytes: number[] = [];
  do {
    const byte = value % 128;
    value = Math.floor(value / 128);
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
  return bytes;
}

function signed(value: number): number[] {
  const bytes: number[] = [];
  for (;;) {
    const byte = value & 127;
    value >>= 7;
    const done = (value === 0 && !(byte & 64)) || (value === -1 && !!(byte & 64));
    bytes.push(byte | (done ? 0 : 128));
    if (done) return bytes;
  }
}

function text(value: string): number[] {
  const bytes = [...encoder.encode(value)];
  return [...unsigned(bytes.length), ...bytes];
}
const section = (id: number, bytes: number[]) => [id, ...unsigned(bytes.length), ...bytes];
const constant = (value: number) => [0x41, ...signed(value | 0)];

type HighPointer = 'input' | 'state' | 'info' | 'output' | 'later-input';

async function fixture(
  high: HighPointer,
  initializationError = false,
): Promise<WebAssembly.Module> {
  const input = high === 'input' ? 0x8000_0100 : 0x100;
  const state = high === 'state' ? 0x8000_1000 : 0x1000;
  const info = high === 'info' ? 0x8000_2000 : 0x2000;
  const output = high === 'output' ? 0x8000_3000 : 0x3000;
  const imported = high === 'later-input' ? 0x8000_0100 : input;
  const metadata = encoder.encode(
    JSON.stringify(
      initializationError
        ? { error: 'fixture initialization rejected' }
        : {
            size: 448,
            scalarSize: 176,
            xmm: 176,
            xmmBytes: 256,
            vectorScratch: 432,
            registers: 0,
            flags: 128,
            rip: 136,
            remaining: 144,
            repeatRemaining: 168,
            reasons: ['dispatch', 'budget', 'stop'],
          },
    ),
  );
  const values: Record<string, number> = {
    core_input: input,
    core_init_mapped: initializationError ? 1 : 0,
    core_state_ptr: state,
    core_info_ptr: info,
    core_info_len: metadata.length,
    core_output_ptr: output,
    core_output_len: 4,
  };
  const copy = (destination: number, source: number, length: number) => [
    ...constant(destination),
    ...constant(source),
    ...constant(length),
    0xfc,
    0x0a,
    0,
    0, // memory.copy
    ...constant(0),
  ];
  const bodies = exports.map((name) => {
    let instructions = constant(values[name] ?? 0);
    if (name === 'core_import_state') instructions = copy(state, imported, 176);
    if (name === 'core_import_xmm') instructions = copy(state + 176, imported, 256);
    if (name === 'core_write_memory') instructions = copy(output, imported, 4);
    if (name === 'core_input' && high === 'later-input') {
      instructions = [
        0x20,
        0,
        ...constant(176),
        0x46,
        0x20,
        0,
        ...constant(4),
        0x46,
        0x72,
        0x20,
        0,
        ...constant(256),
        0x46,
        0x72,
        0x04,
        0x7f,
        ...constant(imported),
        0x05,
        ...constant(input),
        0x0b,
      ];
    }
    const body = [0, ...instructions, 0x0b];
    return [...unsigned(body.length), ...body];
  });
  // Reserve sparse virtual memory; only the small transport records occupy pages.
  return WebAssembly.compile(
    new Uint8Array([
      0,
      97,
      115,
      109,
      1,
      0,
      0,
      0,
      ...section(1, [2, 0x60, 0, 1, 0x7f, 0x60, 1, 0x7f, 1, 0x7f]),
      ...section(3, [
        ...unsigned(exports.length),
        ...exports.map((name) => Number(name === 'core_input')),
      ]),
      ...section(5, [1, 0, ...unsigned(32769)]),
      ...section(7, [
        ...unsigned(exports.length + 1),
        ...text('memory'),
        2,
        0,
        ...exports.flatMap((name, index) => [...text(name), 0, ...unsigned(index)]),
      ]),
      ...section(10, [...unsigned(bodies.length), ...bodies.flat()]),
      ...section(11, [
        2,
        0,
        ...constant(info),
        0x0b,
        ...unsigned(metadata.length),
        ...metadata,
        0,
        ...constant(output),
        0x0b,
        4,
        0x11,
        0x22,
        0x33,
        0x44,
      ]),
    ]),
  );
}

const options = (module: WebAssembly.Module) => ({
  compiler: module,
  memory: { backings: [], mappings: [] },
  memoryLimits: { maxBackingBytes: 1, maxBackings: 1, maxMappings: 1 },
  entry: 0n,
  limits: LIMITS,
});

for (const high of ['input', 'state', 'info', 'output', 'later-input'] as const) {
  test(`wasm32 ${high} transport pointers retain their unsigned address above 2 GiB`, async () => {
    const cpu = await createCpu(options(await fixture(high)));
    try {
      const xmm = Array.from(
        { length: 16 },
        (_, index) => 0xfedc_ba98_7654_3210_0123_4567_89ab_cde0n + BigInt(index),
      );
      assert.deepEqual(cpu.readXmmState(), Array<bigint>(16).fill(0n));
      cpu.setXmmState(xmm);
      assert.deepEqual(cpu.readXmmState(), xmm);
      const state = initial(0x1234n, { 0: 0x8877_6655_4433_2211n }, 0x8d7n);
      cpu.setState(state);
      assert.deepEqual(cpu.readState(), state);
      assert.deepEqual(cpu.readXmmState(), xmm);
      assert.deepEqual(cpu.readMemory(0n, 4), Uint8Array.of(0x11, 0x22, 0x33, 0x44));
      cpu.writeMemory(0n, Uint8Array.of(0x55, 0x66, 0x77, 0x88));
      assert.deepEqual(cpu.readMemory(0n, 4), Uint8Array.of(0x55, 0x66, 0x77, 0x88));
      cpu.setXmmState(xmm.slice().reverse());
      assert.deepEqual(cpu.readXmmState(), xmm.slice().reverse());
      assert.deepEqual(cpu.readState(), state);
    } finally {
      cpu.dispose();
    }
  });
}

test('initialization errors are decoded from unsigned high wasm32 info pointers', async () => {
  await assert.rejects(createCpu(options(await fixture('info', true))), {
    name: 'TypeError',
    message: 'fixture initialization rejected',
  });
});

test('native entry seeds repetition transport without changing the generated five-argument ABI', async () => {
  const input = options(await fixture('state'));
  const core = await Core.create(input.compiler, {
    ...input.memory,
    entry: input.entry,
    memoryLimits: input.memoryLimits,
  });
  // Literal generated probe copies repeat_remaining to RAX and its budget argument to remaining.
  const body = [
    0,
    0x20,
    0,
    0x20,
    0,
    0x29,
    3,
    ...unsigned(168),
    0x37,
    3,
    0,
    0x20,
    0,
    0x20,
    1,
    0x37,
    3,
    ...unsigned(144),
    ...constant(1),
    0x0b,
  ];
  const module = await WebAssembly.compile(
    new Uint8Array([
      0,
      97,
      115,
      109,
      1,
      0,
      0,
      0,
      ...section(1, [1, 0x60, 5, 0x7f, 0x7e, 0x7e, 0x7f, 0x7f, 1, 0x7f]),
      ...section(2, [1, ...text('env'), ...text('memory'), 2, 0, 0]),
      ...section(3, [1, 0]),
      ...section(7, [1, ...text('run'), 0, 0]),
      ...section(10, [1, ...unsigned(body.length), ...body]),
    ]),
  );
  const generated = core.instantiate(module);
  const calls: Parameters<GeneratedRun>[] = [];
  const run: GeneratedRun = (...args) => {
    calls.push(args);
    return generated(...args);
  };
  try {
    const xmm = Array.from(
      { length: 16 },
      (_, index) => 0x8877_6655_4433_2211_ffe0_ddcc_bbaa_9900n + BigInt(index),
    );
    core.setXmmState(xmm);
    for (const allowance of [(1n << 64n) - 1n, 0n, 17n]) {
      assert.equal(core.execute(run, 3, 9n, 0x1234n, allowance), 'budget');
      assert.equal(core.snapshot().registers[0], allowance);
      assert.deepEqual(core.current(), { rip: 0n, remaining: 9n, repeatRemaining: allowance });
      assert.deepEqual(core.readXmmState(), xmm);
    }
    assert.deepEqual(calls, Array(3).fill([0x8000_1000, 9n, 0x1234n, 1, 3]));
  } finally {
    core.dispose();
  }
});
