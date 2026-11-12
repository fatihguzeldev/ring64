import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { chromium } from 'playwright';
import { encode, freeze, hash, manifest, root } from './paging-support.mjs';
import { callGateNames } from './call-gate-kernels.mjs';

const args = process.argv.slice(2),
  values = {};
const flags = new Set(['--browser', '--aa', '--reverse', '--plan']);
for (let i = 0; i < args.length; i++) {
  if (flags.has(args[i])) continue;
  if (
    !['--baseline', '--current', '--output', '--iterations', '--samples', '--workloads'].includes(
      args[i],
    ) ||
    args[i + 1] === undefined ||
    args[i + 1].startsWith('--')
  )
    throw Error(`unknown or incomplete argument ${args[i]}`);
  values[args[i].slice(2)] = args[++i];
}
const knobs = {
  iterations: Number(values.iterations ?? 4096),
  samples: Number(values.samples ?? 5),
  workloads: (values.workloads ?? callGateNames.join(',')).split(','),
  aa: args.includes('--aa'),
  reverse: args.includes('--reverse'),
};
for (const [key, max] of [
  ['iterations', 1000001],
  ['samples', 101],
])
  if (!Number.isSafeInteger(knobs[key]) || knobs[key] < 1 || knobs[key] > max)
    throw Error(`${key} outside allowed integer range`);
if (
  !knobs.workloads.length ||
  new Set(knobs.workloads).size !== knobs.workloads.length ||
  knobs.workloads.some((name) => !callGateNames.includes(name))
)
  throw Error('unknown/duplicate workload');
if (args.includes('--plan')) {
  console.log(
    encode({
      mode: 'static-plan-only',
      knobs,
      samplesPerSideAndLeaf: knobs.samples + 1,
      schedule: 'First sample-1 A/B, warm0 B/A, then alternating; reverse flips initial order.',
      caps: 'Unchanged literal kernel caps: hit/alias/repair/short-resume257; other rows1000001.',
    }),
  );
  process.exit(0);
}
if (!values.current || (!knobs.aa && !values.baseline))
  throw Error('require --current BUILT_REPO and --baseline BUILT_REPO (or --aa)');
const tag = `${Date.now()}-${process.pid}`,
  browserMode = args.includes('--browser');
const selected = knobs.aa
  ? [
      ['A', values.current],
      ['B', values.current],
    ]
  : [
      ['baseline', values.baseline],
      ['current', values.current],
    ];
const inputs = [],
  sides = [];
for (const [label, path] of selected) {
  const input = { label, ...(await manifest(resolve(path))) },
    frozen = { label, ...(await freeze(resolve(path), `call-gates-pair-${tag}-${label}`)) };
  if (input.coreSha256 !== frozen.coreSha256 || input.hostSha256 !== frozen.hostSha256)
    throw Error(`captured input differs from frozen Core/host: ${label}`);
  inputs.push(input);
  sides.push(frozen);
}
const sourcePaths = [
  'scripts/call-gates-pair.mjs',
  'scripts/call-gates-pair-kernels.mjs',
  'scripts/call-gate-kernels.mjs',
  'scripts/paging-support.mjs',
];
const sourceHashes = async () =>
  Object.fromEntries(
    await Promise.all(
      sourcePaths.map(async (name) => [name, hash(await readFile(resolve(root, name)))]),
    ),
  );
const sources = await sourceHashes(),
  driverRoot = resolve(root, 'build/verification', `call-gates-pair-driver-${tag}`);
await mkdir(driverRoot, { recursive: true });
const kernelFiles = {};
for (const name of ['call-gates-pair-kernels.mjs', 'call-gate-kernels.mjs']) {
  kernelFiles[name] = await readFile(resolve(root, 'scripts', name));
  if (hash(kernelFiles[name]) !== sources[`scripts/${name}`])
    throw Error(`kernel differs from captured source: ${name}`);
  await writeFile(resolve(driverRoot, name), kernelFiles[name]);
}
let result;
if (!browserMode) {
  const factories = [];
  for (const side of sides) {
    const { createCpu } = await import(pathToFileURL(resolve(side.path, 'build/host/index.js')));
    const compiler = await WebAssembly.compile(
      await readFile(resolve(side.path, 'build/ring64.wasm')),
    );
    factories.push({ label: side.label, createCpu, compiler });
  }
  const { measureCallGatesPair } = await import(
    pathToFileURL(resolve(driverRoot, 'call-gates-pair-kernels.mjs'))
  );
  result = await measureCallGatesPair(factories, knobs);
} else {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (pathname === '/') {
        response.end('<!doctype html><title>Paired inherited call gates</title>');
        return;
      }
      let file;
      const driverName = pathname.startsWith('/driver/') ? pathname.slice('/driver/'.length) : '';
      if (Object.hasOwn(kernelFiles, driverName)) file = resolve(driverRoot, driverName);
      else {
        const side = sides.find((item) => pathname.startsWith(`/${item.label}/`));
        if (!side) throw Error('unknown side');
        file = resolve(side.path, 'build', pathname.slice(side.label.length + 2));
        if (!(
          file.startsWith(resolve(side.path, 'build/host') + '/') ||
          file === resolve(side.path, 'build/ring64.wasm')
        ))
          throw Error('outside allowed route');
      }
      response.writeHead(200, {
        'content-type': file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
        'cache-control': 'no-store',
      });
      response.end(await readFile(file));
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  // An owned ephemeral listener has no shared expected port and is closed below.
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
    result = await page.evaluate(
      async ({ sides, knobs }) => {
        const factories = [];
        for (const side of sides) {
          const { createCpu } = await import(`/${side.label}/host/index.js`);
          const compiler = await WebAssembly.compile(
            await (await fetch(`/${side.label}/ring64.wasm`)).arrayBuffer(),
          );
          factories.push({ label: side.label, createCpu, compiler });
        }
        const { measureCallGatesPair } = await import('/driver/call-gates-pair-kernels.mjs');
        return {
          ...(await measureCallGatesPair(factories, knobs)),
          browserUserAgent: navigator.userAgent,
        };
      },
      { sides, knobs },
    );
    result.browserVersion = browser.version();
  } finally {
    await browser?.close();
    await new Promise((done) => server.close(done));
  }
}
for (const side of [...inputs, ...sides]) {
  const after = await manifest(side.path);
  if (after.coreSha256 !== side.coreSha256 || after.hostSha256 !== side.hostSha256)
    throw Error(`Core/host changed during paired measurement: ${side.label}`);
}
if (JSON.stringify(sources) !== JSON.stringify(await sourceHashes()))
  throw Error('paired measurement source changed');
for (const [name, bytes] of Object.entries(kernelFiles))
  if (hash(await readFile(resolve(driverRoot, name))) !== hash(bytes))
    throw Error('frozen kernel changed');
const output = resolve(
  values.output ??
    `build/verification/call-gates-pair-${browserMode ? 'chrome' : 'node'}-${tag}.json`,
);
await mkdir(dirname(output), { recursive: true });
await writeFile(
  output,
  encode({
    at: new Date().toISOString(),
    kind: 'matched-existing-call-gates',
    control: knobs.aa ? 'current/current (B/A)' : 'current/baseline',
    runtime: browserMode ? 'chrome' : 'node',
    environment: {
      node: process.version,
      cpu: os.cpus()[0]?.model,
      platform: os.platform(),
      arch: os.arch(),
    },
    inputs,
    manifests: sides,
    sourceSha256: sources,
    knobs,
    postRunIntegrity: { inputs: true, frozenCoreHost: true, sources: true, frozenKernels: true },
    ...result,
  }),
);
console.log({ output, definitions: result.definitions.length, samplePairs: result.pairs.length });
