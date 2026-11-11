import assert from 'node:assert/strict';
import test from 'node:test';
import { Translations, type Artifact } from './translations.js';

function use(cache: Translations, pc: bigint, observed = false) {
  const entry = cache.candidates(pc, observed)[0];
  if (entry) cache.touch(entry.artifact);
  return entry;
}

function artifact(entries: bigint[], byteLength: number, boundaryObserved = false): Artifact {
  return {
    run: () => assert.fail('the artifact owner must not execute guest code'),
    metadata: {
      entries,
      byteLength,
      instructionCount: entries.length,
      blockCount: entries.length,
      sourceBytes: entries.length,
      owner: 1n,
      contextVersion: 0n,
      boundaryObserved,
      dependencies: entries.map((start) => ({ start, length: 1 })),
    },
  };
}

test('boundary variants retain independent same-PC and middle-entry ownership', () => {
  const released: Artifact[] = [];
  const cache = new Translations(3, 100, (owner) => released.push(owner));
  const fast = artifact([1n, 2n], 10);
  const observed = artifact([1n, 2n], 20, true);
  cache.install(fast);
  cache.install(observed);
  assert.equal(use(cache, 1n)?.artifact, fast);
  assert.equal(use(cache, 1n, true)?.artifact, observed);
  assert.equal(use(cache, 2n)?.index, 1);
  assert.equal(use(cache, 2n, true)?.index, 1);
  assert.deepEqual(cache.resources(), { cachedArtifacts: 2, cachedBytes: 30 });
  cache.prune((owner) => owner !== observed);
  assert.equal(use(cache, 1n)?.artifact, fast);
  assert.equal(use(cache, 1n, true), undefined);
  assert.deepEqual(released, [observed]);
  cache.clear();
  assert.deepEqual(released, [observed, fast]);
});

test('boundary variant LRU eviction removes only the selected profile bindings', () => {
  const cache = new Translations(2, 100);
  const fast = artifact([1n, 2n], 10);
  const observed = artifact([1n, 2n], 20, true);
  const third = artifact([3n], 30);
  cache.install(fast);
  cache.install(observed);
  use(cache, 2n);
  cache.install(third);
  assert.equal(use(cache, 1n)?.artifact, fast);
  assert.equal(use(cache, 2n)?.artifact, fast);
  assert.equal(use(cache, 1n, true), undefined);
  assert.equal(use(cache, 2n, true), undefined);
  assert.deepEqual(cache.resources(), { cachedArtifacts: 2, cachedBytes: 40 });
});

test('eviction removes old aliases while preserving a newer entry owner', () => {
  const cache = new Translations(2, 100);
  const old = artifact([0x1000n, 0x1005n], 10);
  const newer = artifact([0x1005n, 0x1010n], 20);
  const third = artifact([0x2000n], 30);
  assert.equal(cache.install(old), true);
  const oldAlias = use(cache, 0x1005n);
  assert.deepEqual(oldAlias, { artifact: old, index: 1 });
  assert.equal(cache.install(newer), true);
  const newAlias = use(cache, 0x1005n);
  assert.deepEqual(newAlias, { artifact: newer, index: 0 });
  assert.notEqual(newAlias, oldAlias);

  assert.equal(cache.install(third), true);
  assert.equal(use(cache, 0x1000n), undefined);
  assert.equal(use(cache, 0x1005n), newAlias);
  assert.deepEqual(use(cache, 0x1010n), { artifact: newer, index: 1 });
  assert.deepEqual(use(cache, 0x2000n), { artifact: third, index: 0 });
  assert.deepEqual(cache.resources(), { cachedArtifacts: 2, cachedBytes: 50 });
});

test('installed aliases keep owner and index immutable across cache lookups', () => {
  const cache = new Translations(2, 100);
  const owner = artifact([0x1000n, 0x1005n], 10);
  const other = artifact([0x2000n], 20);
  cache.install(owner);
  const alias = use(cache, 0x1005n);
  assert.ok(alias);
  assert.deepEqual(alias, { artifact: owner, index: 1 });
  assert.equal(Object.isFrozen(alias), true);
  assert.equal(Reflect.set(alias, 'artifact', other), false);
  assert.equal(Reflect.set(alias, 'index', 0), false);
  assert.equal(use(cache, 0x1005n), alias);
  assert.deepEqual(use(cache, 0x1005n), { artifact: owner, index: 1 });
});

test('using any entry retains the whole artifact under count-limited eviction', () => {
  const cache = new Translations(2, 100);
  const first = artifact([0x1000n, 0x1005n], 11);
  const second = artifact([0x2000n, 0x2005n], 13);
  const third = artifact([0x3000n], 17);
  cache.install(first);
  cache.install(second);
  assert.deepEqual(use(cache, 0x1005n), { artifact: first, index: 1 });

  cache.install(third);
  assert.equal(use(cache, 0x2000n), undefined);
  assert.equal(use(cache, 0x2005n), undefined);
  assert.deepEqual(use(cache, 0x1000n), { artifact: first, index: 0 });
  assert.deepEqual(use(cache, 0x1005n), { artifact: first, index: 1 });
  assert.deepEqual(use(cache, 0x3000n), { artifact: third, index: 0 });
  assert.deepEqual(cache.resources(), { cachedArtifacts: 2, cachedBytes: 28 });
});

test('byte pressure can evict multiple artifacts without leaving their entries', () => {
  const cache = new Translations(4, 30);
  const first = artifact([1n, 2n], 12);
  const second = artifact([3n, 4n], 12);
  const replacement = artifact([5n, 6n], 20);
  cache.install(first);
  cache.install(second);
  assert.equal(cache.install(replacement), true);

  for (const pc of [1n, 2n, 3n, 4n]) assert.equal(use(cache, pc), undefined);
  assert.deepEqual(use(cache, 5n), { artifact: replacement, index: 0 });
  assert.deepEqual(use(cache, 6n), { artifact: replacement, index: 1 });
  assert.deepEqual(cache.resources(), { cachedArtifacts: 1, cachedBytes: 20 });
});

test('an oversized refusal preserves installed owners and permits an exact-fit artifact', () => {
  const cache = new Translations(2, 32);
  const first = artifact([1n], 12);
  const second = artifact([2n], 12);
  cache.install(first);
  cache.install(second);
  const firstAlias = use(cache, 1n);
  const before = cache.inspect();
  assert.equal(cache.canFit(33), false);
  assert.equal(cache.install(artifact([3n], 33)), false);
  assert.equal(use(cache, 1n), firstAlias);
  assert.deepEqual(cache.inspect(), before);
  assert.deepEqual(cache.resources(), { cachedArtifacts: 2, cachedBytes: 24 });

  const exact = artifact([4n], 32);
  assert.equal(cache.canFit(32), true);
  assert.equal(cache.install(exact), true);
  assert.equal(use(cache, 1n), undefined);
  assert.equal(use(cache, 2n), undefined);
  assert.deepEqual(use(cache, 4n), { artifact: exact, index: 0 });
  assert.deepEqual(cache.resources(), { cachedArtifacts: 1, cachedBytes: 32 });
});

test('inspection returns owned metadata and clear releases all entry ownership', () => {
  const cache = new Translations(2, 100);
  const first = artifact([1n, 2n], 10);
  const second = artifact([2n, 3n], 20);
  cache.install(first);
  cache.install(second);
  const observed = cache.inspect();
  observed[0]!.entries.splice(0);
  observed[0]!.byteLength = 999;
  assert.deepEqual(
    cache.inspect().map((value) => value.entries),
    [
      [1n, 2n],
      [2n, 3n],
    ],
  );
  assert.deepEqual(cache.resources(), { cachedArtifacts: 2, cachedBytes: 30 });

  cache.clear();
  for (const pc of [1n, 2n, 3n]) assert.equal(use(cache, pc), undefined);
  assert.deepEqual(cache.inspect(), []);
  assert.deepEqual(cache.resources(), { cachedArtifacts: 0, cachedBytes: 0 });
});

test('invalidation removes a complete owner without erasing a newer overlapping binding', () => {
  const released: Artifact[] = [];
  const cache = new Translations(3, 100, (owner) => released.push(owner));
  const old = artifact([1n, 2n], 10);
  const newer = artifact([2n, 3n], 20);
  cache.install(old);
  cache.install(newer);
  cache.prune((owner) => owner !== old);
  assert.equal(use(cache, 1n), undefined);
  assert.equal(use(cache, 2n)?.artifact, newer);
  assert.equal(use(cache, 3n)?.artifact, newer);
  assert.deepEqual(cache.resources(), { cachedArtifacts: 1, cachedBytes: 20 });
  assert.deepEqual(released, [old]);
  cache.prune(() => true);
  assert.deepEqual(released, [old]);
  cache.clear();
  assert.deepEqual(released, [old, newer]);
});

test('count eviction releases dependency ownership exactly once', () => {
  const released: Artifact[] = [];
  const cache = new Translations(1, 100, (owner) => released.push(owner));
  const first = artifact([1n], 10);
  const second = artifact([2n], 20);
  cache.install(first);
  cache.install(second);
  assert.deepEqual(released, [first]);
  cache.clear();
  cache.clear();
  assert.deepEqual(released, [first, second]);
});

test('same-PC context candidates retain every owner and middle alias without changing recency', () => {
  const released: Artifact[] = [];
  const cache = new Translations(2, 100, (value) => released.push(value));
  const a = artifact([1n, 2n], 10);
  const b = artifact([2n, 3n], 20);
  const c = artifact([4n], 30);
  cache.install(a);
  cache.install(b);
  assert.deepEqual(cache.candidates(2n), [
    { artifact: b, index: 0 },
    { artifact: a, index: 1 },
  ]);
  assert.deepEqual(cache.candidates(2n, true), []);
  cache.install(c);
  assert.deepEqual(released, [a], 'merely scanning incompatible candidates cannot warm A');
  assert.deepEqual(cache.candidates(2n), [{ artifact: b, index: 0 }]);
  assert.deepEqual(cache.candidates(1n), []);
  assert.deepEqual(cache.resources(), { cachedArtifacts: 2, cachedBytes: 50 });
});

test('only actual admitted use moves an entire context variant in the global LRU', () => {
  const released: Artifact[] = [];
  const cache = new Translations(2, 100, (value) => released.push(value));
  const a = artifact([1n, 2n], 10);
  const b = artifact([2n, 3n], 20);
  const c = artifact([4n], 30, true);
  cache.install(a);
  cache.install(b);
  const older = cache.candidates(2n)[1];
  assert.ok(older);
  cache.touch(older.artifact);
  cache.install(c);
  assert.deepEqual(released, [b]);
  assert.deepEqual(cache.candidates(1n), [{ artifact: a, index: 0 }]);
  assert.deepEqual(cache.candidates(2n), [{ artifact: a, index: 1 }]);
  assert.deepEqual(cache.candidates(3n), []);
  assert.deepEqual(cache.candidates(4n, true), [{ artifact: c, index: 0 }]);
  assert.deepEqual(cache.resources(), { cachedArtifacts: 2, cachedBytes: 40 });
});

test('discarding one dormant owner preserves overlapping candidates and never resurrects on touch', () => {
  const released: Artifact[] = [];
  const cache = new Translations(3, 100, (value) => released.push(value));
  const a = artifact([1n, 2n], 10);
  const b = artifact([2n, 3n], 20);
  cache.install(a);
  cache.install(b);
  const pendingScan = cache.candidates(2n);
  cache.remove(b);
  assert.deepEqual(
    pendingScan,
    [
      { artifact: b, index: 0 },
      { artifact: a, index: 1 },
    ],
    'an in-flight finite scan keeps its stable candidate view',
  );
  assert.deepEqual(cache.candidates(2n), [{ artifact: a, index: 1 }]);
  cache.touch(b);
  cache.remove(b);
  assert.deepEqual(cache.resources(), { cachedArtifacts: 1, cachedBytes: 10 });
  assert.deepEqual(released, [b], 'release is exactly once');
  cache.clear();
  assert.deepEqual(released, [b, a]);
});
