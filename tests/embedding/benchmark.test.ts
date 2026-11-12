import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('frozen benchmarks preserve saved source and refuse changed artifacts before publishing', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'ring64-benchmark-'));
  try {
    await mkdir(join(directory, 'build'));
    await mkdir(join(directory, 'scripts'));
    await Promise.all([
      cp(join(root, 'build/host'), join(directory, 'build/host'), { recursive: true }),
      cp(join(root, 'build/ring64.wasm'), join(directory, 'build/ring64.wasm')),
      cp(join(root, 'benchmarks'), join(directory, 'benchmarks'), { recursive: true }),
      cp(join(root, 'scripts/benchmark.mjs'), join(directory, 'scripts/benchmark.mjs')),
      symlink(
        join(root, 'node_modules'),
        join(directory, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir',
      ),
      writeFile(join(directory, 'package.json'), '{"type":"module"}\n'),
      writeFile(
        join(directory, 'paging-source.json'),
        JSON.stringify({
          source: { commit: 'saved-frozen-source', workingTree: [' M captured-source.rs'] },
        }),
      ),
    ]);
    const script = join(directory, 'scripts/benchmark.mjs');
    const output = join(directory, 'accepted.json');
    const args = [
      script,
      '--iterations',
      '3',
      '--samples',
      '1',
      '--workloads',
      'integer-qword-add',
      '--output',
    ];
    const accepted = spawnSync(process.execPath, [...args, output], { encoding: 'utf8' });
    assert.ifError(accepted.error);
    assert.equal(accepted.status, 0, accepted.stderr);
    const report = JSON.parse(await readFile(output, 'utf8')) as {
      sides: {
        commit: string;
        workingTree: { dirty: boolean; changes: string[] };
        coreSha256: string;
      }[];
      samples: { resources: { nativeEntries: number; compilations: number } }[];
    };
    assert.equal(report.sides[0]?.commit, 'saved-frozen-source');
    assert.deepEqual(report.sides[0]?.workingTree, {
      dirty: true,
      changes: [' M captured-source.rs'],
    });
    assert.equal(report.samples.length, 1);
    assert.equal(report.samples[0]?.resources.nativeEntries, 1);
    assert.equal(report.samples[0]?.resources.compilations, 1);

    const wasm = join(directory, 'build/ring64.wasm');
    const before = await readFile(wasm);
    const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    assert.equal(report.sides[0]?.coreSha256, hash(before));
    const hook = join(directory, 'mutate-after-compile.mjs');
    await writeFile(
      hook,
      `import { readFile, writeFile } from 'node:fs/promises';
const path = ${JSON.stringify(wasm)};
const bytes = await readFile(path);
const compile = WebAssembly.compile;
let changed = false;
WebAssembly.compile = async function(input, ...options) {
  const module = await Reflect.apply(compile, WebAssembly, [input, ...options]);
  if (!changed && Buffer.from(input).equals(bytes)) {
    changed = true;
    await writeFile(path, Buffer.concat([bytes, Buffer.from([0, 1, 0])]));
    console.error('artifact changed after native compilation');
  }
  return module;
};
`,
    );
    const rejectedOutput = join(directory, 'rejected.json');
    const rejected = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(hook).href, ...args, rejectedOutput],
      { encoding: 'utf8' },
    );
    assert.ifError(rejected.error);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /artifact changed after native compilation/);
    assert.match(rejected.stderr, /built artifacts changed during observation: current/);
    assert.notEqual(hash(await readFile(wasm)), hash(before));
    await assert.rejects(access(rejectedOutput), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
