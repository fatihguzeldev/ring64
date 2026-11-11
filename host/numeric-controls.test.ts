import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captureNumericFault,
  writeNumericSource,
  readNumericSource,
  validateNumericSourceLayout,
  type NumericSourceLayout,
} from './numeric-controls.js';
import { captureEventState } from './events.js';

const controls = () => ({ mp: true, em: false, ts: true, osfxsr: true, osxmmexcpt: true });
const nm = () => ({ vector: 7, instructionPc: 0x1000n, family: 'x87', controls: controls() });
const numeric = () => ({
  vector: 6,
  instructionPc: 0x1000n,
  family: 'simd',
  controls: { ...controls(), ts: false, osxmmexcpt: false },
  phase: 'numeric',
  cause: 'osxmmexcpt',
  stage: 'pre-computation',
  raised: 4,
  unmasked: 4,
  mxcsrBefore: 0x1d80,
  mxcsrAfter: 0x1d84,
});
const layout: NumericSourceLayout = {
  offset: 728,
  bytes: 40,
  kind: 0,
  family: 4,
  controls: 8,
  stage: 12,
  raised: 16,
  before: 20,
  after: 24,
  reserved: 28,
  instructionPc: 32,
};

test('numeric sources capture primitive historical facts once and own detached boolean controls', () => {
  let reads = 0;
  const source = nm();
  Object.defineProperty(source.controls, 'ts', {
    get() {
      reads++;
      return true;
    },
  });
  const captured = captureNumericFault(source);
  assert.ok(captured.vector === 7);
  assert.equal(reads, 1);
  assert.deepEqual(captured, nm());
  source.controls.em = true;
  assert.equal(captured.controls.em, false);
  const event = captureEventState({
    kind: 'pending',
    exception: {
      instructionPc: 0x1000n,
      returnPc: 0x1000n,
      savedFlags: 0x10002n,
      vector: 7,
      deviceNotAvailable: captured,
    },
  });
  assert.equal(event.kind, 'pending');
  assert.deepEqual(
    captureEventState({
      kind: 'pending',
      exception: { instructionPc: 0x1000n, returnPc: 0x1000n, savedFlags: 0x10002n, vector: 7 },
    }).kind,
    'pending',
  );
});

test('numeric source validation rejects incoherent controls phases and status rather than reading live opcode or bank', () => {
  for (const source of [
    { ...nm(), vector: 6 },
    { ...nm(), family: 'wait', controls: { ...controls(), mp: false } },
    { ...nm(), controls: { ...controls(), ts: false } },
    { ...nm(), controls: { ...controls(), ts: 1 } },
    { ...nm(), phase: undefined },
    { ...nm(), instructionPc: 1 },
    { ...numeric(), raised: 0 },
    { ...numeric(), unmasked: 1 },
    { ...numeric(), mxcsrAfter: 0x1d80 },
    { ...numeric(), mxcsrBefore: 0x1f80 },
    { ...numeric(), controls: { ...controls(), ts: false } },
    { ...numeric(), family: 'mmx' },
    { ...numeric(), stage: 'other' },
    { ...numeric(), mxcsrAfter: 1 << 16 },
  ])
    assert.throws(() => captureNumericFault(source), TypeError);
  const source = captureNumericFault(nm());
  for (const extra of [
    { vector: 6, deviceNotAvailable: source },
    { vector: 7, deviceNotAvailable: source, errorCode: 0 },
    { vector: 7, deviceNotAvailable: source, numericControlFault: numeric() },
    { vector: 7, deviceNotAvailable: source, returnPc: 0x1001n },
  ])
    assert.throws(
      () =>
        captureEventState({
          kind: 'pending',
          exception: { instructionPc: 0x1000n, returnPc: 0x1000n, savedFlags: 0x10002n, ...extra },
        } as never),
      TypeError,
    );
});

test('numeric source tail roundtrips without shifting prior transport and rejects absent garbage', () => {
  validateNumericSourceLayout(layout, 768, 728);
  const bytes = new Uint8Array(768),
    view = new DataView(bytes.buffer);
  for (const source of [captureNumericFault(nm()), captureNumericFault(numeric()), undefined]) {
    writeNumericSource(new DataView(bytes.buffer, 728, 40), layout, source);
    assert.deepEqual(readNumericSource(view, layout), source);
    assert.ok(bytes.subarray(0, 728).every((b) => b === 0));
  }
  view.setUint32(732, 1, true);
  assert.throws(() => readNumericSource(view, layout));
  for (const changed of [{ offset: 727 }, { bytes: 32 }, { family: 0 }, { instructionPc: 39 }])
    assert.throws(() => validateNumericSourceLayout({ ...layout, ...changed }, 768, 728));
});

test('absent numeric sources reject every nonzero tail byte through relative views and field offsets', () => {
  for (const sourceLayout of [layout, { ...layout, kind: 4, family: 0 }]) {
    validateNumericSourceLayout(sourceLayout, 768, 728);
    const bytes = new Uint8Array(784),
      view = new DataView(bytes.buffer, 16, 768);
    assert.equal(readNumericSource(view, sourceLayout), undefined);
    for (let index = 0; index < sourceLayout.bytes; index++) {
      for (const value of [1, 0x80]) {
        view.setUint8(sourceLayout.offset + index, value);
        assert.throws(() => readNumericSource(view, sourceLayout), `nonzero byte${index}`);
        view.setUint8(sourceLayout.offset + index, 0);
      }
    }
    assert.equal(readNumericSource(view, sourceLayout), undefined);
  }
});
