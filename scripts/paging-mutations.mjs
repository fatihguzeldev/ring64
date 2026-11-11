import { cp, copyFile, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (key, fallback) =>
  process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : fallback;
const tag = new Date().toISOString().replaceAll(/[:.]/g, '-');
const work = resolve(arg('--work', `/tmp/ring64-paging-mutations-${tag}`));
const evidence = resolve(arg('--evidence', `/tmp/ring64-paging-mutation-evidence-${tag}`));
if (!work.startsWith('/tmp/') || work === root)
  throw Error('mutations require an isolated /tmp copy');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const env = { ...process.env, CARGO_TARGET_DIR: join(work, 'target') };
const access = 'src/x86/paging/access.rs';
const paging = 'src/embedding/exports/paging.rs';
const exception = 'src/x86/exception.rs';
const delivery = 'src/embedding/exports/exception_delivery.rs';
const walk = 'src/x86/paging/walk.rs';
const mutants = [
  {
    name: 'early-partial-dirty-publication',
    file: access,
    old: `        let mut updates = Vec::new();\n        for prepared in &pending {\n            updates.extend(self.dirty_admission(prepared, &prepared.fields)?);\n        }\n        self.dirty_publish(&updates);`,
    replacement: `        for prepared in &pending {\n            let updates = self.dirty_admission(prepared, &prepared.fields)?;\n            self.dirty_publish(&updates);\n        }`,
    filter: 'all frame dirty admissions',
  },
  {
    name: 'captured-frame-destinations-rewalked',
    file: access,
    old: '            Some(p) => p,',
    replacement:
      '            Some(p) => self.prepare(address, width, Access::Write, false, p.fragments[0].request.user)?,',
    filter: 'mutation oracle committed early frame alias',
  },
  {
    name: 'system-metadata-uses-source-cpl',
    file: access,
    old: '        self.read_at(address, width, false)',
    replacement: '        self.read_at(address, width, self.user)',
    filter: 'ring3 PF entry uses supervisor metadata',
  },
  {
    name: 'new-frame-uses-source-cpl',
    file: access,
    old: '        self.capture_write(address, width, cpl == 3)',
    replacement: '        self.capture_write(address, width, self.user)',
    filter: 'ring3 PF entry uses supervisor metadata',
  },
  {
    name: 'frozen-pf-reconstructed-from-live-cr2',
    file: paging,
    old: '        core.paging = Some(candidate);\n        core.paging_work.clear();',
    replacement: `        core.paging = Some(candidate);\n        unsafe { if (*core.state.get()).event.kind == 1 && (*core.state.get()).event.vector == 14 { (*core.state.get()).paging_source.address = candidate.cr2; } }\n        core.paging_work.clear();`,
    filter: 'frozen PF import survives bank repair',
  },
  {
    name: 'secondary-page-fault-skips-cr2',
    file: paging,
    old: `                self.paging\n                    .as_mut()\n                    .expect("page fault belongs to paged execution")\n                    .cr2 = fault.address;`,
    replacement: `                if unsafe { (*self.state.get()).event.kind } == 0 {\n                    self.paging.as_mut().expect("paged execution").cr2 = fault.address;\n                }`,
    filter: 'nested PF updates CR2 again during DF',
  },
  {
    name: 'contributory-to-pf-wrongly-double-faults',
    file: exception,
    old: 'let double_fault = self.vector == 14 || vector != 14 && matches!(self.vector, 0 | 10..=13);',
    replacement: 'let double_fault = self.vector == 14 || matches!(self.vector, 0 | 10..=13);',
    filter: 'sources fold asymmetrically',
  },
  {
    name: 'private-failure-cancels-ss-history',
    file: delivery,
    old: '        let event = match reason {',
    replacement: `        if reason == super::super::layout::PHYSICAL_MEMORY { state.debug.continuation = super::super::layout::debug::Continuation::default(); }\n        let event = match reason {`,
    filter: 'private dirty metadata refusal preserves',
  },
  {
    name: 'physical-refusal-fabricates-page-fault',
    file: walk,
    old: `        Failure::Physical(PhysicalFault {\n            linear: self.linear,\n            access: self.access,\n            physical,\n            phase,\n        })`,
    replacement: `        { let _ = (physical, phase); Failure::Page(PageFault { address: self.linear, access: self.access, error_code: 0 }) }`,
    filter: 'scalar cross-page failure publishes no partial store',
  },
  {
    name: 'page-fault-write-intent-bit-lost',
    file: walk,
    old: '| (u32::from(self.access == Access::Write) << 1)',
    replacement: '| 0',
    filter: 'IRQ14 and NMI remain benign sources',
  },
  {
    name: 'unselected-sparse-pages-dirtied',
    file: access,
    old: '    fields.iter().any(|&(start, length)| {',
    replacement: '    true || fields.iter().any(|&(start, length)| {',
    filter: 'MASKMOV checks the full nominal span',
  },
  {
    name: 'paged-effective-ss-provenance-lost',
    file: 'src/dbt/wasm/memory.rs',
    old: '        if self.paged {\n            self.record_fault_segment(self.segment);\n        }',
    replacement: '',
    filter: 'preserves effective stack segment',
  },
  {
    name: 'physical-access-wrongly-requires-linear-canonicality',
    file: 'src/memory/address.rs',
    old: 'pub(super) fn check_physical_span(address: u64, width: u32, access: Access) -> Result<(), Fault> {\n    match physical_span_failure',
    replacement:
      'pub(super) fn check_physical_span(address: u64, width: u32, access: Access) -> Result<(), Fault> {\n    if width != 0 && !canonical48(address) { return Err(Fault { address, width, access, cause: Cause::AddressRange, failing: u128::from(address) }); }\n    match physical_span_failure',
    filter: 'noncanonical numeric physical addresses',
  },
  {
    name: 'upper-permission-stops-before-controlling-leaf',
    file: walk,
    old: '        executable &= entry & (1 << 63) == 0;\n        if leaf {',
    replacement:
      '        executable &= entry & (1 << 63) == 0;\n        if !leaf && (request.user && !user || request.access == Access::Write && !writable && (request.user || state.cr0 & (1 << 16) != 0) || request.access == Access::Execute && !executable) { return Err(request.page_fault(state, true, false)); }\n        if leaf {',
    filter: 'lower controlling nonpresent and reserved entries',
  },
  {
    name: 'nonleaf-rw-us-xd-aggregation-ignored',
    file: walk,
    old: '        user &= entry & 4 != 0;\n        writable &= entry & 2 != 0;\n        executable &= entry & (1 << 63) == 0;',
    replacement:
      '        if leaf { user = entry & 4 != 0; writable = entry & 2 != 0; executable = entry & (1 << 63) == 0; }',
    filter: 'every nonleaf',
  },
  {
    name: 'large-page-pat-misclassified-as-reserved-address',
    file: walk,
    old: 'let reserved_address = large && entry & (((1u64 << shift) - 1) & !0x1fff) != 0;',
    replacement: 'let reserved_address = large && entry & (((1u64 << shift) - 1) & !0xfff) != 0;',
    filter: 'both large page sizes',
  },
  {
    name: 'speculative-successor-compilation-publishes-accessed',
    file: 'src/embedding/exports.rs',
    old: '        let observed = core.boundary_observed();\n        match dbt::compile_with_paging',
    replacement:
      '        let observed = core.boundary_observed();\n        if let Some(bank) = core.paging { let request = crate::x86::paging::walk::Request { linear: (pc & !0xfff).wrapping_add(0x1000), access: Access::Execute, user: core.context.cpl() == 3 }; let _ = crate::x86::paging::walk::walk(&mut core.image, &bank, request); }\n        match dbt::compile_with_paging',
    filter: 'speculative discovery leave future code A',
  },
  {
    name: 'page-table-source-dependencies-omitted',
    file: 'src/embedding/exports.rs',
    old: '                    artifact.read_dependencies.iter().map(|range| (range.start, range.length)),',
    replacement: '                    std::iter::empty::<(u64, u32)>(),',
    filter: 'warm code PTE remap',
  },
  {
    name: 'physical-publication-skips-code-alias-invalidation',
    file: 'src/memory/access.rs',
    old: '            let backing = &mut self.backings[mapping.backing];\n            if backing.has_sources {\n                self.validity\n                    .write(&backing.incarnation, offset as u32, count as u32);',
    replacement:
      '            let backing = &mut self.backings[mapping.backing];\n            if false && backing.has_sources {\n                self.validity\n                    .write(&backing.incarnation, offset as u32, count as u32);',
    filter: 'read-accessed and dirty alias publication invalidate',
  },
  {
    name: 'native-rep-skips-code-invalidation-redispatch',
    file: 'src/dbt/wasm/strings.rs',
    old: '        if self.paged {\n            self.op(Op::LocalGet(self.boundary_result.unwrap()))\n                .op(Op::I32Eqz)\n                .op(Op::If(BlockType::Empty));\n            self.exit(DISPATCH, exit_depth + 3);\n            self.op(Op::End);\n        } else if self.stores {',
    replacement: '        if !self.paged && self.stores {',
    filter: 'native REP abandons changed STOSD',
  },
];

async function identity(base) {
  const files = [];
  async function visit(path) {
    for (const item of (await readdir(join(base, path), { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const name = join(path, item.name);
      if (item.isDirectory()) await visit(name);
      else if (item.isFile()) files.push([name, sha(await readFile(join(base, name)))]);
    }
  }
  await visit('src');
  await visit('host');
  for (const name of ['Cargo.toml', 'Cargo.lock'])
    files.push([name, sha(await readFile(join(base, name)))]);
  return { sha256: sha(JSON.stringify(files)), files };
}
function run(command, args, timeout = 240000) {
  const result = spawnSync(command, args, {
    cwd: work,
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: result.status,
    output: (result.stdout ?? '') + (result.stderr ?? ''),
    error: result.error?.message,
  };
}
const only = process.argv.includes('--only')
  ? new Set(
      arg('--only')
        .split(',')
        .map((name) => name.trim()),
    )
  : undefined;
if (only)
  for (const name of only)
    if (!mutants.some((mutant) => mutant.name === name))
      throw Error('unknown mutant selection: ' + name);
const selectedMutants = only ? mutants.filter((mutant) => only.has(mutant.name)) : mutants;
if (!selectedMutants.length) throw Error('unknown mutant selection');
const reuse = process.argv.includes('--reuse');
await mkdir(work, { recursive: reuse });
await mkdir(evidence);
for (const directory of ['src', 'host', 'tests'])
  await cp(join(root, directory), join(work, directory), { recursive: true });
for (const file of ['Cargo.toml', 'Cargo.lock', 'package.json', 'tsconfig.json'])
  await copyFile(join(root, file), join(work, file));
if (!reuse) await symlink(join(root, 'node_modules'), join(work, 'node_modules'), 'dir');
await mkdir(join(work, 'build'), { recursive: reuse });
const candidate = await identity(work);
const originals = new Map(
  await Promise.all(
    [...new Set(mutants.map((m) => m.file))].map(async (file) => [
      file,
      await readFile(join(work, file), 'utf8'),
    ]),
  ),
);
const cases = `import { readFile } from 'node:fs/promises';
import { pagingScenarios } from './tests/execution/paging/index.ts';
import { pagingBoundaryReviewScenarios } from './tests/execution/paging/review-boundaries.ts';
import { pagingReviewFetchScenarios } from './tests/execution/paging/review-fetch.ts';
import { pagingReviewAccessScenarios } from './tests/execution/paging/review-access.ts';
import { pagingMutationOracleScenarios } from './tests/execution/paging/mutation-oracles.ts';
import { pagingPermissionReviewScenarios } from './tests/execution/paging/review-permissions.ts';
const compiler=await WebAssembly.compile(new Uint8Array(await readFile('build/ring64.wasm')));
const all=[...new Map([...pagingScenarios(compiler),...pagingBoundaryReviewScenarios(compiler),...pagingReviewFetchScenarios(compiler),...pagingReviewAccessScenarios(compiler),...pagingMutationOracleScenarios(compiler),...pagingPermissionReviewScenarios(compiler)].map(s=>[s.name,s])).values()];
const selected=process.argv[2]?all.filter(s=>s.name.includes(process.argv[2])):all;
if(!selected.length) throw Error('empty scenario selection');
const passed=[];for(const s of selected){try{await s.run();passed.push(s.name);}catch(e){console.log(JSON.stringify({failed:s.name,error:e.message,stack:e.stack,semantic:!e.message.includes('cpu engine failed')&&e.stack.includes('/tests/support/fixture.ts')}));process.exitCode=1;break;}}
if(!process.exitCode)console.log(JSON.stringify({passed:passed.length,names:passed}));
`;
await writeFile(join(work, 'mutation-cases.mjs'), cases);
await writeFile(join(evidence, 'run-cases.mjs'), cases);
await copyFile(fileURLToPath(import.meta.url), join(evidence, 'paging-mutations.mjs'));
const results = [];
async function restore() {
  for (const [file, text] of originals) await writeFile(join(work, file), text);
}
async function build(label) {
  const clean = run('cargo', [
    'clean',
    '--package',
    'ring64',
    '--release',
    '--target',
    'wasm32-unknown-unknown',
  ]);
  const built = run('cargo', [
    'build',
    '--locked',
    '--release',
    '--target',
    'wasm32-unknown-unknown',
  ]);
  await writeFile(join(evidence, `${label}-build.log`), clean.output + built.output);
  if (clean.status !== 0 || built.status !== 0)
    throw Error(`${label}: build failure (not a semantic kill)`);
  await copyFile(
    join(work, 'target/wasm32-unknown-unknown/release/ring64.wasm'),
    join(work, 'build/ring64.wasm'),
  );
  return sha(await readFile(join(work, 'build/ring64.wasm')));
}
async function test(label, filter) {
  const result = run(
    'node',
    ['--import', 'tsx', 'mutation-cases.mjs', ...(filter ? [filter] : [])],
    120000,
  );
  await writeFile(join(evidence, `${label}-test.log`), result.output);
  let detail;
  try {
    detail = JSON.parse(result.output.trim().split('\n').at(-1));
  } catch {
    /* uncounted runner failure */
  }
  return { result, detail };
}
let before, after, restoredWasm, baselineWasm;
try {
  baselineWasm = await build('baseline-before');
  before = await test('baseline-before');
  if (before.result.status !== 0) throw Error('baseline scenarios must pass before mutations');
  console.log(
    JSON.stringify({
      baselinePassed: before.detail.passed,
      candidate: candidate.sha256,
      baselineWasm,
    }),
  );
  for (const mutant of selectedMutants) {
    await restore();
    const original = originals.get(mutant.file);
    if (original.split(mutant.old).length !== 2)
      throw Error(`${mutant.name}: mutation must match exactly once`);
    const line = original.slice(0, original.indexOf(mutant.old)).split('\n').length;
    await writeFile(join(work, mutant.file), original.replace(mutant.old, mutant.replacement));
    const began = performance.now();
    let item;
    try {
      const wasm = await build(mutant.name);
      const checked = await test(mutant.name, mutant.filter);
      item = {
        name: mutant.name,
        file: mutant.file,
        line,
        filter: mutant.filter,
        wasmSha256: wasm,
        status:
          checked.result.status === 0
            ? 'survived'
            : checked.detail?.semantic === true
              ? 'semantic-kill'
              : 'uncounted-error',
        assertion: checked.detail?.error,
        scenario: checked.detail?.failed,
        old: mutant.old,
        replacement: mutant.replacement,
      };
    } catch (error) {
      item = {
        name: mutant.name,
        file: mutant.file,
        line,
        status: 'build-or-run-error',
        error: error.message,
      };
    }
    item.seconds = Math.round((performance.now() - began) / 10) / 100;
    item.buildLog = join(evidence, `${mutant.name}-build.log`);
    item.testLog = join(evidence, `${mutant.name}-test.log`);
    results.push(item);
    await writeFile(join(evidence, 'results.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(item));
  }
} finally {
  await restore();
  restoredWasm = await build('restored-final');
  after = await test('baseline-after');
  const restored = await identity(work);
  const parentNow = await identity(root);
  const summary = {
    at: new Date().toISOString(),
    work,
    evidence,
    target: env.CARGO_TARGET_DIR,
    candidate,
    parentStillMatches: parentNow.sha256 === candidate.sha256,
    restoredSourceMatches: restored.sha256 === candidate.sha256,
    baselineWasmSha256: baselineWasm,
    restoredWasmSha256: restoredWasm,
    restoredWasmMatches: baselineWasm === restoredWasm,
    baselineBefore: before?.detail,
    baselineAfter: after.detail,
    baselineAfterStatus: after.result.status,
    mutations: results.length,
    semanticKills: results.filter((r) => r.status === 'semantic-kill').length,
    results,
  };
  await writeFile(join(evidence, 'summary.json'), JSON.stringify(summary, null, 2));
  await mkdir(join(root, 'build/verification'), { recursive: true });
  await writeFile(
    resolve(root, arg('--output', 'build/verification/paging-mutations-final.json')),
    JSON.stringify(summary, null, 2),
  );
  console.log(
    JSON.stringify({
      final: true,
      mutations: summary.mutations,
      semanticKills: summary.semanticKills,
      restoredSourceMatches: summary.restoredSourceMatches,
      restoredWasmMatches: summary.restoredWasmMatches,
      baselineAfterPassed: after.detail?.passed,
      parentStillMatches: summary.parentStillMatches,
    }),
  );
  if (
    after.result.status !== 0 ||
    !summary.restoredSourceMatches ||
    !summary.restoredWasmMatches ||
    summary.semanticKills !== selectedMutants.length
  )
    process.exitCode = 1;
}
