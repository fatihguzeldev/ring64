import { createServer } from 'node:http';
import { readFile, readdir, mkdir, writeFile, access } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { chromium } from 'playwright';
import { measure, workloadNames } from '../benchmarks/kernels.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function options(args) {
  const value = { browser: false, iterations: 1000001, samples: 11, workloads: workloadNames };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--browser') {
      value.browser = true;
      continue;
    }
    if (key === '--exception-idle' || key === '--matched-delivery' || key === '--reverse') {
      value[
        key === '--reverse'
          ? 'reverse'
          : key === '--matched-delivery'
            ? 'matchedDelivery'
            : 'exceptionIdle'
      ] = true;
      continue;
    }
    if (key === '--help') {
      value.help = true;
      continue;
    }
    if (
      !['--baseline', '--output', '--iterations', '--samples', '--workloads'].includes(key) ||
      args[i + 1] === undefined
    )
      throw Error(`unknown or incomplete option: ${key}`);
    const next = args[++i];
    if (key === '--baseline') value.baseline = resolve(next);
    else if (key === '--output') value.output = resolve(next);
    else if (key === '--workloads') value.workloads = next.split(',');
    else value[key.slice(2)] = Number(next);
  }
  for (const [key, max] of [
    ['iterations', 10000000],
    ['samples', 101],
  ])
    if (!Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > max)
      throw Error(`${key} must be an integer in 1..${max}`);
  for (const name of value.workloads)
    if (!workloadNames.includes(name)) throw Error(`unknown workload: ${name}`);
  if (value.exceptionIdle && value.matchedDelivery)
    throw Error('--exception-idle and --matched-delivery are mutually exclusive');
  return value;
}
const config = options(process.argv.slice(2));
if (config.help) {
  console.log(
    'node scripts/benchmark.mjs [--browser] [--baseline BUILT_REPO] [--exception-idle | --matched-delivery] [--reverse] [--iterations N] [--samples N] [--workloads NAME,NAME] [--output FILE]',
  );
  console.log(workloadNames.join('\n'));
  process.exit(0);
}
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const encode = (value) =>
  JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n';
async function manifest(path, label) {
  const core = await readFile(resolve(path, 'build/ring64.wasm'));
  const files = (await readdir(resolve(path, 'build/host')))
    .filter((name) => name.endsWith('.js'))
    .sort();
  const host = createHash('sha256');
  for (const name of files) {
    host.update(name + '\0');
    host.update(await readFile(resolve(path, 'build/host', name)));
  }
  let commit, workingTree;
  try {
    commit = execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const status = execFileSync('git', ['-C', path, 'status', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    workingTree = { dirty: status.length !== 0, changes: status ? status.split('\n') : [] };
  } catch {
    commit = 'unknown';
  }
  return {
    label,
    path,
    commit,
    workingTree,
    coreSha256: hash(core),
    coreBytes: core.length,
    hostSha256: host.digest('hex'),
  };
}
const definitions = [
  ...(config.baseline ? [['baseline', config.baseline]] : []),
  ['current', root],
];
const manifests = await Promise.all(definitions.map(([label, path]) => manifest(path, label)));
const knobs = {
  iterations: config.iterations,
  samples: config.samples,
  workloads: config.workloads,
  exceptionIdle: config.exceptionIdle ?? false,
  matchedDelivery: config.matchedDelivery ?? false,
  reverse: config.reverse ?? false,
};
async function nodeRun() {
  const sides = await Promise.all(
    manifests.map(async (side) => {
      const { createCpu } = await import(pathToFileURL(resolve(side.path, 'build/host/index.js')));
      return {
        ...side,
        createCpu,
        compiler: await WebAssembly.compile(
          await readFile(resolve(side.path, 'build/ring64.wasm')),
        ),
      };
    }),
  );
  return measure(sides, knobs);
}
async function browserRun() {
  const roots = new Map(manifests.map((side) => [side.label, side.path]));
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<!doctype html><title>ring64 benchmark</title>');
        return;
      }
      let file;
      if (
        pathname === '/kernels.mjs' ||
        pathname === '/x87.mjs' ||
        pathname === '/numeric-state.mjs' ||
        pathname === '/streaming.mjs' ||
        pathname === '/protection.mjs' ||
        pathname === '/far-control.mjs' ||
        pathname === '/system-flags.mjs' ||
        pathname === '/software-events.mjs' ||
        pathname === '/event-delivery.mjs' ||
        pathname === '/external-interrupts.mjs' ||
        pathname === '/access-faults.mjs'
      )
        file = resolve(root, 'benchmarks', pathname.slice(1));
      else {
        const [, label, ...parts] = pathname.split('/'),
          base = roots.get(label);
        if (!base) throw Error('unknown side');
        file = resolve(base, ...parts);
        if (!file.startsWith(resolve(base, 'build') + '/')) throw Error('outside build');
      }
      const bytes = await readFile(file);
      response.writeHead(200, {
        'content-type': file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
        'cache-control': 'no-store',
      });
      response.end(bytes);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  let browser;
  try {
    let executablePath = process.env.RING64_BROWSER;
    if (!executablePath && process.platform === 'darwin') {
      const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      try {
        await access(chrome);
        executablePath = chrome;
      } catch {
        /* use installed Playwright Chromium */
      }
    }
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const encoded = await page.evaluate(
      async ({ manifests, knobs }) => {
        const { measure } = await import('/kernels.mjs');
        const sides = await Promise.all(
          manifests.map(async (side) => {
            const { createCpu } = await import(`/${side.label}/build/host/index.js`);
            const bytes = new Uint8Array(
              await (await fetch(`/${side.label}/build/ring64.wasm`)).arrayBuffer(),
            );
            return { ...side, createCpu, compiler: await WebAssembly.compile(bytes) };
          }),
        );
        return JSON.stringify(
          { ...(await measure(sides, knobs)), browserUserAgent: navigator.userAgent },
          (_, v) => (typeof v === 'bigint' ? v.toString() : v),
        );
      },
      { manifests, knobs },
    );
    return { ...JSON.parse(encoded), browserVersion: browser.version() };
  } finally {
    try {
      await browser?.close();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
}
const environment = {
  runtime: config.browser ? 'browser' : 'node',
  node: process.version,
  cpu: os.cpus()[0]?.model,
  platform: os.platform(),
  arch: os.arch(),
};
const benchmarkFiles = [
  'kernels.mjs',
  'x87.mjs',
  'numeric-state.mjs',
  'streaming.mjs',
  'protection.mjs',
  'far-control.mjs',
  'system-flags.mjs',
  'software-events.mjs',
  'event-delivery.mjs',
  'external-interrupts.mjs',
  'access-faults.mjs',
];
const benchmarkHash = createHash('sha256');
for (const file of benchmarkFiles) {
  benchmarkHash.update(file + '\0');
  benchmarkHash.update(await readFile(resolve(root, 'benchmarks', file)));
}
const result = {
  time: new Date().toISOString(),
  environment,
  sides: manifests,
  benchmarkFiles,
  benchmarkSha256: benchmarkHash.digest('hex'),
  ...(await (config.browser ? browserRun() : nodeRun())),
};
const output =
  config.output ?? resolve(root, `build/verification/performance-${environment.runtime}.json`);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, encode(result));
const median = (values) => {
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
};
console.log('workload | side | window | median ms | M units/s | unit');
for (const definition of result.definitions)
  for (const side of manifests) {
    const all = result.samples.filter(
        (s) => s.workload === definition.name && s.side === side.label,
      ),
      later = all.filter((s) => s.window === 'later');
    if (!all.length) {
      console.log(`${definition.name} | ${side.label} | unavailable`);
      continue;
    }
    const elapsed = median((later.length ? later : all).map((s) => s.elapsedMs));
    const rate = elapsed > 0 ? (Number(definition.work) / elapsed / 1000).toFixed(2) : 'n/a';
    console.log(
      `${definition.name} | ${side.label} | ${later.length ? 'later' : 'all'} | ${elapsed.toFixed(3)} | ${rate} | ${definition.throughputUnit}`,
    );
  }
console.log(`evidence ${relative(root, output)}`);
