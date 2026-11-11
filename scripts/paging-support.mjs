import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const baseline = '/tmp/ring64-paging-baseline-c1380a4';
export const encode = (value) =>
  JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? item.toString() : item), 2) + '\n';
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function manifest(path) {
  const core = await readFile(resolve(path, 'build/ring64.wasm'));
  const host = createHash('sha256');
  const productionHost = createHash('sha256');
  let hostBytes = 0;
  const hostFiles = [];
  for (const name of (await readdir(resolve(path, 'build/host')))
    .filter((name) => name.endsWith('.js'))
    .sort()) {
    const bytes = await readFile(resolve(path, 'build/host', name));
    host.update(name + '\0');
    host.update(bytes);
    if (!name.endsWith('.test.js')) {
      productionHost.update(name + '\0');
      productionHost.update(bytes);
    }
    hostBytes += bytes.length;
    hostFiles.push({ name, bytes: bytes.length, sha256: hash(bytes) });
  }
  const git = (args) =>
    execFileSync('git', ['-C', path, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  let source;
  try {
    source = JSON.parse(await readFile(resolve(path, 'paging-source.json'), 'utf8')).source;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const changes = git(['status', '--porcelain']);
    source = {
      commit: git(['rev-parse', 'HEAD']),
      workingTree: changes ? changes.split('\n') : [],
    };
  }
  return {
    path,
    source,
    coreSha256: hash(core),
    coreBytes: core.length,
    hostSha256: host.digest('hex'),
    productionHostSha256: productionHost.digest('hex'),
    hostBytes,
    productionHostBytes: hostFiles
      .filter((file) => !file.name.endsWith('.test.js'))
      .reduce((sum, file) => sum + file.bytes, 0),
    hostFiles,
  };
}

// Freeze artifacts, not a source build: no Cargo invocation or shared target directory.
export async function freeze(path, name) {
  const before = await manifest(path);
  const target = resolve(root, 'build/verification', name);
  await mkdir(resolve(target, 'build'), { recursive: true });
  await cp(resolve(path, 'build/host'), resolve(target, 'build/host'), { recursive: true });
  await cp(resolve(path, 'build/ring64.wasm'), resolve(target, 'build/ring64.wasm'));
  await cp(resolve(root, 'benchmarks'), resolve(target, 'benchmarks'), { recursive: true });
  await mkdir(resolve(target, 'scripts'), { recursive: true });
  await cp(resolve(root, 'scripts/benchmark.mjs'), resolve(target, 'scripts/benchmark.mjs'));
  await writeFile(resolve(target, 'package.json'), '{"type":"module"}\n');
  try {
    await symlink(resolve(root, 'node_modules'), resolve(target, 'node_modules'), 'dir');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  await writeFile(
    resolve(target, 'paging-source.json'),
    encode({ capturedAt: new Date().toISOString(), ...before }),
  );
  const after = await manifest(path),
    copy = await manifest(target);
  if (
    before.coreSha256 !== after.coreSha256 ||
    before.hostSha256 !== after.hostSha256 ||
    before.coreSha256 !== copy.coreSha256 ||
    before.hostSha256 !== copy.hostSha256
  )
    throw Error('build changed while freezing; discard snapshot and retry after build completes');
  return { ...copy, originalPath: path, source: before.source };
}
