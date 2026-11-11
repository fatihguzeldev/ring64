import { cp, copyFile, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (key, fallback) =>
  process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : fallback;
const tag = new Date().toISOString().replaceAll(/[:.]/g, '-');
const work = resolve(arg('--work', `/tmp/ring64-fast-system-mutations-${tag}`));
const evidence = resolve(arg('--evidence', `/tmp/ring64-fast-system-mutation-evidence-${tag}`));
if (!work.startsWith('/tmp/') || work === root)
  throw Error('mutations require an isolated /tmp copy');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const env = { ...process.env, CARGO_TARGET_DIR: join(work, 'target') };
const semantic = 'src/x86/fast_system.rs';
const lowering = 'src/dbt/wasm/fast_system.rs';
const mutants = [
  {
    name: 'compatibility-syscall-admitted',
    file: 'src/x86/decode/paging.rs',
    old: 'matches!(opcode, 0x05 | 0x07) && !prefixes.long64',
    replacement: 'false',
    extra: [
      {
        file: semantic,
        old: '    if !context.is_long64()\n',
        replacement: '    if false && !context.is_long64()\n',
      },
    ],
    filter: 'own faults preserve source CPL',
  },
  {
    name: 'sce-legality-ignored',
    file: semantic,
    old: 'paging.efer & 1 == 0',
    replacement: 'false',
    filter: 'own faults preserve source CPL',
  },
  {
    name: 'syscall-rf-captured-before-begin',
    file: semantic,
    old: 'flags::architectural(scalar.flags, context) & !flags::RF',
    replacement: 'flags::architectural(scalar.flags, context)',
    extra: [
      {
        file: 'src/dbt/wasm/boundary.rs',
        old: '        self.clear_resume();\n    }\n\n    fn ss_producer',
        replacement:
          '        if !matches!(operation, Operation::FastSystem(_)) { self.clear_resume(); }\n    }\n\n    fn ss_producer',
      },
    ],
    filter: 'SYSCALL and SYSRET sample resulting TF',
  },
  {
    name: 'r11-captured-after-fmask',
    file: semantic,
    old: 'prepared.scalar.registers[11] = saved;',
    replacement: 'prepared.scalar.registers[11] = saved & !bank.fmask;',
    filter: 'SYSCALL and SYSRET sample resulting TF',
  },
  {
    name: 'syscall-saves-source-not-next',
    file: semantic,
    old: 'prepared.scalar.registers[1] = next;',
    replacement: 'prepared.scalar.registers[1] = next.wrapping_sub(2);',
    filter: 'SYSCALL and SYSRET sample resulting TF',
  },
  {
    name: 'sysret-restores-rf',
    file: semantic,
    old: 'scalar.registers[11] & 0x3c7fd7',
    replacement: 'scalar.registers[11] & 0x3d7fd7',
    filter: 'SYSRET32 restores literal flag mask',
  },
  {
    name: 'sysret32-truncates-unchanged-rsp',
    file: semantic,
    old: '        Sysret { wide } => {\n            prepared.scalar.rip',
    replacement:
      '        Sysret { wide } => {\n            if !wide { prepared.scalar.registers[4] = u64::from(scalar.registers[4] as u32); }\n            prepared.scalar.rip',
    filter: 'SYSRET32 restores literal flag mask',
  },
  {
    name: 'sysexit-loads-target-from-rcx',
    file: semantic,
    old: '        Sysexit { wide } => {\n            prepared.scalar.rip = if wide {\n                scalar.registers[2]',
    replacement:
      '        Sysexit { wide } => {\n            prepared.scalar.rip = if wide {\n                scalar.registers[1]',
    filter: 'SYSENTER from all IA32e code sizes',
  },
  {
    name: 'syscall-ss-from-masked-cs',
    file: semantic,
    old: '                selector & 0xfffc,\n                selector.wrapping_add(8),',
    replacement:
      '                selector & 0xfffc,\n                (selector & 0xfffc).wrapping_add(8),',
    filter: 'synthetic cache selectors preserve raw STAR SS',
  },
  {
    name: 'sysret-canonicality-skipped',
    file: semantic,
    old: 'if matches!(instruction, Sysret { wide: true }) && !canonical48(scalar.registers[1])',
    replacement:
      'if false && matches!(instruction, Sysret { wide: true }) && !canonical48(scalar.registers[1])',
    filter: 'own faults preserve source CPL',
  },
  {
    name: 'synthetic-transfer-probes-gdt',
    file: 'src/embedding/exports/fast_system.rs',
    old: '        let prepared = match fast_system::prepare(',
    replacement:
      '        if core.image.physical_read(core.context.gdtr().base, 8).is_err() { return failure(core, Failure::Target); }\n        let prepared = match fast_system::prepare(',
    filter: 'synthetic cache selectors preserve raw STAR SS',
  },
  {
    name: 'synthetic-ss-arms-shadow',
    file: lowering,
    old: '        if self.finish_instruction(depth) {',
    replacement:
      '        self.current_operation = crate::x86::instruction::Operation::PopSs {width:crate::x86::instruction::Width::W16};\n        if self.finish_instruction(depth) {',
    filter: 'ordinary completion exposes NMI',
  },
  {
    name: 'sysenter-cs-loses-unused-low32',
    file: semantic,
    old: '0x174 => bank.sysenter_cs = u64::from(value as u32),',
    replacement: '0x174 => bank.sysenter_cs = u64::from(value as u16),',
    filter: 'guest MSR views retain selected widths',
  },
  {
    name: 'sysenter-null-check-uses-full-bank',
    file: semantic,
    old: 'bank.sysenter_cs & 0xfffc == 0',
    replacement: 'bank.sysenter_cs == 0',
    filter: 'own faults preserve source CPL',
  },
  {
    name: 'fs-gs-base-write-does-not-reach-context',
    file: semantic,
    old: '    cache.base = base;',
    replacement: '    let _ = base;',
    filter: 'straight-line WRMSR FS consumer',
  },
  {
    name: 'msr-base-change-keeps-old-context-owner',
    file: 'src/embedding/exports/paging.rs',
    old: '                    if core.context != context {\n                        core.image.retire_sources();\n                        core.observed_owners.clear();\n                        core.context_version = core.context_version.wrapping_add(1);\n                    }',
    replacement: '',
    filter: 'straight-line WRMSR FS consumer',
  },
  {
    name: 'tf-completion-keeps-incoming-sample',
    file: lowering,
    old: '                .op(Op::LocalSet(sampled_tf));',
    replacement: '                .op(Op::Drop);',
    filter: 'SYSCALL and SYSRET sample resulting TF',
  },
  {
    name: 'quota-before-transfer-completion-arbitration',
    file: lowering,
    old: '        if self.finish_instruction(depth) {',
    replacement: '        self.gates(depth);\n        if self.finish_instruction(depth) {',
    filter: 'ordinary completion exposes NMI',
  },
  {
    name: 'committed-entry-resumes-at-source',
    file: 'src/embedding/exports/fast_system.rs',
    old: '            raw.rip = prepared.scalar.rip;',
    replacement: '            raw.rip = next.wrapping_sub(2);',
    filter: 'target PF and private X refusal',
  },
  {
    name: 'return-uses-source-cpl',
    file: semantic,
    old: '        cpl,\n    );\n    for (segment',
    replacement: '        context.cpl(),\n    );\n    for (segment',
    filter: 'SYSRET32 restores literal flag mask',
  },
  {
    name: 'lstar-write-eagerly-probes-private-backing',
    file: 'src/embedding/exports/paging.rs',
    old: '            3 => core\n                .fast_system',
    replacement:
      '            3 if register == 0xc0000082 && core.image.physical_read(value, 1).is_err() => Err(ControlFailure::GeneralProtection),\n            3 => core\n                .fast_system',
    filter: 'guest MSR views retain selected widths',
  },
  {
    name: 'sce-incorrectly-disables-sysenter',
    file: semantic,
    old: 'matches!(instruction, Syscall | Sysret { .. }) && paging.efer & 1 == 0',
    replacement:
      'matches!(instruction, Syscall | Sysret { .. } | Sysenter) && paging.efer & 1 == 0',
    filter: 'SYSENTER from all IA32e code sizes',
  },
  {
    name: 'pending-compile-base-change-keeps-old-owner',
    file: 'src/embedding/exports/context.rs',
    old: '            core.image.retire_sources();\n            core.context = context;\n            core.context_version = core.context_version.saturating_add(1);',
    replacement: '            core.context = context;',
    filter: 'pending compiler honors changed loaded bases',
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
    [...new Set(mutants.flatMap((m) => [m.file, ...(m.extra ?? []).map((edit) => edit.file)]))].map(
      async (file) => [file, await readFile(join(work, file), 'utf8')],
    ),
  ),
);
const cases = `import { readFile } from 'node:fs/promises';
import { fastSystemScenarios } from './tests/execution/fast-system/index.ts';
const compiler=await WebAssembly.compile(new Uint8Array(await readFile('build/ring64.wasm')));
const all=fastSystemScenarios(compiler);
const selected=process.argv[2]?all.filter(s=>s.name.includes(process.argv[2])):all;
if(!selected.length) throw Error('empty scenario selection');
const passed=[];for(const s of selected){try{await s.run();passed.push(s.name);}catch(e){console.log(JSON.stringify({failed:s.name,error:e.message,stack:e.stack,semantic:!e.message.includes('cpu engine failed')&&e.stack.includes('/tests/support/fixture.ts')}));process.exitCode=1;break;}}
if(!process.exitCode)console.log(JSON.stringify({passed:passed.length,names:passed}));
`;
await writeFile(join(work, 'mutation-cases.mjs'), cases);
await writeFile(join(evidence, 'run-cases.mjs'), cases);
await copyFile(fileURLToPath(import.meta.url), join(evidence, 'fast-system-mutations.mjs'));
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
    for (const edit of mutant.extra ?? []) {
      const text = originals.get(edit.file);
      if (text.split(edit.old).length !== 2)
        throw Error(mutant.name + ': extra mutation must match exactly once');
      await writeFile(join(work, edit.file), text.replace(edit.old, edit.replacement));
    }
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
        extra: mutant.extra,
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
    resolve(root, arg('--output', 'build/verification/fast-system-mutations-final.json')),
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
