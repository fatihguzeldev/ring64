import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import {
  assertFastCandidate,
  baseline,
  checkedBaseline,
  encode,
  freeze,
  manifest,
  root,
} from './fast-system-support.mjs';

const args = process.argv.slice(2);
const browserMode = args.includes('--browser');
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
const current = args.includes('--snapshot')
  ? await manifest(resolve(value('--snapshot')))
  : await freeze(value('--current', root), `fast-system-observer-build-${stamp}`);
const old = await checkedBaseline(value('--baseline', baseline));
if (args.includes('--baseline-control')) {
  if (resolve(current.path) !== resolve(old.path))
    throw Error('baseline control requires the same exact8a build');
} else await assertFastCandidate(current.path);
const output = resolve(
  value(
    '--output',
    `build/verification/fast-system-observer-${browserMode ? 'chrome' : 'node'}-${stamp}.json`,
  ),
);

// Self-contained so the same transparent instrumentation runs in Node and Chrome.
async function observe({
  sides: definitions,
  kernels,
  pagingKernels,
  fastKernels,
  includeFast,
  iterations,
}) {
  const canonical = (value) =>
    JSON.stringify(value, (_, item) => {
      if (typeof item === 'bigint') return item.toString();
      if (item && typeof item === 'object' && !Array.isArray(item))
        return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
      return item;
    });
  const same = (a, b) => canonical(a) === canonical(b);
  const key = (bytes) => {
    let text = '';
    for (let i = 0; i < bytes.length; i += 8192)
      text += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(text);
  };
  const hash = async (bytes) =>
    [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('');
  const evidence = {
    timed: false,
    description:
      'Transparent actual Cpu/Wasm observation of all170 report/169 matched inherited linear groups and the20 inherited paged kernels, including debug-observed artifacts. All Core prototype methods/getters and generated helper calls are counted. Instrumentation is excluded from timing cohorts.',
    interfaces: [],
    runs: [],
    failures: [],
  };
  const { measure, workloadNames } = await import(kernels);
  const { measurePaging, pagingNames } = await import(pagingKernels);
  if (workloadNames.length !== 170 || pagingNames.length !== 20)
    throw Error('inherited workload manifest changed; review the baseline explicitly');
  evidence.workloads = workloadNames;
  evidence.pagingWorkloads = pagingNames;
  const nativeCompile = WebAssembly.compile,
    NativeInstance = WebAssembly.Instance;
  const modules = new WeakMap(),
    compiled = new Map(),
    namesBySide = new Map(),
    restore = [],
    hooked = new WeakSet();
  let active,
    workload,
    delivery,
    cohort = 'inherited';
  try {
    WebAssembly.compile = async (bytes) => {
      const module = await nativeCompile(bytes);
      if (active) {
        const descriptor = compiled.get(active.side + ':' + key(bytes));
        if (!descriptor) throw Error('unattributed generated module');
        const item = {
          sha256: await hash(bytes),
          bytes: bytes.byteLength,
          observed: descriptor.observed,
          imports: WebAssembly.Module.imports(module),
        };
        modules.set(module, { ...item, side: active.side });
        active.modules.push(item);
      }
      return module;
    };
    WebAssembly.Instance = class extends NativeInstance {
      constructor(module, imports) {
        const metadata = modules.get(module),
          record = active;
        if (record && metadata && imports?.env) {
          const names = namesBySide.get(metadata.side),
            used = new Set(
              metadata.imports.filter((item) => item.module === 'env').map((item) => item.name),
            );
          const bindings = Object.fromEntries(
            Object.entries(imports.env)
              .filter(([name]) => used.has(name))
              .map(([name, value]) => [
                name,
                typeof value === 'function' ? (names.get(value.name) ?? ['unknown']) : ['memory'],
              ]),
          );
          record.bindings.push({ observed: metadata.observed, imports: bindings });
          if (Object.values(bindings).some((names) => names.includes('unknown')))
            throw Error('generated helper binding could not be attributed');
          if (
            record.memoryModel === 'linear' &&
            Object.values(bindings).some((list) =>
              list.some((name) => name.startsWith('core_paged_')),
            )
          )
            throw Error('linear artifact bound a paged helper');
          imports = {
            ...imports,
            env: Object.fromEntries(
              Object.entries(imports.env).map(([name, value]) => [
                name,
                typeof value === 'function'
                  ? (...args) => {
                      if (!active || active.side !== metadata.side)
                        throw Error('helper invoked outside its owning measured run');
                      const calls = metadata.observed ? active.observedCalls : active.ordinaryCalls;
                      calls[name] = (calls[name] ?? 0) + 1;
                      return value(...args);
                    }
                  : value,
              ]),
            ),
          };
        }
        super(module, imports);
        if (record && metadata) {
          record.runArities.push(this.exports.run.length);
          if (this.exports.run.length !== 5)
            throw Error('generated invocation is no longer five arguments');
        }
      }
    };
    const sides = [];
    for (const definition of definitions) {
      const { createCpu } = await import(definition.host + '/index.js');
      const { Core } = await import(definition.host + '/core.js');
      const bytes = definition.bytes
        ? Uint8Array.from(definition.bytes)
        : new Uint8Array(await (await fetch(definition.wasm)).arrayBuffer());
      const compiler = await nativeCompile(bytes),
        api = new NativeInstance(compiler, {}).exports;
      const input = api.core_input(2);
      new Uint8Array(api.memory.buffer).set([0x90, 0], input);
      if (api.core_init(0x1000n, 1, 0x4000n, 1) !== 0) throw Error('layout control failed');
      const layout = JSON.parse(
        new TextDecoder().decode(
          new Uint8Array(api.memory.buffer, api.core_info_ptr(), api.core_info_len()),
        ),
      );
      const exports = WebAssembly.Module.exports(compiler)
        .map((item) => ({
          ...item,
          ...(item.kind === 'function' ? { arity: api[item.name].length } : {}),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const names = new Map();
      for (const item of exports)
        if (item.kind === 'function')
          names.set(api[item.name].name, [...(names.get(api[item.name].name) ?? []), item.name]);
      namesBySide.set(definition.label, names);
      evidence.interfaces.push({ side: definition.label, layout, exports });
      api.core_dispose();
      if (!hooked.has(Core)) {
        hooked.add(Core);
        for (const [name, descriptor] of Object.entries(
          Object.getOwnPropertyDescriptors(Core.prototype),
        )) {
          if (name === 'constructor') continue;
          const operation = descriptor.value ?? descriptor.get;
          if (typeof operation !== 'function') continue;
          const label = descriptor.get ? 'get:' + name : name;
          const wrapped = function (...args) {
            if (active) active.hostCalls[label] = (active.hostCalls[label] ?? 0) + 1;
            const result = operation.apply(this, args);
            if (name === 'compile' && result && active)
              compiled.set(active.side + ':' + key(result.bytes), {
                observed: result.metadata.boundaryObserved ?? false,
              });
            return result;
          };
          Object.defineProperty(
            Core.prototype,
            name,
            descriptor.get ? { ...descriptor, get: wrapped } : { ...descriptor, value: wrapped },
          );
          restore.push(() => Object.defineProperty(Core.prototype, name, descriptor));
        }
      }
      sides.push({
        label: definition.label,
        compiler,
        createCpu: async (options) => {
          const cpu = await createCpu(options);
          return new Proxy(cpu, {
            get(target, name) {
              if (name === 'run')
                return async (...args) => {
                  const record = {
                    side: definition.label,
                    workload,
                    cohort,
                    memoryModel: options.memoryModel ?? 'linear',
                    matchedDelivery: delivery,
                    modules: [],
                    bindings: [],
                    runArities: [],
                    ordinaryCalls: {},
                    observedCalls: {},
                    hostCalls: {},
                  };
                  active = record;
                  try {
                    const result = await target.run(...args);
                    Object.assign(record, {
                      reason: result.reason,
                      retired: result.retired,
                      repeatIterations: result.repeatIterations,
                      resources: result.resources,
                    });
                    evidence.runs.push(record);
                    return result;
                  } finally {
                    active = undefined;
                  }
                };
              const result = Reflect.get(target, name, target);
              return typeof result === 'function' ? result.bind(target) : result;
            },
          });
        },
      });
    }
    const old = evidence.interfaces[0],
      now = evidence.interfaces[1];
    evidence.oldOffsetsPreserved = Object.entries(old.layout)
      .filter(([name]) => name !== 'size' && name !== 'reasons')
      .every(([name, item]) => same(item, now.layout[name]));
    evidence.oldReasonCodesPreserved = same(
      old.layout.reasons,
      now.layout.reasons.slice(0, old.layout.reasons.length),
    );
    evidence.stateSizePreserved = now.layout.size === old.layout.size;
    evidence.oldExportAritiesPreserved = old.exports.every((item) =>
      now.exports.some((entry) => same(item, entry)),
    );
    for (const [name, ok] of Object.entries({
      oldOffsetsPreserved: evidence.oldOffsetsPreserved,
      oldReasonCodesPreserved: evidence.oldReasonCodesPreserved,
      stateSizePreserved: evidence.stateSizePreserved,
      oldExportAritiesPreserved: evidence.oldExportAritiesPreserved,
    }))
      if (!ok) evidence.failures.push(name);
    for (const matchedDelivery of [false, true])
      for (const name of workloadNames) {
        workload = name;
        delivery = matchedDelivery;
        const result = await measure(sides, {
          iterations,
          samples: 1,
          workloads: [name],
          matchedDelivery,
        });
        if (result.unavailable.some((row) => !row.reason.startsWith('TF stepping detects events')))
          throw Error('unexpected unavailable workload: ' + name);
      }
    delivery = false;
    for (const name of pagingNames) {
      workload = name;
      for (const side of sides)
        await measurePaging(side, { iterations, samples: 1, workloads: [name] });
    }
    const activeDefinitions = [];
    if (includeFast) {
      const { measureFast, fastNames, measureInheritedMsr, inheritedMsrNames } = await import(
        fastKernels
      );
      cohort = 'fast-current-only';
      for (const name of fastNames) {
        workload = name;
        const result = await measureFast(sides[1], { iterations, samples: 1, workloads: [name] });
        activeDefinitions.push(...result.definitions);
      }
      cohort = 'inherited-msr-control';
      for (const name of inheritedMsrNames) {
        workload = name;
        for (const side of sides)
          await measureInheritedMsr(side, { iterations, samples: 1, workloads: [name] });
      }
    }
    const activeRuns = evidence.runs.filter((row) => row.cohort === 'fast-current-only');
    evidence.activeCharacterizations = activeDefinitions.map((definition) => {
      const runs = activeRuns.filter((row) => row.workload === definition.name);
      const count = (name) =>
        runs.reduce(
          (sum, row) => sum + (row.ordinaryCalls[name] ?? 0) + (row.observedCalls[name] ?? 0),
          0,
        );
      const helperCalls = {
        fastSystem: count('fast_system'),
        pagingControl: count('paging_control'),
      };
      const exactSelectedHelperWork = same(helperCalls, definition.helperWork);
      if (!exactSelectedHelperWork)
        evidence.failures.push(definition.name + ':selected-helper-work');
      return { definition, runCalls: runs.length, helperCalls, exactSelectedHelperWork };
    });
    const groupKey = (row) =>
      `${row.cohort}:${row.memoryModel}:${row.matchedDelivery}:${row.workload}`;
    const keys = [
      ...new Set(evidence.runs.filter((row) => row.cohort !== 'fast-current-only').map(groupKey)),
    ];
    evidence.comparisons = keys.map((key) => {
      const group = (side) =>
        evidence.runs.filter((row) => groupKey(row) === key && row.side === side);
      const project = (rows) => rows.map(({ side: _side, ...row }) => row);
      const a = group('baseline'),
        b = group('current');
      const fields = [
        'modules',
        'bindings',
        'ordinaryCalls',
        'observedCalls',
        'hostCalls',
        'reason',
        'retired',
        'repeatIterations',
        'resources',
      ];
      const mismatches = fields.filter(
        (field) =>
          !same(
            a.map((row) => row[field]),
            b.map((row) => row[field]),
          ),
      );
      if (!same(project(a), project(b))) evidence.failures.push(key + ':' + mismatches.join(','));
      return {
        key,
        baselineRunCalls: a.length,
        currentRunCalls: b.length,
        baselineModules: a.flatMap((row) => row.modules).length,
        currentModules: b.flatMap((row) => row.modules).length,
        mismatches,
        identical: !mismatches.length,
      };
    });
    evidence.msrComparisons = evidence.comparisons.filter((row) =>
      row.key.startsWith('inherited-msr-control:'),
    );
    evidence.comparisons = evidence.comparisons.filter((row) => row.key.startsWith('inherited:'));
    if (includeFast && evidence.msrComparisons.length !== 2)
      evidence.failures.push('missing inherited EFER controls');
    if (evidence.comparisons.length !== 359)
      evidence.failures.push('expected339 linear groups plus20 paged groups');
    evidence.passed = evidence.failures.length === 0;
  } finally {
    WebAssembly.compile = nativeCompile;
    WebAssembly.Instance = NativeInstance;
    restore.forEach((item) => item());
  }
  return evidence;
}

let result;
if (!browserMode) {
  result = await observe({
    sides: await Promise.all(
      [
        ['baseline', old],
        ['current', current],
      ].map(async ([label, side]) => ({
        label,
        host: pathToFileURL(resolve(side.path, 'build/host')).href,
        bytes: [...(await readFile(resolve(side.path, 'build/ring64.wasm')))],
      })),
    ),
    kernels: pathToFileURL(resolve(root, 'benchmarks/kernels.mjs')).href,
    pagingKernels: pathToFileURL(resolve(root, 'scripts/paging-kernels.mjs')).href,
    fastKernels: pathToFileURL(resolve(root, 'scripts/fast-system-kernels.mjs')).href,
    includeFast: args.includes('--include-fast'),
    iterations: Number(value('--iterations', 101)),
  });
} else {
  const roots = new Map([
    ['baseline', old.path],
    ['current', current.path],
  ]);
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (pathname === '/') {
        response.end('<!doctype html><title>fast-system observer</title>');
        return;
      }
      if (['/scripts/paging-kernels.mjs', '/scripts/fast-system-kernels.mjs'].includes(pathname)) {
        response.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
        response.end(await readFile(resolve(root, '.' + pathname)));
        return;
      }
      const [, label, ...parts] = pathname.split('/');
      const base =
        label === 'benchmarks'
          ? resolve(root, 'benchmarks')
          : resolve(roots.get(label) ?? '/invalid', 'build');
      const file = resolve(base, ...parts);
      if (!file.startsWith(base + '/')) throw Error('outside allowed route');
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
    result = await page.evaluate(observe, {
      sides: ['baseline', 'current'].map((label) => ({
        label,
        host: `/${label}/host`,
        wasm: `/${label}/ring64.wasm`,
      })),
      kernels: '/benchmarks/kernels.mjs',
      pagingKernels: '/scripts/paging-kernels.mjs',
      fastKernels: '/scripts/fast-system-kernels.mjs',
      includeFast: args.includes('--include-fast'),
      iterations: Number(value('--iterations', 101)),
    });
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
    runtime: browserMode ? 'chrome' : 'node',
    manifests: { baseline: old, current },
    baselineControl: args.includes('--baseline-control'),
    ...result,
  }),
);
console.log({
  output,
  passed: result.passed,
  comparisons: result.comparisons.length,
  failures: result.failures,
  activeCharacterizations: result.activeCharacterizations.length,
  msrComparisons: result.msrComparisons.length,
});
if (!result.passed) process.exitCode = 1;
