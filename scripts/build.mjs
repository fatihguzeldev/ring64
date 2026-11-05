import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, rm } from 'node:fs/promises';

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('cargo', ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown']);
await Promise.all(
  ['build/host', 'build/tests'].map((path) => rm(path, { recursive: true, force: true })),
);
run('node', ['node_modules/typescript/bin/tsc']);
await mkdir('build', { recursive: true });
await copyFile('target/wasm32-unknown-unknown/release/ring64.wasm', 'build/ring64.wasm');
