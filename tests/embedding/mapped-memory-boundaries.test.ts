import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createCpu, type MemoryMapping } from '../../host/index.js';
import { Core } from '../../host/core.js';
import { LIMITS, changed, initial } from '../support/fixture.js';

const compiler = await WebAssembly.compile(
  new Uint8Array(await readFile(new URL('../../build/ring64.wasm', import.meta.url))),
);

const simpleOptions = () => ({
  compiler,
  memory: {
    backings: [{ id: 'code', bytes: Uint8Array.of(0xb8, 1, 0, 0, 0) }],
    mappings: [
      {
        base: 0x1000n,
        backing: 'code',
        offset: 0,
        length: 5,
        permissions: { read: true, write: true, execute: true },
      },
    ],
  },
  entry: 0x1000n,
  memoryLimits: { maxBackings: 1, maxMappings: 1, maxBackingBytes: 5 },
  limits: { ...LIMITS, maxTranslationsPerRun: 2 },
});

test('backing identities preserve exact UTF-16 names through creation mutation and recreation', async () => {
  // These include unpaired surrogates and strings resembling a transport encoding.
  const names = ['\ud800', '\udc00', '😀', 'd800', '\\ud800', '0041', 'A'];
  const code = (value: number) => Uint8Array.of(0xb8, value, 0, 0, 0);
  const maps: MemoryMapping[] = names.map((backing, index) => ({
    base: 0x1000n + BigInt(index * 0x100),
    backing,
    offset: 0,
    length: 5,
    permissions: { read: true, write: false, execute: true },
  }));
  const cpu = await createCpu({
    compiler,
    memory: {
      backings: names.map((id, index) => ({ id, bytes: code(index + 1) })),
      mappings: maps,
    },
    entry: 0x1000n,
    memoryLimits: { maxBackings: 7, maxMappings: 7, maxBackingBytes: 35 },
    limits: LIMITS,
  });
  try {
    for (const [index, mapping] of maps.entries()) {
      const input = initial(mapping.base, {}, 0x8d7n);
      cpu.setState(input);
      const result = await cpu.run({ budget: 1n });
      assert.equal(result.reason, 'budget');
      assert.deepEqual(result.state, changed(input, mapping.base + 5n, { 0: BigInt(index + 1) }));
      assert.deepEqual(cpu.readMemory(mapping.base, 5), code(index + 1));
    }
    assert.equal(cpu.inspectTranslations().length, names.length);
    cpu.setMappings([]);
    assert.deepEqual(cpu.inspectTranslations(), []);
    for (const id of names) cpu.removeBacking(id);
    for (const [index, id] of names.entries()) cpu.addBacking({ id, bytes: code(index + 21) });
    cpu.setMappings([...maps].reverse());
    for (const [index, mapping] of maps.entries()) {
      const input = initial(mapping.base);
      cpu.setState(input);
      const result = await cpu.run({ budget: 1n });
      assert.equal(result.resources.compilations, 1);
      assert.deepEqual(result.state, changed(input, mapping.base + 5n, { 0: BigInt(index + 21) }));
      assert.deepEqual(cpu.readMemory(mapping.base, 5), code(index + 21));
    }
  } finally {
    cpu.dispose();
  }
});

test('unexpected validity and release failures poison post-mutation lifecycle', async () => {
  for (const operation of ['maps', 'write'] as const) {
    for (const failure of ['valid', 'release'] as const) {
      const cpu = await createCpu(simpleOptions());
      await cpu.run({ budget: 1n });
      const valid = Core.prototype.valid;
      const release = Core.prototype.release;
      if (failure === 'valid')
        Core.prototype.valid = () => {
          throw new RangeError('unexpected validity failure');
        };
      else
        Core.prototype.release = () => {
          throw new TypeError('unexpected release failure');
        };
      try {
        const mutate =
          operation === 'maps'
            ? () => cpu.setMappings([])
            : () => cpu.writeMemory(0x1000n, Uint8Array.of(0xb8));
        assert.throws(mutate, /cpu engine failed/);
        assert.throws(() => cpu.readState(), /failed/);
        assert.throws(() => cpu.inspectTranslations(), /failed/);
        await assert.rejects(cpu.run({ budget: 0n }), /failed/);
      } finally {
        Core.prototype.valid = valid;
        Core.prototype.release = release;
        cpu.dispose();
      }
    }
  }
});

test('obsolete compilation owner is released before a fresh artifact is published', async () => {
  const cpu = await createCpu(simpleOptions());
  const valid = Core.prototype.valid;
  const release = Core.prototype.release;
  const instantiate = Core.prototype.instantiate;
  let obsolete: bigint | undefined;
  let instantiations = 0;
  const released: bigint[] = [];
  const releasedValidity: boolean[] = [];
  Core.prototype.valid = function (owner) {
    if (obsolete === undefined) {
      obsolete = owner;
      return false;
    }
    return valid.call(this, owner);
  };
  Core.prototype.release = function (owner) {
    released.push(owner);
    release.call(this, owner);
    releasedValidity.push(valid.call(this, owner));
  };
  Core.prototype.instantiate = function (module) {
    instantiations++;
    return instantiate.call(this, module);
  };
  try {
    const input = initial();
    cpu.setState(input);
    const result = await cpu.run({ budget: 1n });
    assert.equal(result.reason, 'budget');
    assert.equal(result.retired, 1n);
    assert.equal(result.resources.compilations, 2);
    assert.equal(result.resources.nativeEntries, 1);
    assert.equal(instantiations, 1);
    assert.deepEqual(result.state, changed(input, 0x1005n, { 0: 1n }));
    assert.ok(obsolete !== undefined);
    assert.deepEqual(released, [obsolete]);
    assert.deepEqual(releasedValidity, [false]);
    const retained = cpu.inspectTranslations();
    assert.equal(retained.length, 1);
    assert.notEqual(retained[0]!.owner, obsolete);
  } finally {
    Core.prototype.valid = valid;
    Core.prototype.release = release;
    Core.prototype.instantiate = instantiate;
    cpu.dispose();
  }
});

test('reentrant backing additions revalidate current capacity and names before publishing', async () => {
  for (const conflict of ['capacity', 'duplicate'] as const) {
    const options = simpleOptions();
    const cpu = await createCpu({
      ...options,
      memoryLimits: {
        maxBackings: 3,
        maxMappings: 3,
        maxBackingBytes: conflict === 'capacity' ? 6 : 7,
      },
    });
    try {
      await cpu.run({ budget: 1n });
      const state = cpu.readState();
      const cache = cpu.inspectTranslations();
      const innerId = conflict === 'capacity' ? 'inner' : 'same';
      const outerId = conflict === 'capacity' ? 'outer' : 'same';
      const outer = {
        id: outerId,
        get bytes() {
          cpu.addBacking({ id: innerId, bytes: Uint8Array.of(0x11) });
          return Uint8Array.of(0x22);
        },
      };
      assert.throws(() => cpu.addBacking(outer), conflict === 'capacity' ? RangeError : TypeError);
      assert.deepEqual(cpu.readState(), state);
      assert.deepEqual(cpu.inspectTranslations(), cache);
      cpu.setMappings([
        ...options.memory.mappings,
        {
          base: 0x4000n,
          backing: innerId,
          offset: 0,
          length: 1,
          permissions: { read: true, write: true, execute: false },
        },
      ]);
      assert.deepEqual(cpu.readMemory(0x4000n, 1), Uint8Array.of(0x11));
      if (conflict === 'capacity') assert.throws(() => cpu.removeBacking('outer'), TypeError);
      assert.deepEqual(cpu.inspectTranslations(), cache);
    } finally {
      cpu.dispose();
    }
  }
});
