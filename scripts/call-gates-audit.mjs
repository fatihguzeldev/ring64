import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { chromium } from 'playwright';
import { encode, freeze, hash, manifest, root } from './paging-support.mjs';
import { callGateNames, checkCallGates, measureCallGates } from './call-gate-kernels.mjs';

// This driver freezes existing artifacts. Build and CPU scheduling belong to the caller.
const args = process.argv.slice(2);
const options = new Set([
  '--current',
  '--snapshot',
  '--output',
  '--iterations',
  '--samples',
  '--workloads',
]);
const flags = new Set(['--browser', '--characterize', '--no-matrix']);
const values = {};
for (let i = 0; i < args.length; i++) {
  if (options.has(args[i])) {
    if (args[i + 1] === undefined || args[i + 1].startsWith('--'))
      throw Error(`missing ${args[i]} value`);
    values[args[i].slice(2)] = args[++i];
  } else if (!flags.has(args[i])) throw Error(`unknown argument ${args[i]}`);
}
if (!!values.current === !!values.snapshot)
  throw Error('require exactly one of --current BUILT_REPO or --snapshot FROZEN_BUILD');
const browserMode = args.includes('--browser');
const characterization = args.includes('--characterize');
const tag = `${Date.now()}-${process.pid}`;
const current = values.snapshot
  ? await manifest(resolve(values.snapshot))
  : await freeze(resolve(values.current), `call-gates-build-${tag}`);
const knobs = {
  matrix: !args.includes('--no-matrix'),
  iterations: Number(values.iterations ?? 16384),
  samples: Number(values.samples ?? 5),
  workloads: (values.workloads ?? callGateNames.join(',')).split(','),
};
for (const [name, max] of [
  ['iterations', 1000001],
  ['samples', 101],
])
  if (!Number.isSafeInteger(knobs[name]) || knobs[name] < 1 || knobs[name] > max)
    throw Error(`${name} outside allowed integer range`);
if (knobs.workloads.some((name) => !callGateNames.includes(name)))
  throw Error('unknown call-gate workload');
const sourcePaths = [
  'scripts/call-gates-audit.mjs',
  'scripts/call-gate-kernels.mjs',
  'scripts/paging-support.mjs',
];
const sourceHashes = async () =>
  Object.fromEntries(
    await Promise.all(
      sourcePaths.map(async (name) => [name, hash(await readFile(resolve(root, name)))]),
    ),
  );
const beforeSources = await sourceHashes();
const kernelBytes = await readFile(resolve(root, 'scripts/call-gate-kernels.mjs'));
let result;
if (!browserMode) {
  const { createCpu } = await import(pathToFileURL(resolve(current.path, 'build/host/index.js')));
  const compiler = await WebAssembly.compile(
    await readFile(resolve(current.path, 'build/ring64.wasm')),
  );
  const side = { label: 'current', createCpu, compiler };
  result = characterization
    ? await measureCallGates(side, knobs)
    : await checkCallGates(side, knobs);
} else {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (pathname === '/') {
        response.end('<!doctype html><title>Call-gate audit</title>');
        return;
      }
      let bytes;
      if (pathname === '/scripts/call-gate-kernels.mjs') bytes = kernelBytes;
      else {
        const file = resolve(current.path, '.' + pathname);
        if (!(
          file.startsWith(resolve(current.path, 'build/host') + '/') ||
          file === resolve(current.path, 'build/ring64.wasm')
        ))
          throw Error('outside allowed route');
        bytes = await readFile(file);
      }
      response.writeHead(200, {
        'content-type': pathname.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
        'cache-control': 'no-store',
      });
      response.end(bytes);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  let browser;
  try {
    let executablePath = process.env.RING64_BROWSER;
    if (!executablePath)
      try {
        await access('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
        executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      } catch {
        /* Playwright default */
      }
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    result = await page.evaluate(
      async ({ characterization, knobs }) => {
        const { checkCallGates, measureCallGates } = await import('/scripts/call-gate-kernels.mjs');
        const { createCpu } = await import('/build/host/index.js');
        const compiler = await WebAssembly.compile(
          await (await fetch('/build/ring64.wasm')).arrayBuffer(),
        );
        const side = { label: 'current', createCpu, compiler };
        return {
          ...(characterization
            ? await measureCallGates(side, knobs)
            : await checkCallGates(side, knobs)),
          browserUserAgent: navigator.userAgent,
        };
      },
      { characterization, knobs },
    );
    result.browserVersion = browser.version();
  } finally {
    await browser?.close();
    await new Promise((done) => server.close(done));
  }
}
const after = await manifest(current.path);
if (after.coreSha256 !== current.coreSha256 || after.hostSha256 !== current.hostSha256)
  throw Error('frozen Core/host changed during audit; discard run');
if (JSON.stringify(beforeSources) !== JSON.stringify(await sourceHashes()))
  throw Error('audit source changed during run; discard run');
const output = resolve(
  values.output ??
    `build/verification/call-gates-${characterization ? 'characterization' : 'oracle'}-${browserMode ? 'chrome' : 'node'}-${tag}.json`,
);
await mkdir(dirname(output), { recursive: true });
await writeFile(
  output,
  encode({
    at: new Date().toISOString(),
    runtime: browserMode ? 'chrome' : 'node',
    mode: characterization ? 'new-behavior-characterization' : 'independent-finite-oracle',
    environment: {
      node: process.version,
      cpu: os.cpus()[0]?.model,
      platform: os.platform(),
      arch: os.arch(),
    },
    manifest: current,
    sourceSha256: beforeSources,
    knobs,
    postRunIntegrity: { core: true, host: true, sources: true },
    ...result,
  }),
);
console.log({
  output,
  cases: result.cases?.length,
  definitions: result.definitions?.length,
  samples: result.samples?.length,
});
