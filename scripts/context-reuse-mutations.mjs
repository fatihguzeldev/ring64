import {
  cp,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (key, fallback) =>
  process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : fallback;
const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
const work = resolve(arg('--work', `/tmp/ring64-context-reuse-mutations-${stamp}`));
const evidence = resolve(arg('--evidence', `/tmp/ring64-context-reuse-mutation-evidence-${stamp}`));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const owners = 'src/dbt/ownership.rs';
const adapter = 'src/embedding/exports/translation.rs';
const validity = 'src/memory/validity.rs';
const fieldOracle = 'context_reuse_assumptions_distinguish_every_normalized_context_field';
const mutants = [
  {
    name: 'fs-base-omitted',
    kind: 'rust-owner',
    file: owners,
    old: 'record.published && record.context == *context && record.observed == observed',
    replacement: `record.published && {
                let mut candidate = context.clone();
                let segment = crate::x86::context::Segment::Fs;
                let mut cache = candidate.segment(segment);
                cache.base = record.context.segment(segment).base;
                candidate.set_segment(segment, candidate.selector(segment), cache, candidate.attributes(segment));
                record.context == candidate
            } && record.observed == observed`,
    filter: fieldOracle,
  },
  {
    name: 'cpl-omitted',
    kind: 'rust-owner',
    file: owners,
    old: 'record.published && record.context == *context && record.observed == observed',
    replacement: `record.published && {
                let mut candidate = context.clone();
                candidate.set_mode_and_cpl(context.mode(), record.context.cpl());
                record.context == candidate
            } && record.observed == observed`,
    filter: fieldOracle,
  },
  {
    name: 'installed-owner-keyed-by-epoch',
    kind: 'rust-owner',
    file: adapter,
    old: '        self.translation_owners\n            .admit(owner, &self.context, observed, || {',
    replacement:
      '        self.context_version == 0 && self.translation_owners\n            .admit(owner, &self.context, observed, || {',
    filter: 'context_reuse_keeps_a_published_owner_alive_but_refuses_the_wrong_context',
  },
  {
    name: 'pending-aba-not-cancelled',
    kind: 'rust-owner',
    file: adapter,
    old: '        self.translation_owners\n            .cancel_pending(|owner| self.image.release(owner));',
    replacement: '        let _ = &self.translation_owners;',
    filter: 'context_reuse_pending_aba_is_cancelled_even_when_epoch_saturates',
  },
  {
    name: 'publication-adopts-late-context',
    kind: 'rust-owner',
    file: owners,
    old: 'if record.context != *context\n            || record.observed != observed',
    replacement:
      'if false && record.context != *context\n            || record.observed != observed',
    filter: 'context_reuse_publication_refuses_late_context_profile_and_invalid_sources',
  },
  {
    name: 'unpublished-owner-can-activate',
    kind: 'rust-owner',
    file: owners,
    old: 'record.published && record.context == *context && record.observed == observed',
    replacement: 'record.context == *context && record.observed == observed',
    extra: [
      {
        file: owners,
        old: '        if !record.published\n            || record.observed != observed',
        replacement: '        if false\n            || record.observed != observed',
      },
    ],
    filter: 'context_reuse_pending_aba_is_cancelled_even_when_epoch_saturates',
  },
  {
    name: 'released-assumptions-leak',
    kind: 'rust-owner',
    file: 'src/embedding/exports/mapped.rs',
    old: '        core.translation_owners.release(owner);',
    replacement: '        let _ = owner;',
    filter: 'context_reuse_pending_aba_is_cancelled_even_when_epoch_saturates',
  },
  {
    name: 'host-ignores-activation-refusal',
    kind: 'public-cpu',
    file: 'host/cpu.ts',
    old: 'if (this.#engine.activate(candidate.artifact.metadata.owner)) {',
    replacement: 'if (this.#engine.activate(candidate.artifact.metadata.owner) || true) {',
    filter: 'keeps dormant FS variants',
  },
  {
    name: 'dormant-owner-pruned-as-dead',
    kind: 'public-cpu',
    file: adapter,
    old: 'self.translation_owners.contains(owner) && self.image.owner_valid(owner)',
    replacement:
      'self.translation_owners.contains(owner) && self.translation_owners.pending_or_eligible(owner, &self.context, self.boundary_observed()) && self.image.owner_valid(owner)',
    extra: [
      {
        file: owners,
        old: '    pub fn admit(',
        replacement:
          '    pub fn pending_or_eligible(&self, owner: u64, context: &ExecutionContext, observed: bool) -> bool { self.records.get(&owner).is_some_and(|record| !record.published || Self::matches(record, context, observed)) }\n\n    pub fn admit(',
      },
    ],
    filter: 'keeps dormant FS variants',
  },
  {
    name: 'fs-msr-publisher-still-retires-all',
    kind: 'public-cpu',
    file: 'src/embedding/exports/paging.rs',
    old: '                        core.context_changed();',
    replacement: '                        core.retire_translations();',
    filter: 'guest FS_BASE WRMSR ends the old native path',
  },
  {
    name: 'dynamic-fast-bank-write-dropped',
    kind: 'public-cpu',
    file: 'src/embedding/exports/fast_system.rs',
    old: '        core.fast_system = bank;',
    replacement: '        let _ = bank;',
    filter: 'mutable entry and SCE',
  },
  {
    name: 'activation-clears-deferred-history',
    kind: 'public-cpu',
    file: adapter,
    old: '    pub(super) fn activate_owner(&mut self, owner: u64) -> bool {',
    replacement:
      '    pub(super) fn activate_owner(&mut self, owner: u64) -> bool {\n        unsafe { (*self.state.get()).debug.continuation = Default::default(); }',
    filter: 'completion consumes SS-deferred history',
  },
  {
    name: 'candidate-scan-falsely-updates-lru',
    kind: 'host-owner',
    file: 'host/translations.ts',
    old: '    return entries.get(pc) ?? EMPTY;',
    replacement:
      '    const found = entries.get(pc) ?? EMPTY;\n    for (const entry of found) this.touch(entry.artifact);\n    return found;',
    testFile: 'host/translations.test.ts',
    filter:
      'same-PC context candidates retain every owner and middle alias without changing recency',
  },
  {
    name: 'global-artifact-cap-doubled',
    kind: 'host-owner',
    file: 'host/translations.ts',
    old: 'this.#artifacts.size >= this.maxArtifacts',
    replacement: 'this.#artifacts.size >= this.maxArtifacts * 2',
    testFile: 'host/translations.test.ts',
    filter: 'count-limited eviction',
  },
  {
    name: 'global-byte-cap-doubled',
    kind: 'host-owner',
    file: 'host/translations.ts',
    old: 'this.#bytes + artifact.metadata.byteLength > this.maxBytes',
    replacement: 'this.#bytes + artifact.metadata.byteLength > this.maxBytes * 2',
    testFile: 'host/translations.test.ts',
    filter: 'byte pressure can evict multiple artifacts',
  },
  {
    name: 'dormant-code-write-not-invalidated',
    kind: 'rust-owner',
    file: validity,
    old: '        for (&id, owner) in self.owners.iter_mut().filter(|(_, owner)| owner.valid) {',
    replacement:
      '        for (&id, owner) in self.owners.iter_mut().filter(|(_, owner)| owner.valid) {\n            if self.active != Some(id) { continue; }',
    filter: 'context_reuse_dormant_alias_writes_are_permanent_death_not_mismatch',
  },
  {
    name: 'pte-read-dependencies-dropped',
    kind: 'public-cpu',
    file: validity,
    old: '.chain(read_ranges.into_iter().map(|range| (range, Access::Read)));',
    replacement: '.chain(read_ranges.into_iter().take(0).map(|range| (range, Access::Read)));',
    filter: 'warm code PTE remap cannot reuse its original physical encoding',
  },
  {
    name: 'paging-fence-keeps-old-owners',
    kind: 'rust-owner',
    file: adapter,
    old: '        self.image.retire_sources();\n        self.translation_owners.clear();',
    replacement: '        let _ = &self.image;',
    filter: 'context_reuse_keeps_exact_paging_fences_and_dynamic_nonfences',
  },
  {
    name: 'backing-remap-revalidation-omitted',
    kind: 'rust-owner',
    file: validity,
    old: '            owner.valid = owner\n                .sources\n                .iter()\n                .all(|source| source_current(source, backings, mappings));',
    replacement: '            let _ = (backings, mappings);\n            owner.valid = true;',
    filter: 'remaps_and_backing_recreation_cannot_resurrect_an_owner',
  },
  {
    name: 'read-dependency-incorrectly-needs-execute',
    kind: 'public-cpu',
    file: validity,
    old: '.chain(read_ranges.into_iter().map(|range| (range, Access::Read)));',
    replacement: '.chain(read_ranges.into_iter().map(|range| (range, Access::Execute)));',
    filter: 'warm code PTE remap cannot reuse its original physical encoding',
  },
  {
    name: 'fs-msr-context-proof-not-cleared',
    kind: 'public-cpu',
    file: 'src/embedding/exports/paging.rs',
    old: '                        core.context_changed();',
    replacement: `                        core.translation_owners.cancel_pending_without_proof_clear(|owner| core.image.release(owner));
                        core.context_version = core.context_version.saturating_add(1);`,
    extra: [
      {
        file: owners,
        old: '    pub fn cancel_pending(&mut self, mut release: impl FnMut(u64)) {',
        replacement: `    pub fn cancel_pending_without_proof_clear(&mut self, mut release: impl FnMut(u64)) {
        self.records.retain(|&owner, record| if record.published { true } else { release(owner); false });
    }

    pub fn cancel_pending(&mut self, mut release: impl FnMut(u64)) {`,
      },
    ],
    filter: 'guest FS_BASE WRMSR ends the old native path',
  },
  {
    name: 'primed-proof-bypasses-live-profile',
    kind: 'rust-owner',
    file: owners,
    old: '            || record.observed != observed\n            || !record.context_proven',
    replacement:
      '            || !record.context_proven && record.observed != observed\n            || !record.context_proven',
    filter: 'context_proof_requires_full_match_and_successful_source_admission',
  },
  {
    name: 'primed-proof-skips-image-activation',
    kind: 'rust-owner',
    file: owners,
    old: '            || !activate()',
    replacement: '            || !record.context_proven && !activate()',
    filter: 'context_proof_does_not_override_image_alias_death_release_or_paging_fences',
  },
];

const requested = arg('--only');
const selection = requested ? new Set(requested.split(',').map((s) => s.trim())) : undefined;
if (selection)
  for (const name of selection)
    if (!mutants.some((m) => m.name === name)) throw Error('unknown mutant: ' + name);
const selected = selection ? mutants.filter((m) => selection.has(m.name)) : mutants;
if (!selected.length) throw Error('empty mutation selection');
if (process.argv.includes('--check')) {
  for (const mutant of selected)
    for (const edit of [mutant, ...(mutant.extra ?? [])]) {
      const source = await readFile(join(root, edit.file), 'utf8');
      if (source.split(edit.old).length !== 2)
        throw Error(mutant.name + ': mutation anchor must match exactly once: ' + edit.file);
    }
  console.log(JSON.stringify({ checkedAnchors: selected.length, executedTests: 0 }));
  process.exit(0);
}
if (process.argv.includes('--list')) {
  console.log(
    JSON.stringify(
      selected.map(({ name, kind, file, filter }) => ({ name, kind, file, filter })),
      null,
      2,
    ),
  );
  process.exit(0);
}
if (!work.startsWith('/tmp/') || work === root || work.startsWith(root + '/'))
  throw Error('a separate /tmp work directory is mandatory');
const reuse = process.argv.includes('--reuse');
for (const path of [work, join(work, 'target')]) {
  const stat = await lstat(path).catch((error) => {
    if (error.code === 'ENOENT') return;
    throw error;
  });
  if (stat?.isSymbolicLink()) throw Error('work and target must not be symlinks');
}
if (reuse && (await realpath(work)) === (await realpath(root)))
  throw Error('work aliases main checkout');
await mkdir(work, { recursive: reuse });
await mkdir(evidence);
for (const directory of ['src', 'host', 'tests']) {
  await rm(join(work, directory), { recursive: true, force: true });
  await cp(join(root, directory), join(work, directory), { recursive: true });
}
for (const file of ['Cargo.toml', 'Cargo.lock', 'package.json', 'tsconfig.json'])
  await copyFile(join(root, file), join(work, file));
if (!reuse) await symlink(join(root, 'node_modules'), join(work, 'node_modules'), 'dir');
await mkdir(join(work, 'build'), { recursive: true });
const env = { ...process.env, CARGO_TARGET_DIR: join(work, 'target') };

async function projection(base, directories, names) {
  const files = [];
  async function visit(path) {
    for (const entry of (await readdir(join(base, path), { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const name = join(path, entry.name);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) files.push([name, hash(await readFile(join(base, name)))]);
    }
  }
  for (const directory of directories) await visit(directory);
  for (const name of names) files.push([name, hash(await readFile(join(base, name)))]);
  return { sha256: hash(JSON.stringify(files)), files };
}
async function identity(base) {
  const runtime = await projection(base, ['src', 'host'], ['Cargo.toml', 'Cargo.lock']);
  const oracles = await projection(base, ['tests'], ['package.json', 'tsconfig.json']);
  return { sha256: hash(JSON.stringify([runtime.sha256, oracles.sha256])), runtime, oracles };
}
const candidate = await identity(work);
const sourceCommit = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).stdout.trim();
const originals = new Map(
  await Promise.all(
    [...new Set(mutants.flatMap((m) => [m.file, ...(m.extra ?? []).map((e) => e.file)]))].map(
      async (file) => [file, await readFile(join(work, file), 'utf8')],
    ),
  ),
);
for (const mutant of selected)
  for (const edit of [mutant, ...(mutant.extra ?? [])])
    if (originals.get(edit.file).split(edit.old).length !== 2)
      throw Error(mutant.name + ': mutation anchor must match exactly once: ' + edit.file);
const driver = await readFile(fileURLToPath(import.meta.url));
await writeFile(join(evidence, 'context-reuse-mutations.mjs'), driver);
const cases = `import { readFile } from 'node:fs/promises';
import { contextReuseScenarios } from './tests/execution/context-reuse/index.ts';
import { fastSystemScenarios } from './tests/execution/fast-system/index.ts';
import { pagingScenarios } from './tests/execution/paging/index.ts';
const compiler=await WebAssembly.compile(new Uint8Array(await readFile('build/ring64.wasm')));
const all=[...contextReuseScenarios(compiler),...fastSystemScenarios(compiler),...pagingScenarios(compiler)];
const selected=process.argv[2]?all.filter(s=>s.name.includes(process.argv[2])):all;
if(!selected.length)throw Error('empty scenario selection');
const passed=[];
for(const s of selected){try{await s.run();passed.push(s.name);}catch(e){const message=String(e.message);const stack=String(e.stack);const semantic=!message.includes('cpu engine failed')&&(stack.includes('/tests/support/fixture.ts')||stack.includes('/tests/execution/context-reuse/fixture.ts'));console.log(JSON.stringify({selected:selected.length,failed:s.name,error:message,stack,semantic}));process.exitCode=1;break;}}
if(!process.exitCode)console.log(JSON.stringify({selected:selected.length,passed:passed.length,names:passed}));
`;
await writeFile(join(work, 'mutation-cases.mjs'), cases);
await writeFile(join(evidence, 'mutation-cases.mjs'), cases);
// Preserve AssertionError.cause, which Node's TAP reporter may flatten to ERR_TEST_FAILURE.
const hostReporter = `const errorInfo = error => error && ({name:error.name,code:error.code,message:error.message,stack:error.stack,actual:error.actual,expected:error.expected,cause:errorInfo(error.cause)});
export default async function* (source) {
  let passed=0,failed=0;const failures=[];
  for await (const event of source) {
    if(event.type==='test:pass')passed++;
    if(event.type==='test:fail'){failed++;failures.push({name:event.data.name,file:event.data.file,error:errorInfo(event.data.details.error)});}
  }
  yield JSON.stringify({passed,failed,failures},(_,value)=>typeof value==='bigint'?value.toString()+'n':value)+'\\n';
}
`;
await writeFile(join(work, 'mutation-host-reporter.mjs'), hostReporter);
await writeFile(join(evidence, 'mutation-host-reporter.mjs'), hostReporter);
function run(command, args, timeout = 240000) {
  const result = spawnSync(command, args, {
    cwd: work,
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    command: [command, ...args],
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
    output: (result.stdout ?? '') + (result.stderr ?? ''),
  };
}
async function logged(label, command, args, timeout) {
  const result = run(command, args, timeout);
  await writeFile(join(evidence, label + '.log'), result.output);
  return result;
}
async function restore() {
  for (const [file, content] of originals) await writeFile(join(work, file), content);
}
async function buildWasm(label) {
  const clean = await logged(label + '-clean', 'cargo', [
    'clean',
    '--package',
    'ring64',
    '--release',
    '--target',
    'wasm32-unknown-unknown',
  ]);
  const built = await logged(label + '-build', 'cargo', [
    'build',
    '--locked',
    '--release',
    '--target',
    'wasm32-unknown-unknown',
  ]);
  if (clean.status !== 0 || built.status !== 0 || clean.error || built.error || built.signal)
    throw Error(label + ': build/clean failure, never a semantic kill');
  await copyFile(
    join(work, 'target/wasm32-unknown-unknown/release/ring64.wasm'),
    join(work, 'build/ring64.wasm'),
  );
  return hash(await readFile(join(work, 'build/ring64.wasm')));
}
async function test(label, kind, filter, testFile) {
  let result,
    detail,
    semantic = false;
  if (kind === 'rust-owner') {
    result = await logged(label + '-test', 'cargo', [
      'test',
      '--locked',
      '--lib',
      filter,
      '--',
      '--nocapture',
    ]);
    const passed = Number(result.output.match(/test result: ok\. (\d+) passed;/)?.[1] ?? 0);
    const failed = Number(
      result.output.match(/test result: FAILED\. \d+ passed; (\d+) failed;/)?.[1] ?? 0,
    );
    const at = result.output.search(/assertion[^\n]*failed/);
    const binary = result.output.match(/Running unittests src\/lib\.rs \(([^)]+)\)/)?.[1];
    const binarySha256 = binary ? hash(await readFile(resolve(work, binary))) : undefined;
    const panic = result.output.match(/panicked at (src\/[^:\n]+):(\d+):(\d+):\n([^\n]+)/);
    let assertionSource;
    if (panic) {
      const source = await readFile(join(work, panic[1]), 'utf8');
      const original = await readFile(join(root, panic[1]), 'utf8');
      const line = source.split('\n')[Number(panic[2]) - 1];
      if (source === original && /^\s*assert(?:_eq|_ne)?!\(/.test(line))
        assertionSource = {
          file: panic[1],
          line: Number(panic[2]),
          source: line.trim(),
          oracleSha256: hash(source),
        };
    }
    detail = {
      passed,
      failed,
      assertionLocation: result.output.match(/panicked at ([^\n]+)/)?.[1],
      assertionSource,
      binary,
      binarySha256,
      assertion: at < 0 ? panic?.[4] : result.output.slice(at, at + 2500),
    };
    semantic =
      result.status === 101 &&
      failed > 0 &&
      Boolean(assertionSource) &&
      !result.output.includes('could not compile');
  } else if (kind === 'host-owner') {
    result = await logged(
      label + '-test',
      'node',
      [
        '--import',
        'tsx',
        '--test',
        '--experimental-test-isolation=none',
        '--test-reporter=./mutation-host-reporter.mjs',
        '--test-name-pattern',
        filter,
        testFile,
      ],
      120000,
    );
    try {
      detail = JSON.parse(result.output.trim().split('\n').at(-1));
    } catch {
      /* reporter failures are uncounted */
    }
    function assertion(error) {
      if (!error) return undefined;
      return error.code === 'ERR_ASSERTION' ? error : assertion(error.cause);
    }
    const failedAssertion = detail?.failures
      ?.map((failure) => ({ ...failure, assertion: assertion(failure.error) }))
      .find(
        (failure) =>
          failure.assertion?.stack?.includes('/' + testFile) && failure.name.includes(filter),
      );
    if (failedAssertion) {
      detail.assertion = failedAssertion.assertion.message;
      detail.assertionError = failedAssertion.assertion;
      detail.oracleSha256 = hash(await readFile(join(work, testFile)));
    }
    semantic = result.status === 1 && detail?.failed > 0 && Boolean(failedAssertion);
  } else {
    result = await logged(
      label + '-test',
      'node',
      ['--import', 'tsx', 'mutation-cases.mjs', ...(filter ? [filter] : [])],
      120000,
    );
    try {
      detail = JSON.parse(result.output.trim().split('\n').at(-1));
    } catch {
      /* runner/engine failures are uncounted */
    }
    semantic = result.status === 1 && detail?.semantic === true && detail?.selected > 0;
  }
  if (result.error || result.signal) semantic = false;
  return { result: { ...result, output: undefined }, detail, semantic };
}
async function baseline(label) {
  const publicCpu = await test(label + '-public', 'public-cpu');
  const owner = await test(label + '-owners', 'rust-owner', 'context_reuse');
  const additional = [];
  const seen = new Set();
  for (const m of selected.filter(
    (m) =>
      m.kind === 'host-owner' || (m.kind === 'rust-owner' && !m.filter.startsWith('context_reuse')),
  )) {
    const key = [m.kind, m.filter, m.testFile].join(':');
    if (seen.has(key)) continue;
    seen.add(key);
    additional.push(
      await test(label + '-extra-' + additional.length, m.kind, m.filter, m.testFile),
    );
  }
  for (const r of [publicCpu, owner, ...additional])
    if (r.result.status !== 0 || r.result.error || r.result.signal || !(r.detail?.passed > 0))
      throw Error(label + ': empty or failing unmutated oracle');
  return { publicCpu, owner, additional };
}
const results = [];
let before, after, baselineWasm, restoredWasm, fatal;
try {
  baselineWasm = await buildWasm('baseline-before');
  if (arg('--expected-wasm') && baselineWasm !== arg('--expected-wasm'))
    throw Error('unmodified baseline Wasm differs from required shipping artifact');
  await copyFile(join(work, 'build/ring64.wasm'), join(evidence, 'baseline.wasm'));
  before = await baseline('baseline-before');
  for (const mutant of selected.filter((m) => m.kind === 'public-cpu'))
    if (!before.publicCpu.detail.names.some((name) => name.includes(mutant.filter)))
      throw Error(mutant.name + ': empty public scenario filter');
  for (const mutant of selected) {
    await restore();
    await copyFile(join(evidence, 'baseline.wasm'), join(work, 'build/ring64.wasm'));
    const edits = [];
    for (const edit of [mutant, ...(mutant.extra ?? [])]) {
      const original = await readFile(join(work, edit.file), 'utf8');
      if (original.split(edit.old).length !== 2)
        throw Error(mutant.name + ': nonunique mutation anchor');
      edits.push({
        file: edit.file,
        line: original.slice(0, original.indexOf(edit.old)).split('\n').length,
        old: edit.old,
        replacement: edit.replacement,
      });
      await writeFile(join(work, edit.file), original.replace(edit.old, edit.replacement));
    }
    await writeFile(join(evidence, mutant.name + '-patch.json'), JSON.stringify(edits, null, 2));
    const began = performance.now();
    let item;
    try {
      const wasmSha256 =
        mutant.kind === 'public-cpu' && mutant.file.startsWith('src/')
          ? await buildWasm(mutant.name)
          : baselineWasm;
      if (mutant.kind === 'rust-owner') {
        const clean = await logged(mutant.name + '-native-clean', 'cargo', [
          'clean',
          '--package',
          'ring64',
        ]);
        if (clean.status !== 0 || clean.error || clean.signal)
          throw Error('native package clean failed; no semantic result');
      }
      const checked = await test(mutant.name, mutant.kind, mutant.filter, mutant.testFile);
      item = {
        name: mutant.name,
        kind: mutant.kind,
        edits,
        filter: mutant.filter,
        testFile: mutant.testFile,
        wasmSha256,
        wasmMutated: mutant.kind === 'public-cpu' && mutant.file.startsWith('src/'),
        status: checked.semantic
          ? 'semantic-kill'
          : checked.result.status === 0 && checked.detail?.passed > 0
            ? 'survived'
            : 'uncounted-error',
        assertion: checked.detail?.error ?? checked.detail?.assertion,
        detail: checked.detail,
        process: checked.result,
      };
    } catch (error) {
      item = {
        name: mutant.name,
        kind: mutant.kind,
        edits,
        status: 'uncounted-error',
        error: error.message,
      };
    }
    item.seconds = Math.round((performance.now() - began) / 10) / 100;
    item.log = join(evidence, mutant.name + '-test.log');
    results.push(item);
    await writeFile(join(evidence, 'results.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(item));
  }
} catch (error) {
  fatal = error.message;
} finally {
  await restore();
  restoredWasm = await buildWasm('restored-final');
  try {
    after = await baseline('baseline-after');
  } catch (error) {
    fatal ??= error.message;
  }
  const restored = await identity(work),
    currentParent = await identity(root);
  const summary = {
    at: new Date().toISOString(),
    sourceCommit,
    driverSha256: hash(driver),
    work,
    target: env.CARGO_TARGET_DIR,
    evidence,
    sourceIdentityScope:
      'runtime: src/** + host/** + Cargo.toml/Cargo.lock; oracles: tests/** + package.json/tsconfig.json',
    candidate,
    parentStillMatches: currentParent.sha256 === candidate.sha256,
    restoredSourceMatches: restored.sha256 === candidate.sha256,
    baselineWasmSha256: baselineWasm,
    restoredWasmSha256: restoredWasm,
    restoredWasmMatches: restoredWasm === baselineWasm,
    before,
    after,
    fatal,
    experiments: results.length,
    semanticKills: results.filter((r) => r.status === 'semantic-kill').length,
    byKind: Object.fromEntries(
      ['public-cpu', 'rust-owner', 'host-owner'].map((kind) => [
        kind,
        {
          experiments: results.filter((r) => r.kind === kind).length,
          semanticKills: results.filter((r) => r.kind === kind && r.status === 'semantic-kill')
            .length,
        },
      ]),
    ),
    results,
  };
  await writeFile(join(evidence, 'summary.json'), JSON.stringify(summary, null, 2));
  await mkdir(join(root, 'build/verification'), { recursive: true });
  await writeFile(
    resolve(root, arg('--output', 'build/verification/context-reuse-mutations-final.json')),
    JSON.stringify(summary, null, 2),
  );
  console.log(
    JSON.stringify({
      final: true,
      experiments: summary.experiments,
      semanticKills: summary.semanticKills,
      byKind: summary.byKind,
      parentStillMatches: summary.parentStillMatches,
      restoredSourceMatches: summary.restoredSourceMatches,
      restoredWasmMatches: summary.restoredWasmMatches,
      fatal,
    }),
  );
  if (
    fatal ||
    !summary.parentStillMatches ||
    !summary.restoredSourceMatches ||
    !summary.restoredWasmMatches ||
    summary.semanticKills !== selected.length
  )
    process.exitCode = 1;
}
