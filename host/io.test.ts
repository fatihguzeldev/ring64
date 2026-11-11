import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureIo, IoBridge, type IoProvider } from './io.js';

test('I/O captures option and methods once and keeps their receiver across replacement', () => {
  let options = 0,
    reads = 0,
    writes = 0;
  const receiver = {
    value: 17,
    get read() {
      reads++;
      return function (this: { value: number }) {
        return this.value;
      };
    },
    get write() {
      writes++;
      return function (this: { value: number }, _p: number, _w: number, value: number) {
        this.value = value;
      };
    },
  };
  const binding = captureIo({
    get io() {
      options++;
      return receiver;
    },
  });
  assert.deepEqual([options, reads, writes], [1, 1, 1]);
  Object.defineProperty(receiver, 'read', { value: () => 99 });
  const bridge = new IoBridge(binding);
  bridge.effectActive = () => 1;
  bridge.executing = true;
  assert.equal(bridge.imports.read(7, 8), 17);
  bridge.imports.write(7, 16, 0xabcd);
  assert.equal(receiver.value, 0xabcd);
  assert.deepEqual([options, reads, writes], [1, 1, 1]);
  bridge.release();
  assert.throws(() => bridge.imports.read(7, 8), /outside/);
});

test('I/O rejects malformed providers and primitive results without inspecting thenables', () => {
  assert.equal(captureIo({}), undefined);
  for (const io of [undefined, null, [], 4, () => 1, {}, { read() {} }])
    assert.throws(() => captureIo({ io: io as unknown as IoProvider }), TypeError);
  let thenGets = 0;
  const object = {
    get then() {
      thenGets++;
      throw new Error('must never inspect then');
    },
  };
  for (const value of [undefined, -1, 1.5, NaN, Infinity, 256, object, Promise.resolve(1)]) {
    const bridge = new IoBridge(captureIo({ io: { read: () => value as number, write() {} } }));
    bridge.effectActive = () => 1;
    bridge.executing = true;
    assert.throws(() => bridge.imports.read(0, 8), TypeError);
  }
  assert.equal(thenGets, 0);
});

test('I/O validates before i32 coercion, normalizes unsigned output and requires undefined writes', () => {
  const outputs: number[] = [];
  const bridge = new IoBridge(
    captureIo({
      io: {
        read: () => 0x89abcdef,
        write(_p, _w, v) {
          outputs.push(v);
        },
      },
    }),
  );
  bridge.effectActive = () => 1;
  bridge.executing = true;
  assert.equal(bridge.imports.read(0xffff, 32), 2309737967);
  bridge.imports.write(3, 32, -1985229329);
  bridge.imports.write(3, 16, -1985229329);
  assert.deepEqual(outputs, [0x89abcdef, 0xcdef]);
  const invalid = new IoBridge(
    captureIo({ io: { read: () => 1, write: () => Promise.resolve() } }),
  );
  invalid.executing = true;
  invalid.effectActive = () => 1;
  assert.throws(() => invalid.imports.write(0, 8, 1), TypeError);
});

test('I/O execution and reached-effect guards reject early imports without calling providers', () => {
  let calls = 0;
  const bridge = new IoBridge(
    captureIo({
      io: {
        read() {
          calls++;
          return 1;
        },
        write() {
          calls++;
        },
      },
    }),
  );
  assert.throws(() => bridge.imports.read(0, 8), /outside/);
  bridge.executing = true;
  assert.throws(() => bridge.imports.read(0, 8), /outside/);
  bridge.effectActive = () => 0;
  assert.throws(() => bridge.imports.write(0, 8, 1), /outside/);
  assert.equal(calls, 0);
});

test('I/O invokes the captured callable without reading its mutable call property', () => {
  let reads = 0,
    writes = 0,
    callGets = 0;
  function read() {
    reads++;
    return 17;
  }
  function write() {
    writes++;
  }
  for (const fn of [read, write])
    Object.defineProperty(fn, 'call', {
      get() {
        callGets++;
        throw new Error('uncaptured call property');
      },
    });
  const bridge = new IoBridge(captureIo({ io: { read, write } }));
  bridge.executing = true;
  bridge.effectActive = () => 1;
  assert.equal(bridge.imports.read(0, 8), 17);
  bridge.imports.write(0, 8, 1);
  assert.deepEqual([reads, writes, callGets], [1, 1, 0]);
});
