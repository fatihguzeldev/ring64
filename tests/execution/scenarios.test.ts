import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenarios } from './scenarios.js';

test('common browser and Node scenarios execute real generated Wasm', async () => {
  const bytes = new Uint8Array(await readFile(new URL('../../build/ring64.wasm', import.meta.url)));
  const result = await runScenarios(bytes);
  assert.ok(result.passed.length > 0);
  assert.equal(new Set(result.passed).size, result.passed.length);
});
