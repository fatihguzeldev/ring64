import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { encode, hash, root } from './paging-support.mjs';

// An explicit campaign supplies exact anchors and exact assertion diagnostics.
// Each mutant runs in a copied source sandbox; the working repository is never patched.
// A compile error, timeout, crash, or arbitrary nonzero status is NOT a semantic kill.
// Campaign shape:
// { mutations: [{ name, path, before, after, commands: [["npm","run","build"],
//   ["node","scripts/call-gates-audit.mjs","--current",".","--no-matrix"]],
//   assertion: "raw-new-b16-wrap:.*exact frame and all untouched RAM" }] }
export const callGateMutationPlan = [
  {
    name: 'truncate-count31',
    owner: 'far/gates.rs',
    mutation: 'replace count mask 31 with 15',
    assertion: 'legacy-w4-n31-*: exact frame/raw pointer',
    domains: ['all32counts', '35-slot maximum'],
  },
  {
    name: 'source-width-frame',
    owner: 'far/gates.rs',
    mutation: 'choose legacy frame width from far operand descriptor instead of gate type',
    assertion: 'legacy-w2-*: exact frame/raw pointer',
    domains: ['source operand width crosses gate width', 'target CS.D opposite gate width'],
  },
  {
    name: 'ascending-push-order',
    owner: 'far/gates.rs',
    mutation: 'store parameter index into frame.writes[2+index] instead of reversed frame slot',
    assertion: 'captured-overlap-n2: exact frame and all untouched RAM',
    domains: ['literal A,B order', 'overlapping source/destination'],
  },
  {
    name: 'capture-after-publication',
    owner: 'far/gates.rs',
    mutation: 'move old parameter reads after SS/SP descriptor/frame payload writes',
    assertion: 'captured-overlap-n1 or n2: captured literal parameter differs',
    domains: ['capture-before-payload policy', 'no native progressive-overlap claim'],
  },
  {
    name: 'tss-sp-before-ss',
    owner: 'task.rs',
    mutation: 'reverse read_legacy_stack field reads',
    assertion: 'TSS SS-before-SP refusal must report SS field even when both fields refuse',
    domains: ['busy16', 'busy32', 'metadata provenance'],
  },
  {
    name: 'initial-rsp-canonical',
    owner: 'far/gates.rs',
    mutation: 'reject initial_sp before touched push spans',
    assertion: 'ia64-*-first-hole-pushes-canonical: completion must succeed',
    domains: ['first-hole initial RSP', 'same/inner'],
  },
  {
    name: 'old-cpl-destination',
    owner: 'far/gates.rs',
    mutation: 'pass context.cpl() to check_frame_write rather than prospective cpl',
    assertion: 'new supervisor stack PTE must admit newCPL0 writes from oldCPL3',
    domains: ['WP1 supervisor destination', 'old user parameter read'],
  },
  {
    name: 'supervisor-parameter-read',
    owner: 'far/gates.rs',
    mutation: 'read parameters through prospective context instead of original context',
    assertion: 'old user parameter U0 must fault with US=1',
    domains: ['old CPL', 'old SS', 'no copied payload'],
  },
  {
    name: 'invented-old-stack-debug',
    owner: 'exports/far_control.rs',
    mutation: 'reuse old operands::far CALL footprint instead of observed actual slots',
    assertion: 'old-stack write watch must miss and actual new frame watch must hit',
    domains: ['linear watch', 'source-width differs gate width', 'metadata excluded'],
  },
  {
    name: 'publish-failed-debug-candidate',
    owner: 'exports/far_control.rs',
    mutation: 'merge observed hit mask even when gate returns Err',
    assertion: 'repair retry with watch removed must not inherit failed tentative hits',
    domains: ['debug fault atomicity', 'later preflight refusal'],
  },
  {
    name: 'restart-begun-source-alias',
    owner: 'paging bridge',
    mutation: 'restart captured gate when begun TSS/parameter/frame A/D edits source code',
    assertion: 'A0 TSS-walk changes gate selector 13 to33 but captured13 must retire exactly once',
    domains: ['source owner invalidation', 'retired1', 'successor redispatch'],
  },
  {
    name: 'erase-canonical-provenance',
    owner: 'exports/far_control.rs',
    mutation: 'replace SYSTEM_MEMORY report with PROTECTION or remove selected companion',
    assertion: 'report full original SystemMemoryFault and opt-in selector-coded GP must both hold',
    domains: [
      'header/target/newSS selector reference',
      'CALL/JMP only',
      'RETF/LTR negative controls',
    ],
  },
];

const args = process.argv.slice(2);
const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
if (args.includes('--plan')) {
  console.log(
    encode({
      ceiling: 'Design plan only. No mutants executed or killed.',
      mutations: callGateMutationPlan,
    }),
  );
} else {
  const campaignPath = value('--campaign');
  if (!campaignPath) throw Error('use --plan or --campaign FILE [--run] [--output FILE]');
  const campaign = JSON.parse(await readFile(resolve(campaignPath), 'utf8'));
  if (!Array.isArray(campaign.mutations) || !campaign.mutations.length)
    throw Error('campaign requires mutations');
  const files = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (files.status !== 0) throw Error('cannot enumerate source snapshot');
  const paths = [...new Set(files.stdout.split('\0').filter(Boolean))].sort();
  const sourceHash = async () => {
    const entries = [];
    for (const path of paths) entries.push([path, hash(await readFile(resolve(root, path)))]);
    return hash(JSON.stringify(entries));
  };
  const beforeHash = await sourceHash();
  const records = [];
  for (const row of campaign.mutations) {
    if (
      !row.name ||
      !row.path ||
      !row.before ||
      typeof row.after !== 'string' ||
      !row.assertion ||
      !Array.isArray(row.commands) ||
      !row.commands.length
    )
      throw Error('incomplete mutation definition');
    if (!paths.includes(row.path))
      throw Error(`mutation path outside source snapshot: ${row.path}`);
    const source = await readFile(resolve(root, row.path), 'utf8');
    const occurrences = source.split(row.before).length - 1;
    if (occurrences !== 1) {
      records.push({ name: row.name, classification: 'anchor-missing-or-ambiguous', occurrences });
      continue;
    }
    const assertion = new RegExp(row.assertion, 's');
    if (!args.includes('--run')) {
      records.push({
        name: row.name,
        classification: 'ready-unexecuted',
        assertion: row.assertion,
        commands: row.commands,
      });
      continue;
    }
    const sandbox = await mkdtemp(resolve(tmpdir(), 'ring64-call-gate-mutant-'));
    for (const path of paths) {
      const destination = resolve(sandbox, path);
      await mkdir(dirname(destination), { recursive: true });
      await cp(resolve(root, path), destination);
    }
    await symlink(resolve(root, 'node_modules'), resolve(sandbox, 'node_modules'), 'dir');
    // Artifact manifests in the isolated copy need a source identity but no mutable Git checkout.
    await writeFile(
      resolve(sandbox, 'paging-source.json'),
      encode({ source: { snapshotSha256: beforeHash, mutation: row.name } }),
    );
    await writeFile(resolve(sandbox, row.path), source.replace(row.before, row.after));
    const commands = [];
    let classification = 'survived';
    for (let i = 0; i < row.commands.length; i++) {
      const command = row.commands[i];
      if (
        !Array.isArray(command) ||
        command.some((word) => typeof word !== 'string') ||
        !command.length
      )
        throw Error('commands must be argv arrays');
      const ran = spawnSync(command[0], command.slice(1), {
        cwd: sandbox,
        encoding: 'utf8',
        timeout: campaign.timeoutMs ?? 300000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, CARGO_TARGET_DIR: resolve(sandbox, 'target') },
      });
      const diagnostic = `${ran.stdout ?? ''}\n${ran.stderr ?? ''}`;
      commands.push({
        argv: command,
        status: ran.status,
        signal: ran.signal,
        error: ran.error?.message,
        diagnostic,
      });
      if (ran.status !== 0) {
        classification =
          i < row.commands.length - 1
            ? 'build-or-setup-failed'
            : ran.error || ran.signal
              ? 'harness-failed'
              : assertion.test(diagnostic)
                ? 'killed-by-specific-assertion'
                : 'unclassified-failure';
        break;
      }
    }
    records.push({ name: row.name, classification, assertion: row.assertion, sandbox, commands });
  }
  const afterHash = await sourceHash();
  if (afterHash !== beforeHash)
    throw Error(
      'source repository changed during mutation campaign; discard results and retry in a quiet window',
    );
  const result = {
    sourceSha256: beforeHash,
    originalSourceUnchanged: true,
    executed: args.includes('--run'),
    killed: records.filter((row) => row.classification === 'killed-by-specific-assertion').length,
    records,
  };
  const output = resolve(
    value('--output') ?? `build/verification/call-gate-mutations-${Date.now()}.json`,
  );
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, encode(result));
  console.log({
    output,
    killed: result.killed,
    classifications: records.map((row) => [row.name, row.classification]),
  });
}
