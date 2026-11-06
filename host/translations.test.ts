import assert from 'node:assert/strict';
import test from 'node:test';
import { Translations, type Artifact } from './translations.js';

function artifact(entries: bigint[], byteLength: number): Artifact {
  return {
    run: () => assert.fail('the artifact owner must not execute guest code'),
    metadata: {
      entries,
      byteLength,
      instructionCount: entries.length,
      blockCount: entries.length,
      sourceBytes: entries.length,
      owner: 1n,
      dependencies: entries.map((start) => ({ start, length: 1 })),
    },
  };
}

test('eviction removes old aliases while preserving a newer entry owner', () => {
  const cache = new Translations(2, 100);
  const old = artifact([0x1000n, 0x1005n], 10);
  const newer = artifact([0x1005n, 0x1010n], 20);
  const third = artifact([0x2000n], 30);
  assert.equal(cache.install(old), true);
  const oldAlias = cache.get(0x1005n);
  assert.deepEqual(oldAlias, { artifact: old, index: 1 });
  assert.equal(cache.install(newer), true);
  const newAlias = cache.get(0x1005n);
  assert.deepEqual(newAlias, { artifact: newer, index: 0 });
  assert.notEqual(newAlias, oldAlias);

  assert.equal(cache.install(third), true);
  assert.equal(cache.get(0x1000n), undefined);
  assert.equal(cache.get(0x1005n), newAlias);
  assert.deepEqual(cache.get(0x1010n), { artifact: newer, index: 1 });
  assert.deepEqual(cache.get(0x2000n), { artifact: third, index: 0 });
  assert.deepEqual(cache.resources(), { cachedArtifacts: 2, cachedBytes: 50 });
});

test('installed aliases keep owner and index immutable across cache lookups', () => {
  const cache = new Translations(2, 100);
  const owner = artifact([0x1000n, 0x1005n], 10);
  const other = artifact([0x2000n], 20);
  cache.install(owner);
  const alias = cache.get(0x1005n);
  assert.ok(alias);
  assert.deepEqual(alias, { artifact: owner, index: 1 });
  assert.equal(Object.isFrozen(alias), true);
  assert.equal(Reflect.set(alias, 'artifact', other), false);
  assert.equal(Reflect.set(alias, 'index', 0), false);
  assert.equal(cache.get(0x1005n), alias);
  assert.deepEqual(cache.get(0x1005n), { artifact: owner, index: 1 });
});

test('using any entry retains the whole artifact under count-limited eviction', () => {
  const cache = new Translations(2, 100);
  const first = artifact([0x1000n, 0x1005n], 11);
  const second = artifact([0x2000n, 0x2005n], 13);
  const third = artifact([0x3000n], 17);
  cache.install(first);
  cache.install(second);
  assert.deepEqual(cache.get(0x1005n), { artifact: first, index: 1 });

  cache.install(third);
  assert.equal(cache.get(0x2000n), undefined);
  assert.equal(cache.get(0x2005n), undefined);
  assert.deepEqual(cache.get(0x1000n), { artifact: first, index: 0 });
  assert.deepEqual(cache.get(0x1005n), { artifact: first, index: 1 });
  assert.deepEqual(cache.get(0x3000n), { artifact: third, index: 0 });
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

  for (const pc of [1n, 2n, 3n, 4n]) assert.equal(cache.get(pc), undefined);
  assert.deepEqual(cache.get(5n), { artifact: replacement, index: 0 });
  assert.deepEqual(cache.get(6n), { artifact: replacement, index: 1 });
  assert.deepEqual(cache.resources(), { cachedArtifacts: 1, cachedBytes: 20 });
});

test('an oversized refusal preserves installed owners and permits an exact-fit artifact', () => {
  const cache = new Translations(2, 32);
  const first = artifact([1n], 12);
  const second = artifact([2n], 12);
  cache.install(first);
  cache.install(second);
  const firstAlias = cache.get(1n);
  const before = cache.inspect();
  assert.equal(cache.canFit(33), false);
  assert.equal(cache.install(artifact([3n], 33)), false);
  assert.equal(cache.get(1n), firstAlias);
  assert.deepEqual(cache.inspect(), before);
  assert.deepEqual(cache.resources(), { cachedArtifacts: 2, cachedBytes: 24 });

  const exact = artifact([4n], 32);
  assert.equal(cache.canFit(32), true);
  assert.equal(cache.install(exact), true);
  assert.equal(cache.get(1n), undefined);
  assert.equal(cache.get(2n), undefined);
  assert.deepEqual(cache.get(4n), { artifact: exact, index: 0 });
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
  for (const pc of [1n, 2n, 3n]) assert.equal(cache.get(pc), undefined);
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
  assert.equal(cache.get(1n), undefined);
  assert.equal(cache.get(2n)?.artifact, newer);
  assert.equal(cache.get(3n)?.artifact, newer);
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
