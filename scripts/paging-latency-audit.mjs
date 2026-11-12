import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import { freeze, manifest, hash, encode } from './paging-support.mjs';
import { measurePaging, pagingWorkloads } from './paging-latency-kernels.mjs';
import { measureReusePair, reuseNames, populationNames } from './context-reuse-kernels.mjs';
const scriptRoot = dirname(fileURLToPath(import.meta.url));
const options = {
  iterations: 100001,
  samples: 12,
  reverse: false,
  aa: false,
  browser: false,
  smoke: false,
  contextReuse: false,
  population: false,
};
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'node scripts/paging-latency-audit.mjs --baseline BUILT_REPO --current BUILT_REPO [--context-reuse | --population] [--browser] [--reverse] [--aa] [--smoke] [--iterations N] [--samples N] [--workloads NAME,NAME] [--output FILE]',
  );
  process.exit(0);
}
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (
    ['--reverse', '--aa', '--browser', '--smoke', '--context-reuse', '--population'].includes(key)
  ) {
    options[key === '--context-reuse' ? 'contextReuse' : key.slice(2)] = true;
    continue;
  }
  if (
    !['--baseline', '--current', '--iterations', '--samples', '--workloads', '--output'].includes(
      key,
    ) ||
    args[i + 1] === undefined
  )
    throw Error('unknown/incomplete option: ' + key);
  const value = args[++i];
  options[key.slice(2)] =
    key === '--iterations' || key === '--samples'
      ? Number(value)
      : key === '--workloads'
        ? value.split(',')
        : resolve(value);
}
if (!options.baseline || !options.current)
  throw Error('require --baseline BUILT_REPO --current BUILT_REPO');
if (options.contextReuse && options.population) throw Error('select one context cohort');
const contextMode = options.contextReuse || options.population;
const names = options.population
  ? populationNames
  : options.contextReuse
    ? reuseNames
    : pagingWorkloads;
options.workloads ??= names;
for (const [key, min, max] of [
  ['iterations', 1, 10000000],
  ['samples', 2, 100],
])
  if (!Number.isSafeInteger(options[key]) || options[key] < min || options[key] > max)
    throw Error(key + ' outside bounded integer range');
if (
  options.workloads.some((name) => !names.includes(name)) ||
  new Set(options.workloads).size !== options.workloads.length ||
  !options.workloads.length
)
  throw Error('invalid/duplicate workloads');
if (options.smoke) {
  options.iterations = Math.min(options.iterations, 31);
  options.samples = 2;
}
const definitions = options.aa
  ? [
      ['A', options.current],
      ['B', options.current],
    ]
  : [
      ['baseline', options.baseline],
      ['current', options.current],
    ];
const tag = `${Date.now()}-${process.pid}`;
const manifests = await Promise.all(
  definitions.map(async ([label, path]) => ({
    label,
    ...(await freeze(path, `paging-latency-${tag}-${label}`)),
  })),
);
async function nodeRun() {
  const sides = [];
  for (const side of manifests) {
    const { createCpu } = await import(pathToFileURL(resolve(side.path, 'build/host/index.js')));
    sides.push({
      ...side,
      createCpu,
      compiler: await WebAssembly.compile(await readFile(resolve(side.path, 'build/ring64.wasm'))),
    });
  }
  return {
    engine: process.version,
    ...(await (contextMode ? measureReusePair(sides, options) : measurePaging(sides, options))),
  };
}
async function browserRun() {
  const { chromium } = await import('playwright');
  let browser;
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><meta charset="utf-8"><title>paging latency audit</title>');
        return;
      }
      let file;
      if (pathname === '/driver.mjs' && !contextMode)
        file = resolve(scriptRoot, 'paging-latency-kernels.mjs');
      else if (
        contextMode &&
        ['/scripts/context-reuse-kernels.mjs', '/scripts/fast-system-kernels.mjs'].includes(
          pathname,
        )
      )
        file = resolve(scriptRoot, pathname.slice('/scripts/'.length));
      else {
        const side = manifests.find((x) => pathname.startsWith('/' + x.label + '/'));
        if (!side) throw Error('unknown side');
        const base = resolve(side.path, 'build');
        file = resolve(base, pathname.slice(side.label.length + 2));
        if (!file.startsWith(base + sep)) throw Error('invalid path');
      }
      res.writeHead(200, {
        'content-type': file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
        'cache-control': 'no-store',
      });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  try {
    let executablePath;
    if (process.platform === 'darwin') {
      const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      try {
        await access(chrome);
        executablePath = chrome;
      } catch {
        /* bundled Chromium */
      }
    }
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:' + server.address().port);
    const result = await page.evaluate(
      async ({ manifests, options }) => {
        const contextMode = options.contextReuse || options.population;
        const driver = await import(
          contextMode ? '/scripts/context-reuse-kernels.mjs' : '/driver.mjs'
        );
        const sides = [];
        for (const side of manifests) {
          const prefix = '/' + side.label;
          const { createCpu } = await import(prefix + '/host/index.js');
          sides.push({
            label: side.label,
            createCpu,
            compiler: await WebAssembly.compile(
              await (await fetch(prefix + '/ring64.wasm')).arrayBuffer(),
            ),
          });
        }
        return contextMode
          ? driver.measureReusePair(sides, options)
          : driver.measurePaging(sides, options);
      },
      { manifests, options },
    );
    return { engine: browser.version(), ...result };
  } finally {
    await browser?.close();
    await new Promise((done) => server.close(done));
  }
}
const result = await (options.browser ? browserRun() : nodeRun());
if (contextMode && options.smoke)
  for (const row of result.samples) {
    delete row.elapsedMs;
    delete row.batchWallMs;
    delete row.timings;
  }
for (const side of manifests) {
  const after = await manifest(side.path);
  if (after.coreSha256 !== side.coreSha256 || after.hostSha256 !== side.hostSha256)
    throw Error('built artifacts changed during observation: ' + side.label);
}
const report = {
  kind: options.population
    ? 'matched-existing-context-population'
    : options.contextReuse
      ? 'matched-existing-context-reuse'
      : 'matched-existing-IA32e-paging',
  control: options.aa ? 'current/current' : 'baseline/current',
  manifests,
  environment: { platform: process.platform, arch: process.arch, cpus: os.cpus()[0]?.model },
  options,
  kernelSha256: hash(
    await readFile(
      resolve(scriptRoot, contextMode ? 'context-reuse-kernels.mjs' : 'paging-latency-kernels.mjs'),
    ),
  ),
  ...(contextMode
    ? { fixtureSha256: hash(await readFile(resolve(scriptRoot, 'fast-system-kernels.mjs'))) }
    : {}),
  ...result,
};
const output =
  options.output ??
  resolve(
    'build/verification/' +
      (options.population
        ? 'context-population'
        : options.contextReuse
          ? 'context-reuse'
          : 'paging') +
      '-latency-' +
      (options.browser ? 'chrome' : 'node') +
      (options.smoke ? '-smoke' : '') +
      '.json',
  );
await mkdir(dirname(output), { recursive: true });
await writeFile(output, encode(report));
console.log(
  `${options.smoke ? 'correctness smoke (timing discarded)' : 'paired observation'}: ${(result.results ?? result.samples).length} checked samples; ${result.engine}; ${output}`,
);
