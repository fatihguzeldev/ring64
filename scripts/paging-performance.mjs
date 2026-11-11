import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { baseline, encode, freeze, manifest, root } from './paging-support.mjs';

const args = process.argv.slice(2);
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const tag = value('--tag', new Date().toISOString().replaceAll(/[:.]/g, '-'));
const current = args.includes('--snapshot')
  ? await manifest(resolve(value('--snapshot')))
  : await freeze(value('--current', root), `paging-performance-build-${tag}`);
const old = args.includes('--aa')
  ? current
  : await manifest(resolve(value('--baseline', baseline)));
const destination = resolve(root, 'build/verification');
await mkdir(destination, { recursive: true });
const window = { started: new Date().toISOString(), current, baseline: old, runs: [] };
const windowFile = resolve(destination, `paging-performance-${tag}-window.json`);
await writeFile(windowFile, encode(window));
if (args.includes('--freeze-only')) {
  console.log(encode(current));
  process.exit(0);
}
const jobs = [];
for (const matchedDelivery of [false, true])
  for (const browser of [false, true]) {
    if (args.includes('--node-only') && browser) continue;
    if (args.includes('--chrome-only') && !browser) continue;
    if (args.includes('--report-only') && matchedDelivery) continue;
    const name = `paging-performance-${tag}-${matchedDelivery ? 'matched' : 'report'}-${browser ? 'chrome' : 'node'}`;
    const output = resolve(destination, name + '.json');
    const command = [
      resolve(current.path, 'scripts/benchmark.mjs'),
      '--baseline',
      old.path,
      '--iterations',
      value('--iterations', '100001'),
      '--samples',
      value('--samples', '7'),
      '--output',
      output,
    ];
    if (matchedDelivery) command.push('--matched-delivery');
    if (browser) command.push('--browser');
    if (args.includes('--reverse')) command.push('--reverse');
    if (args.includes('--workloads')) command.push('--workloads', value('--workloads'));
    jobs.push({ name, output, command });
  }
for (const job of jobs) {
  console.log('START', job.name);
  const began = performance.now(),
    log = createWriteStream(resolve(destination, job.name + '.log'));
  const status = await new Promise((done, reject) => {
    const child = spawn(process.execPath, job.command, {
      cwd: current.path,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.once('error', reject);
    child.once('exit', done);
  });
  log.end();
  if (status !== 0) throw Error(`${job.name} failed (${status}); inspect its log`);
  const result = JSON.parse(await readFile(job.output, 'utf8'));
  result.sides = result.sides.map((side) => ({
    ...side,
    commit: (side.label === 'baseline' ? old : current).source.commit,
    workingTree: {
      dirty: (side.label === 'baseline' ? old : current).source.workingTree.length !== 0,
      changes: (side.label === 'baseline' ? old : current).source.workingTree,
    },
    source: side.label === 'baseline' ? old.source : current.source,
    frozenBuild: true,
  }));
  await writeFile(job.output, encode(result));
  const seconds = (performance.now() - began) / 1000;
  window.runs.push({
    ...job,
    seconds,
    status,
    definitions: result.definitions.length,
    samples: result.samples.length,
    unavailable: result.unavailable,
  });
  await writeFile(windowFile, encode(window));
  console.log(
    'DONE',
    job.name,
    seconds.toFixed(2),
    'seconds',
    result.definitions.length,
    'definitions',
  );
}
window.finished = new Date().toISOString();
await writeFile(windowFile, encode(window));
console.log('COMPLETE', windowFile);
