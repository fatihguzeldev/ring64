import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  baselineCommit,
  checkedBaseline,
  encode,
  hash,
  manifest,
  root,
} from './fast-system-support.mjs';

const args = process.argv.slice(2);
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
if (!args.includes('--snapshot')) throw Error('provide the exact candidate artifact --snapshot');
const candidate = await manifest(resolve(value('--snapshot'))),
  old = await checkedBaseline();
const live = await manifest(root);
if (candidate.coreSha256 !== live.coreSha256 || candidate.hostSha256 !== live.hostSha256)
  throw Error('source proof must run while main build still matches the frozen candidate');
const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const baselineSource = (path) => git(['show', baselineCommit + ':' + path]);
const untouched = [
  'src/embedding/layout.rs',
  'src/embedding/exports/context.rs',
  'src/embedding/exports/vector.rs',
  'src/embedding/exports/numeric.rs',
  'src/embedding/exports/x87.rs',
  'src/embedding/exports/mmx.rs',
  'src/embedding/exports/numeric_image.rs',
  'src/embedding/exports/streaming.rs',
  'src/embedding/exports/protection.rs',
  'src/embedding/exports/far_control.rs',
  'src/embedding/exports/software_events.rs',
  'src/memory/access.rs',
  'src/x86/access.rs',
  'src/x86/paging/access.rs',
  'src/x86/paging/walk.rs',
  'src/dbt/wasm/boundary.rs',
];
const files = [],
  unchanged = [];
const benchmarkInputs = [];
for (const name of (await readdir(resolve(old.path, 'benchmarks')))
  .filter((name) => name.endsWith('.mjs'))
  .sort()) {
  const path = 'benchmarks/' + name;
  const before = await readFile(resolve(old.path, path)),
    now = await readFile(resolve(candidate.path, path));
  benchmarkInputs.push({
    path,
    baselineSha256: hash(before),
    currentSha256: hash(now),
    identical: before.equals(now),
  });
  if (!before.equals(now)) throw Error('inherited benchmark input changed: ' + path);
}
for (const path of ['scripts/benchmark.mjs']) {
  const before = await readFile(resolve(old.path, path)),
    now = await readFile(resolve(candidate.path, path));
  benchmarkInputs.push({
    path,
    baselineSha256: hash(before),
    currentSha256: hash(now),
    identical: before.equals(now),
  });
  if (!before.equals(now)) throw Error('inherited benchmark driver changed: ' + path);
}
const pagingKernel = await readFile(resolve(root, 'scripts/paging-kernels.mjs'), 'utf8');
benchmarkInputs.push({
  path: 'scripts/paging-kernels.mjs',
  baselineSha256: hash(baselineSource('scripts/paging-kernels.mjs')),
  currentSha256: hash(pagingKernel),
  identical: pagingKernel === baselineSource('scripts/paging-kernels.mjs'),
});
if (!benchmarkInputs.at(-1).identical) throw Error('predecessor20 paging guest kernels changed');
for (const path of untouched) {
  const now = await readFile(resolve(root, path), 'utf8'),
    before = baselineSource(path);
  unchanged.push({
    path,
    baselineSha256: hash(before),
    currentSha256: hash(now),
    identical: before === now,
  });
  if (before !== now) throw Error('previous successful helper/layout changed: ' + path);
}
const sections = [];
for (const [path, start, end] of [
  ['host/cpu.ts', '  async run(', undefined],
  ['host/core.ts', '  snapshot(): StateSnapshot {', '\n  setState('],
  ['src/embedding/exports.rs', 'macro_rules! guest_access', '\nmod context;'],
  ['src/embedding/exports.rs', 'pub extern "C" fn core_load(', undefined],
]) {
  const current = await readFile(resolve(root, path), 'utf8'),
    baseline = baselineSource(path);
  const take = (source) => {
    const from = source.indexOf(start),
      to = end ? source.indexOf(end, from) : source.length;
    if (from < 0 || to < from) throw Error('missing inherited section: ' + path + ':' + start);
    return source.slice(from, to);
  };
  const a = take(baseline),
    b = take(current);
  sections.push({
    path,
    start,
    end: end ?? 'EOF',
    baselineSha256: hash(a),
    currentSha256: hash(b),
    identical: a === b,
  });
  if (a !== b) throw Error('inherited run/snapshot section changed: ' + path);
}
const references = [];
for (const [path, anchors] of Object.entries({
  'src/dbt/wasm/mod.rs': [
    'let has_fast_system = unit',
    'let fast_system_type = has_fast_system.then',
    'let fast_system = fast_system_type.map',
    'Operation::FastSystem(operation)',
  ],
  'src/dbt/wasm/fast_system.rs': ['pub(super) fn fast_system(', 'self.fast_system.expect'],
  'src/embedding/exports/fast_system.rs': [
    'pub extern "C" fn core_fast_system_state()',
    'pub extern "C" fn core_fast_system(',
  ],
  'src/embedding/exports.rs': ['fast_system: crate::x86::fast_system::State'],
  'host/core.ts': [
    'readFastSystemState(): FastSystemState',
    'env.fast_system = this.#exports.core_fast_system',
  ],
  'src/embedding/exports/paging.rs': [
    'core.fast_system.read_msr',
    'prepare_msr_write(register, value, &core.context)',
  ],
})) {
  const bytes = await readFile(resolve(root, path)),
    source = bytes.toString();
  files.push({ path, sha256: hash(bytes) });
  for (const anchor of anchors) {
    const at = source.indexOf(anchor);
    if (at < 0) throw Error('missing fast-system ownership anchor: ' + path + ':' + anchor);
    references.push({ path, anchor, line: source.slice(0, at).split('\n').length });
  }
}
const output = resolve(value('--output', 'build/verification/fast-system-source-proof.json'));
await mkdir(resolve(root, 'build/verification'), { recursive: true });
await writeFile(
  output,
  encode({
    at: new Date().toISOString(),
    baseline: old,
    candidate,
    files,
    benchmarkInputs,
    unchanged,
    sections,
    references,
    findings: [
      'The inherited memory/system helper bodies/macros, four-level walker/access owners, RunState layout and instruction-boundary emitter are source-identical to8a7ee06. Core gains a separate seven-word bank; its private Rust struct layout may change. This is helper source identity, not a claim that Rust/Wasm core function layout or native machine code is identical.',
      'Cpu.run and the scalar snapshot section remain byte-identical TypeScript. The seven-word fast bank is read only through its explicit API; it is absent from ordinary scalar snapshots and per-dispatch host polling.',
      'The emitter discovers a selected FastSystem operation before adding its type/import/lowering. The accompanying real-Wasm observer verifies exact inherited ordinary/debug-observed/paged generated bytes, imports, bindings and invocation/helper counts; source anchors alone do not prove those dynamic properties.',
      'Core.helperImports binds the new paged fast helper while instantiating an artifact. It does not call the bank getter, add an instruction observer or change the five-argument invocation. New transfer register handover is local to the selected operation.',
      'Existing EFER RDMSR/WRMSR now route beside selected fast MSRs. Their helper body changed, so two literal old-supported EFER controls are paired separately from the20 inherited paging kernels and11 new unsupported-on-baseline characterizations.',
      'No universal zero-overhead or identical compiled-helper-body claim follows. Core/host sizes, creation, compilation, first/early/later phases and short-run controls are measured separately; residual noise and timer floors remain visible.',
    ],
  }),
);
console.log({
  output,
  unchangedFiles: unchanged.length,
  unchangedSections: sections.length,
  references: references.length,
});
