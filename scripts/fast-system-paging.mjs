import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { chromium } from 'playwright';
import {
  assertFastCandidate,
  baseline,
  checkedBaseline,
  encode,
  freeze,
  hash,
  manifest,
  root,
} from './fast-system-support.mjs';
import { measurePaging, pagingNames } from './paging-kernels.mjs';
import { measurePagingPair } from './fast-system-paging-pair.mjs';
import { measureInheritedMsr, inheritedMsrNames } from './fast-system-kernels.mjs';

const args = process.argv.slice(2);
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const browserMode = args.includes('--browser');
const msrMode = args.includes('--msr-controls');
const names = msrMode ? inheritedMsrNames : pagingNames;
const tag = value('--tag', new Date().toISOString().replaceAll(/[:.]/g, '-'));
const reference = await checkedBaseline(value('--baseline', baseline));
const current = args.includes('--snapshot')
  ? await manifest(resolve(value('--snapshot')))
  : await freeze(value('--current', root), `fast-system-paging-build-${tag}`);
const old = args.includes('--aa') ? current : reference;
if (args.includes('--baseline-control')) {
  if (resolve(current.path) !== resolve(reference.path))
    throw Error('baseline control requires the exact same frozen8a build on both sides');
} else await assertFastCandidate(current.path);
const output = resolve(
  value(
    '--output',
    `build/verification/fast-system-paging-${browserMode ? 'chrome' : 'node'}-${tag}.json`,
  ),
);
const knobs = {
  iterations: Number(value('--iterations', 10001)),
  samples: Number(value('--samples', 7)),
  workloads: value('--workloads', names.join(',')).split(','),
  reverse: args.includes('--reverse'),
};
for (const [name, max] of [
  ['iterations', 1000001],
  ['samples', 101],
])
  if (!Number.isSafeInteger(knobs[name]) || knobs[name] < 1 || knobs[name] > max)
    throw Error(name + ' outside allowed integer range');
if (knobs.workloads.some((name) => !names.includes(name)))
  throw Error('unknown inherited workload');
const definitions = [
  ['baseline', old],
  ['current', current],
];
let result;
if (!browserMode) {
  const sides = await Promise.all(
    definitions.map(async ([label, side]) => {
      const { createCpu } = await import(pathToFileURL(resolve(side.path, 'build/host/index.js')));
      return {
        label,
        createCpu,
        compiler: await WebAssembly.compile(
          await readFile(resolve(side.path, 'build/ring64.wasm')),
        ),
      };
    }),
  );
  result = await measurePagingPair(
    sides,
    msrMode ? measureInheritedMsr : measurePaging,
    names,
    knobs,
  );
} else {
  const roots = new Map(definitions.map(([label, side]) => [label, side.path]));
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (pathname === '/') {
        response.end('<!doctype html><title>fast-system inherited paging</title>');
        return;
      }
      let file;
      if (
        [
          '/scripts/paging-kernels.mjs',
          '/scripts/fast-system-paging-pair.mjs',
          '/scripts/fast-system-kernels.mjs',
        ].includes(pathname)
      )
        file = resolve(root, '.' + pathname);
      else {
        const [, label, ...parts] = pathname.split('/'),
          base = roots.get(label);
        if (!base) throw Error('unknown side');
        file = resolve(base, ...parts);
        if (!file.startsWith(resolve(base, 'build') + '/')) throw Error('outside build');
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
      async ({ definitions, knobs, msrMode }) => {
        const { measurePaging, pagingNames } = await import('/scripts/paging-kernels.mjs');
        const { measurePagingPair } = await import('/scripts/fast-system-paging-pair.mjs');
        const { measureInheritedMsr, inheritedMsrNames } =
          await import('/scripts/fast-system-kernels.mjs');
        const sides = await Promise.all(
          definitions.map(async ([label]) => {
            const { createCpu } = await import(`/${label}/build/host/index.js`);
            return {
              label,
              createCpu,
              compiler: await WebAssembly.compile(
                await (await fetch(`/${label}/build/ring64.wasm`)).arrayBuffer(),
              ),
            };
          }),
        );
        return {
          ...(await measurePagingPair(
            sides,
            msrMode ? measureInheritedMsr : measurePaging,
            msrMode ? inheritedMsrNames : pagingNames,
            knobs,
          )),
          browserUserAgent: navigator.userAgent,
        };
      },
      { definitions, knobs, msrMode },
    );
    result.browserVersion = browser.version();
  } finally {
    await browser?.close();
    await new Promise((done) => server.close(done));
  }
}
await mkdir(dirname(output), { recursive: true });
await writeFile(
  output,
  encode({
    at: new Date().toISOString(),
    environment: {
      runtime: browserMode ? 'browser' : 'node',
      node: process.version,
      cpu: os.cpus()[0]?.model,
      platform: os.platform(),
      arch: os.arch(),
    },
    sides: definitions.map(([label, side]) => ({ label, ...side })),
    baselineControl: args.includes('--baseline-control'),
    aa: args.includes('--aa'),
    inheritedReference: reference,
    cohort: msrMode ? 'two additional inherited EFER controls' : 'twenty inherited paging kernels',
    knobs,
    kernelSha256: hash(
      await readFile(
        resolve(root, msrMode ? 'scripts/fast-system-kernels.mjs' : 'scripts/paging-kernels.mjs'),
      ),
    ),
    driverSha256: hash(await readFile(resolve(root, 'scripts/fast-system-paging-pair.mjs'))),
    ...result,
  }),
);
console.log({ output, definitions: result.definitions.length, samples: result.samples.length });
