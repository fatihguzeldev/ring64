import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { chromium } from 'playwright';
import { encode, freeze, hash, manifest, root } from './paging-support.mjs';
import { identityTimeNames, identityTimePlan } from './identity-time-kernels.mjs';

// The caller owns the quiet measurement window; this driver never builds or starts other jobs.
const args = process.argv.slice(2),
  values = {};
const flags = new Set(['--browser', '--plan', '--validate-only']);
for (let i = 0; i < args.length; i++) {
  if (flags.has(args[i])) continue;
  if (
    !['--current', '--snapshot', '--output', '--iterations', '--samples', '--workloads'].includes(
      args[i],
    ) ||
    args[i + 1] === undefined ||
    args[i + 1].startsWith('--')
  )
    throw Error(`unknown or incomplete argument ${args[i]}`);
  values[args[i].slice(2)] = args[++i];
}
const browserMode = args.includes('--browser');
const knobs = {
  iterations: Number(values.iterations ?? 4096),
  samples: Number(values.samples ?? 5),
  workloads: (values.workloads ?? identityTimeNames.join(',')).split(','),
  validateOnly: args.includes('--validate-only'),
};
identityTimePlan(knobs);
if (knobs.validateOnly) {
  knobs.iterations = Math.min(knobs.iterations, 31);
  knobs.samples = 1;
}
const plan = identityTimePlan(knobs);
if (args.includes('--plan')) {
  console.log(
    encode({
      mode: 'static-plan-only-no-engine-or-clock-execution',
      knobs,
      phasesPerRow: knobs.samples + 1,
      rows: plan.map(({ code, ...row }) => ({ ...row, code: Array.from(code) })),
    }),
  );
  process.exit(0);
}
if (!!values.current === !!values.snapshot)
  throw Error('require exactly one of --current BUILT_REPO or --snapshot FROZEN_BUILD');
const tag = `${Date.now()}-${process.pid}`;
const current = values.snapshot
  ? await manifest(resolve(values.snapshot))
  : await freeze(resolve(values.current), `identity-time-performance-build-${tag}`);
const sourcePaths = [
  'scripts/identity-time-performance.mjs',
  'scripts/identity-time-kernels.mjs',
  'scripts/paging-support.mjs',
];
const sourceHashes = async () =>
  Object.fromEntries(
    await Promise.all(
      sourcePaths.map(async (name) => [name, hash(await readFile(resolve(root, name)))]),
    ),
  );
const sources = await sourceHashes(),
  kernelBytes = await readFile(resolve(root, 'scripts/identity-time-kernels.mjs'));
const frozenKernel = resolve(current.path, 'identity-time-performance-kernels.mjs');
await writeFile(frozenKernel, kernelBytes);
let result;
if (!browserMode) {
  const { createCpu } = await import(pathToFileURL(resolve(current.path, 'build/host/index.js')));
  const { measureIdentityTime } = await import(pathToFileURL(frozenKernel));
  const compiler = await WebAssembly.compile(
    await readFile(resolve(current.path, 'build/ring64.wasm')),
  );
  result = await measureIdentityTime({ createCpu, compiler }, knobs);
} else {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (pathname === '/') {
        response.end('<!doctype html><title>Identity/time characterization</title>');
        return;
      }
      const file = resolve(current.path, '.' + pathname);
      if (!(
        file.startsWith(resolve(current.path, 'build/host') + '/') ||
        file === resolve(current.path, 'build/ring64.wasm') ||
        file === frozenKernel
      ))
        throw Error('outside allowed route');
      response.writeHead(200, {
        'content-type': pathname.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
        'cache-control': 'no-store',
      });
      response.end(await readFile(file));
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  // Ephemeral owned listener: no shared expected port; close it even when validation fails.
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
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
    result = await page.evaluate(async (knobs) => {
      const { createCpu } = await import('/build/host/index.js');
      const { measureIdentityTime } = await import('/identity-time-performance-kernels.mjs');
      const compiler = await WebAssembly.compile(
        await (await fetch('/build/ring64.wasm')).arrayBuffer(),
      );
      return {
        ...(await measureIdentityTime({ createCpu, compiler }, knobs)),
        browserUserAgent: navigator.userAgent,
      };
    }, knobs);
    result.browserVersion = browser.version();
  } finally {
    await browser?.close();
    await new Promise((done) => server.close(done));
  }
}
const after = await manifest(current.path);
if (current.coreSha256 !== after.coreSha256 || current.hostSha256 !== after.hostSha256)
  throw Error('frozen Core/host changed during characterization; discard run');
if (JSON.stringify(sources) !== JSON.stringify(await sourceHashes()))
  throw Error('driver/kernel/support source changed during characterization; discard run');
if (hash(await readFile(frozenKernel)) !== hash(kernelBytes))
  throw Error('frozen kernel changed during characterization; discard run');
const output = resolve(
  values.output ??
    `build/verification/identity-time-${knobs.validateOnly ? 'validation' : 'characterization'}-${browserMode ? 'chrome' : 'node'}-${tag}.json`,
);
await mkdir(dirname(output), { recursive: true });
await writeFile(
  output,
  encode({
    at: new Date().toISOString(),
    mode: knobs.validateOnly
      ? 'new-behavior-validation-no-timing'
      : 'new-behavior-characterization',
    runtime: browserMode ? 'chrome' : 'node',
    baseline: null,
    environment: {
      node: process.version,
      cpu: os.cpus()[0]?.model,
      platform: os.platform(),
      arch: os.arch(),
    },
    manifest: current,
    sourceSha256: sources,
    knobs,
    postRunIntegrity: { core: true, host: true, measurementSources: true, frozenKernel: true },
    ...result,
  }),
);
console.log({ output, definitions: result.definitions.length, samples: result.samples.length });
