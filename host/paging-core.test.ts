import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createCpu, type Options, type PagingState } from './index.js';
import { protectedSnapshot } from '../tests/support/context.js';

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
const physical = 1n << 51n;
const bank = (): PagingState => ({
  cr0: 0x80010033n,
  cr2: 0x800000000000n,
  cr3: 0x1000n,
  cr4: 0x628n,
  efer: 0xd00n,
});
function options(paging = bank()): Options {
  return {
    compiler,
    limits,
    memoryModel: 'ia32e-paged',
    entry: 0x400000n,
    paging,
    memory: {
      backings: [{ id: 'bytes', bytes: Uint8Array.from({ length: 16 }, (_, i) => i) }],
      mappings: [
        {
          base: physical,
          backing: 'bytes',
          offset: 0,
          length: 16,
          permissions: { read: true, write: true, execute: true },
        },
      ],
    },
    memoryLimits: { maxBackings: 1, maxBackingBytes: 16, maxMappings: 2 },
  };
}

test('real core exposes the independent bank and physical plane without walking an unbacked root', async () => {
  const cpu = await createCpu(options());
  try {
    assert.deepEqual(cpu.readPagingState(), bank());
    const scalar = cpu.readState();
    assert.deepEqual(cpu.readPhysicalMemory(physical, 8), Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7));
    const input = Uint8Array.of(0xaa, 0xbb);
    cpu.writePhysicalMemory(physical + 4n, input);
    input[0] = 0;
    assert.deepEqual(
      cpu.readPhysicalMemory(physical, 8),
      Uint8Array.of(0, 1, 2, 3, 0xaa, 0xbb, 6, 7),
    );
    assert.deepEqual(cpu.readPagingState(), bank());
    assert.deepEqual(cpu.readState(), scalar);
    cpu.setMappings([
      {
        base: (1n << 52n) - 8n,
        backing: 'bytes',
        offset: 8,
        length: 8,
        permissions: { read: true, write: true, execute: false },
      },
    ]);
    assert.deepEqual(cpu.readPhysicalMemory((1n << 52n) - 1n, 1), Uint8Array.of(15));
    assert.throws(() => cpu.readPhysicalMemory((1n << 52n) - 1n, 2), RangeError);
    assert.deepEqual(cpu.readPagingState(), bank());
  } finally {
    cpu.dispose();
  }
});

test('real core validates the complete normalized import atomically while CR2 remains raw', async () => {
  const cpu = await createCpu(options());
  try {
    const before = cpu.readPagingState();
    for (const changed of [
      { cr0: 0n },
      { cr0: before.cr0 | 8n },
      { cr3: 0x1001n },
      { cr3: 1n << 52n },
      { cr4: 0n },
      { efer: 0x100n },
    ]) {
      assert.throws(() => cpu.setPagingState({ ...before, ...changed }), TypeError);
      assert.deepEqual(cpu.readPagingState(), before);
    }
    const repaired = {
      ...before,
      cr0: 0x80000033n,
      cr2: 0xffffffffffffffffn,
      cr3: 0xffffffffff018n,
      efer: 0x500n,
    };
    cpu.setPagingState(repaired);
    assert.deepEqual(cpu.readPagingState(), repaired);
    const detached = cpu.readPagingState();
    detached.cr3 = 0n;
    assert.deepEqual(cpu.readPagingState(), repaired);
  } finally {
    cpu.dispose();
  }
  await assert.rejects(createCpu(options({ ...bank(), cr4: 0n })), TypeError);
});

test('real pending PF source survives live bank repair and rejects an incompatible context before cancellation', async () => {
  const cpu = await createCpu(options());
  try {
    cpu.setState({
      registers: Array<bigint>(16).fill(0n),
      flags: 0x202n,
      rip: 0x400000n,
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
    });
    const selected = cpu.readState();
    const repair = { ...bank(), cr2: 0xffffffffffffffffn, cr3: 0x2000n, efer: 0x500n };
    cpu.setPagingState(repair);
    assert.deepEqual(cpu.readState(), selected);
    assert.deepEqual(cpu.readPagingState(), repair);
    assert.throws(() => cpu.setContext(protectedSnapshot()), TypeError);
    assert.deepEqual(cpu.readState(), selected);
    cpu.setState(selected);
    assert.deepEqual(
      cpu.readPagingState(),
      repair,
      'scalar event import cannot overwrite CR2/root',
    );
    cpu.setContext(cpu.readContext());
    assert.deepEqual(cpu.readState().event, { kind: 'ready' });
    assert.deepEqual(cpu.readPagingState(), repair);
  } finally {
    cpu.dispose();
  }
});

test('linear real core rejects new projections and PF imports without changing its scalar state', async () => {
  const cpu = await createCpu({
    compiler,
    limits,
    code: { base: 0x1000n, bytes: Uint8Array.of(0x90) },
    ram: { base: 0x4000n, bytes: Uint8Array.of(7) },
  });
  try {
    const before = cpu.readState();
    assert.throws(() => cpu.readPagingState(), TypeError);
    assert.throws(() => cpu.readPhysicalMemory(0x4000n, 1), TypeError);
    assert.throws(
      () =>
        cpu.setState({
          ...before,
          event: {
            kind: 'pending',
            exception: {
              vector: 14,
              instructionPc: before.rip,
              returnPc: before.rip,
              savedFlags: before.flags | 0x10000n,
              errorCode: 0,
              pageFaultAddress: 0x5000n,
            },
          },
        }),
      TypeError,
    );
    assert.deepEqual(cpu.readState(), before);
    assert.deepEqual(cpu.readMemory(0x4000n, 1), Uint8Array.of(7));
  } finally {
    cpu.dispose();
  }
});
