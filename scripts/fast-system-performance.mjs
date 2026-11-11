import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { assertFastCandidate, baseline, checkedBaseline, root } from './fast-system-support.mjs';

const args = process.argv.slice(2);
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const old = await checkedBaseline(value('--baseline', baseline));
const candidate = resolve(value('--snapshot', value('--current', root)));
const control = args.includes('--baseline-control');
if (control) {
  if (candidate !== resolve(old.path))
    throw Error('--baseline-control requires --snapshot equal to the frozen baseline');
} else if (!args.includes('--freeze-only')) await assertFastCandidate(candidate);
const forwarded = args.filter((argument) => argument !== '--baseline-control');
if (!args.includes('--baseline')) forwarded.push('--baseline', old.path);
if (!args.includes('--tag'))
  forwarded.push('--tag', 'fast-system-' + new Date().toISOString().replaceAll(/[:.]/g, '-'));
const status = await new Promise((done, reject) => {
  const child = spawn(
    process.execPath,
    [resolve(root, 'scripts/paging-performance.mjs'), ...forwarded],
    { cwd: root, stdio: 'inherit' },
  );
  child.once('error', reject);
  child.once('exit', done);
});
process.exitCode = status ?? 1;
