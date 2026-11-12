import { createServer } from 'node:http';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { chromium } from 'playwright';
import { root, freeze, manifest, hash, encode } from './paging-support.mjs';

const args = process.argv.slice(2);
const values = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--browser') continue;
  if (
    !['--snapshot', '--current', '--output', '--groups'].includes(args[i]) ||
    args[i + 1] === undefined ||
    args[i + 1].startsWith('--')
  )
    throw Error(`unknown or incomplete argument ${args[i]}`);
  values[args[i].slice(2)] = args[++i];
}
if (values.current && values.snapshot) throw Error('choose --current or --snapshot');
const selected = values.groups?.split(',');
if (selected && (new Set(selected).size !== selected.length || selected.some((name) => !name)))
  throw Error('groups must be nonempty and unique');
const browserMode = args.includes('--browser');
const tag = `${Date.now()}-${process.pid}`;
const current = values.snapshot
  ? await manifest(resolve(values.snapshot))
  : await freeze(resolve(values.current ?? root), `identity-time-build-${tag}`);
const sources = [
  'scripts/identity-time-audit.mjs',
  'scripts/paging-support.mjs',
  'tests/execution/identity-time/oracle.ts',
  'build/tests/execution/identity-time/oracle.js',
];
const sourceHashes = async () =>
  Object.fromEntries(
    await Promise.all(
      sources.map(async (name) => [name, hash(await readFile(resolve(root, name)))]),
    ),
  );
const before = await sourceHashes();
const oracle = await readFile(resolve(root, 'build/tests/execution/identity-time/oracle.js'));
// This module contains only authored literals/BigInt steps; its production imports are type-only.
await writeFile(resolve(current.path, 'identity-oracle.js'), oracle);
let result;
if (!browserMode) {
  const { createCpu } = await import(pathToFileURL(resolve(current.path, 'build/host/index.js')));
  const { checkIdentityTime, groups } = await import(
    pathToFileURL(resolve(current.path, 'identity-oracle.js'))
  );
  if (selected?.some((name) => !groups.includes(name))) throw Error('unknown identity/time group');
  const compiler = await WebAssembly.compile(
    await readFile(resolve(current.path, 'build/ring64.wasm')),
  );
  result = await checkIdentityTime({ createCpu, compiler }, selected);
} else {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (pathname === '/') {
        response.end('<!doctype html><title>Identity and time audit</title>');
        return;
      }
      const file = resolve(current.path, '.' + pathname);
      if (!(
        file.startsWith(resolve(current.path, 'build/host') + '/') ||
        file === resolve(current.path, 'build/ring64.wasm') ||
        file === resolve(current.path, 'identity-oracle.js')
      ))
        throw Error('outside allowed route');
      const bytes = await readFile(file);
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
  // An ephemeral owned listener has no expected shared port and is always closed below.
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
    result = await page.evaluate(async (selected) => {
      const { createCpu } = await import('/build/host/index.js');
      const { checkIdentityTime, groups } = await import('/identity-oracle.js');
      if (selected?.some((name) => !groups.includes(name)))
        throw Error('unknown identity/time group');
      const compiler = await WebAssembly.compile(
        await (await fetch('/build/ring64.wasm')).arrayBuffer(),
      );
      return {
        ...(await checkIdentityTime({ createCpu, compiler }, selected)),
        browserUserAgent: navigator.userAgent,
      };
    }, selected);
    result.browserVersion = browser.version();
  } finally {
    await browser?.close();
    await new Promise((done) => server.close(done));
  }
}
const after = await manifest(current.path);
if (after.coreSha256 !== current.coreSha256 || after.hostSha256 !== current.hostSha256)
  throw Error('frozen Core/host changed during audit; discard run');
if (JSON.stringify(before) !== JSON.stringify(await sourceHashes()))
  throw Error('oracle source changed during audit; discard run');
if (hash(await readFile(resolve(current.path, 'identity-oracle.js'))) !== hash(oracle))
  throw Error('frozen oracle changed during audit; discard run');
const output = resolve(
  values.output ??
    `build/verification/identity-time-oracle-${browserMode ? 'chrome' : 'node'}-${tag}.json`,
);
await mkdir(dirname(output), { recursive: true });
await writeFile(
  output,
  encode({
    at: new Date().toISOString(),
    runtime: browserMode ? 'chrome' : 'node',
    mode: 'independent-finite-literal-and-BigInt-oracle',
    environment: {
      node: process.version,
      cpu: os.cpus()[0]?.model,
      platform: os.platform(),
      arch: os.arch(),
    },
    manifest: current,
    sourceSha256: before,
    selected,
    postRunIntegrity: { core: true, host: true, source: true, oracle: true },
    ...result,
  }),
);
console.log({ output, cases: result.cases, groups: result.groups });
