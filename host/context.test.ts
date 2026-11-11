import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captureContext,
  contextFromJson,
  type ContextInfo,
  type ExecutionContext,
  type LoadedSegment,
} from './context.js';
import { longSnapshot, protectedSnapshot } from '../tests/support/context.js';

const data = (): LoadedSegment => ({
  base: 0n,
  limit: 0xffffffff,
  default32: true,
  usable: true,
  type: 'read-write',
});
function input(): ExecutionContext {
  return {
    mode: 'protected',
    segments: {
      cs: { ...data(), type: 'readable-code' },
      ss: data(),
      ds: data(),
      es: data(),
      fs: data(),
      gs: data(),
    },
  };
}

test('legacy context capture produces a complete deterministic owned snapshot', () => {
  const captured = captureContext({ mode: 'long64', fsBase: 0x1234n, gsBase: 0n });
  assert.deepEqual(captured, longSnapshot(0x1234n));
});

test('task register output is required while older full input defaults to an invalid fresh cache', () => {
  const source = longSnapshot();
  Reflect.deleteProperty(source, 'tr');
  const expected = {
    ...source,
    tr: { selector: 0, valid: false, base: 0n, limit: 0, attributes: 0 },
  };
  assert.deepEqual(captureContext(source), expected);
  assert.deepEqual(captureContext({ mode: 'long64', fsBase: 0n, gsBase: 0n }), expected);
});

test('task register capture preserves bounded raw facts without normalizing their usability', () => {
  const tr = {
    selector: 0xffff,
    valid: false,
    base: 0xffffffffffffffffn,
    limit: 0xffffffff,
    attributes: 0xfff,
  };
  const source = { ...longSnapshot(), tr };
  const expected = structuredClone(source);
  const captured = captureContext(source);
  assert.deepEqual(captured, expected);
  const json = JSON.parse(
    JSON.stringify(source, (_, value: unknown) =>
      typeof value === 'bigint' ? `0x${value.toString(16)}` : value,
    ),
  ) as ContextInfo;
  assert.deepEqual(contextFromJson(json), expected);
  tr.base = 0n;
  tr.attributes = 0;
  assert.deepEqual(captured, expected);
  assert.notEqual(captured.tr, tr);
});

test('task register presence selects full validation and malformed present values never default', () => {
  for (const tr of [undefined, null, [], {}, 0, false]) {
    assert.throws(() => captureContext({ ...longSnapshot(), tr } as ExecutionContext), TypeError);
    assert.throws(
      () => captureContext({ ...input(), tr } as ExecutionContext),
      TypeError,
      'TR cannot augment a legacy shorthand without the other full fields',
    );
  }
  for (const [key, values] of [
    ['selector', [-1, 0x10000, 1.5, '8']],
    ['valid', [undefined, 0, 1]],
    ['base', [-1n, 1n << 64n, 0]],
    ['limit', [-1, 0x100000000, NaN]],
    ['attributes', [-1, 0x1000, 1.5]],
  ] as const) {
    for (const value of values) {
      const source = { ...longSnapshot(), tr: { ...longSnapshot().ldtr } };
      Reflect.set(source.tr, key, value);
      assert.throws(() => captureContext(source), TypeError, `invalid TR ${key}`);
    }
  }
});

test('task register base domain follows execution family without canonicalizing imported raw caches', () => {
  for (const mode of ['long64', 'compatibility', 'protected', 'real'] as const) {
    const source = { ...longSnapshot(), mode, tr: { ...longSnapshot().ldtr, base: 0x100000000n } };
    source.segments.cs.long = mode === 'long64';
    source.segments.cs.default32 = mode !== 'long64';
    if (mode === 'long64' || mode === 'compatibility')
      assert.equal(captureContext(source).tr.base, 0x100000000n);
    else assert.throws(() => captureContext(source), TypeError);
  }
});

test('far full compatibility snapshots retain raw non-CS bases and unusable or unusual SS', () => {
  for (const type of [
    'code',
    'readable-code',
    'read-only',
    'read-write',
    'expand-down-read-only',
    'expand-down-read-write',
  ] as const) {
    for (const usable of [false, true]) {
      const source = longSnapshot(0xffff800000005000n, 0x100006000n);
      source.mode = 'compatibility';
      source.cpl = 1;
      source.segments.cs.long = false;
      source.segments.cs.default32 = true;
      source.segments.ss.type = type;
      source.segments.ss.usable = usable;
      source.segments.ss.selector = 1;
      for (const name of ['ss', 'ds', 'es'] as const)
        source.segments[name].base = 0x1234567800007000n;
      assert.deepEqual(captureContext(source), source);
    }
  }
});

test('far snapshot widening keeps legacy shorthand and IA-32e FS GS validation strict', () => {
  for (const [key, value] of [
    ['base', 0x100000000n],
    ['usable', false],
    ['type', 'read-only'],
  ] as const) {
    const source = input();
    if (source.mode === 'long64') assert.fail();
    source.mode = 'compatibility';
    Reflect.set(source.segments.ss, key, value);
    assert.throws(() => captureContext(source), TypeError);
  }
  for (const mode of ['long64', 'compatibility'] as const)
    for (const segment of ['fs', 'gs'] as const)
      for (const base of [0x800000000000n, 0xffff7ffffffffffen, 1n << 64n]) {
        const source = longSnapshot();
        source.mode = mode;
        source.segments[segment].base = base;
        assert.throws(() => captureContext(source), TypeError);
      }
  const source = longSnapshot();
  source.mode = 'compatibility';
  source.segments.cs.base = 0x100000000n;
  assert.throws(() => captureContext(source), TypeError);
});

test('context capture owns every loaded segment and reads each field once', () => {
  const value = input();
  assert.notEqual(value.mode, 'long64');
  if (value.mode === 'long64') assert.fail();
  const expected = protectedSnapshot();
  const reads: string[] = [];
  const source = value.segments.ds;
  for (const key of ['base', 'limit', 'default32', 'usable', 'type'] as const) {
    const original = source[key];
    Object.defineProperty(source, key, {
      get() {
        reads.push(key);
        return original;
      },
    });
  }
  const captured = captureContext(value);
  assert.deepEqual(captured, expected);
  assert.deepEqual(reads, ['base', 'limit', 'default32', 'usable', 'type']);
  value.segments.fs.base = 7n;
  assert.deepEqual(captured, expected);
});

test('full snapshot capture preserves raw hidden caches and IA-32e roots independently', () => {
  const source = longSnapshot(0xffff800000001000n);
  source.cpl = 2;
  source.gdtr = { base: 0x800000000000n, limit: 0xffff };
  source.idtr = { base: 0xffffffffffffffffn, limit: 9 };
  source.ldtr = {
    selector: 0xffff,
    valid: true,
    base: 0x100000000n,
    limit: 0x12345678,
    attributes: 0xfff,
  };
  source.segments.ss = {
    selector: 2,
    base: 0n,
    limit: 0,
    default32: false,
    usable: false,
    type: 'read-only',
    dpl: 0,
    present: false,
    conforming: false,
    accessed: false,
    long: false,
    granularity: false,
    available: false,
  };
  source.segments.ds.selector = 0xfffc;
  source.segments.ds.base = 0x123456789abcdef0n;
  source.segments.ds.limit = 0x12345678;
  source.segments.ds.conforming = true;
  source.segments.ds.available = true;
  const expected = structuredClone(source);
  const captured = captureContext(source);
  assert.deepEqual(captured, expected);
  const json = JSON.parse(
    JSON.stringify(source, (_, v: unknown) => (typeof v === 'bigint' ? `0x${v.toString(16)}` : v)),
  ) as ContextInfo;
  assert.deepEqual(contextFromJson(json), expected);
  source.gdtr.base = 0n;
  source.ldtr.attributes = 0;
  source.segments.ss.selector = 0;
  assert.deepEqual(captured, expected);
});

test('full snapshot capture reads every new getter once before publishing owned values', () => {
  const source = longSnapshot(0x1234n, 0x5678n);
  const expected = structuredClone(source);
  const reads = new Map<string, number>();
  function watch(value: Record<string, unknown>, path = 'context'): void {
    for (const key of Object.keys(value)) {
      const member = value[key];
      const label = `${path}.${key}`;
      if (member !== null && typeof member === 'object')
        watch(member as Record<string, unknown>, label);
      reads.set(label, 0);
      Object.defineProperty(value, key, {
        get() {
          reads.set(label, reads.get(label)! + 1);
          return member;
        },
        enumerable: true,
      });
    }
  }
  watch(source as unknown as Record<string, unknown>);
  assert.deepEqual(captureContext(source), expected);
  for (const [name, count] of reads) assert.equal(count, 1, name);
});

test('partial and mixed snapshots never fall back to legacy defaults', () => {
  for (const key of ['cpl', 'gdtr', 'idtr', 'ldtr'] as const) {
    const partial = { ...input(), [key]: undefined };
    assert.throws(() => captureContext(partial as ExecutionContext), TypeError);
    const full = longSnapshot();
    Reflect.deleteProperty(full, key);
    assert.throws(() => captureContext(full), TypeError);
  }
  for (const key of [
    'selector',
    'dpl',
    'present',
    'conforming',
    'accessed',
    'long',
    'granularity',
    'available',
  ]) {
    const partial = input();
    if (partial.mode === 'long64') assert.fail();
    Reflect.set(partial.segments.ds, key, undefined);
    assert.throws(() => captureContext(partial), TypeError);
  }
  for (const key of ['fsBase', 'gsBase']) {
    const full = longSnapshot();
    Reflect.set(full, key, undefined);
    assert.throws(() => captureContext(full), TypeError);
  }
});

test('full snapshot integer widths and legacy versus IA-32e base domains are checked', () => {
  for (const [object, key, values] of [
    ['root', 'limit', [-1, 0x10000, 1.5, NaN]],
    ['segment', 'selector', [-1, 0x10000]],
    ['segment', 'dpl', [-1, 4]],
    ['ldt', 'attributes', [-1, 0x1000]],
    ['ldt', 'limit', [-1, 0x100000000]],
  ] as const) {
    for (const value of values) {
      const full = longSnapshot();
      Reflect.set(
        object === 'root' ? full.gdtr : object === 'segment' ? full.segments.ds : full.ldtr,
        key,
        value,
      );
      assert.throws(() => captureContext(full), TypeError);
    }
  }
  for (const key of ['gdtr', 'idtr', 'ldtr'] as const) {
    const full = protectedSnapshot();
    full[key].base = 0x100000000n;
    assert.throws(() => captureContext(full), TypeError);
    full.mode = 'compatibility';
    assert.equal(captureContext(full)[key].base, 0x100000000n);
  }
});

test('context capture rejects malformed fields and exact address domains', () => {
  for (const value of [null, undefined, {}, { mode: '32' }, { mode: 'long64', fsBase: 0n }])
    assert.throws(() => captureContext(value as ExecutionContext), TypeError);
  for (const base of [-1n, 1n << 64n, 0x800000000000n, 0xffff7fffffffffffn])
    assert.throws(() => captureContext({ mode: 'long64', fsBase: base, gsBase: 0n }), TypeError);
  for (const base of [-1n, 1n << 32n]) {
    const value = input();
    if (value.mode === 'long64') assert.fail();
    value.segments.ds.base = base;
    assert.throws(() => captureContext(value), TypeError);
  }
  for (const key of ['default32', 'usable', 'type', 'limit'] as const) {
    const value = input();
    if (value.mode === 'long64') assert.fail();
    Object.defineProperty(value.segments.ds, key, { value: key === 'type' ? 'memory' : NaN });
    assert.throws(() => captureContext(value), TypeError);
  }
});

test('physical full context owns retained transitional CS wide roots and unusable SS without relaxing old inputs', () => {
  const source = protectedSnapshot();
  source.segments.cs.type = 'read-write';
  source.segments.cs.base = 0xffff0000n;
  source.segments.cs.default32 = false;
  source.segments.ss.usable = false;
  source.segments.ss.selector = 0;
  source.segments.fs.base = 0xffffffffffffffffn;
  source.gdtr.base = 0x100000000n;
  source.tr.base = 0xffffffffffffffffn;
  assert.throws(() => captureContext(source), TypeError);
  assert.deepEqual(captureContext(source, true), source);
  const json = JSON.parse(
    JSON.stringify(source, (_, value: unknown) =>
      typeof value === 'bigint' ? `0x${value.toString(16)}` : value,
    ),
  ) as ContextInfo;
  assert.deepEqual(contextFromJson(json, true), source);
  const user = structuredClone(source);
  user.cpl = 3;
  assert.throws(() => captureContext(user, true), TypeError);
});
