import assert from 'node:assert/strict';
import test from 'node:test';
import { Cpu } from './cpu.js';

const limits = {
  maxInstructions: 32,
  maxSourceBytes: 256,
  maxArtifactBytes: 65536,
  maxCachedArtifacts: 8,
  maxCachedBytes: 1048576,
  maxTranslationsPerRun: 8,
};

test('CPU construction cannot bypass the factory lifecycle owner', () => {
  assert.throws(() => Reflect.construct(Cpu, [null, limits, 0]), /factory|createCpu/);
});
