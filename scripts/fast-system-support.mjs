import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { manifest } from './paging-support.mjs';

export { encode, freeze, hash, manifest, root } from './paging-support.mjs';
export const baseline = '/tmp/ring64-fast-baseline-8a7ee06';
export const baselineCommit = '8a7ee067bb9d036b4d19434458706490506ce44a';

export async function checkedBaseline(path = baseline) {
  const result = await manifest(resolve(path));
  if (
    result.source.commit !== baselineCommit ||
    result.coreSha256 !== 'b003b2071da14209e36f80346346186a9b9a3107fc9a93ece0fcef98749483af' ||
    result.hostSha256 !== '104c0b75ce648a37307519730750418675a482fe44a4175f0b45853cbed25475'
  )
    throw Error('fast-system baseline must be the exact preserved8a7ee06 build');
  return result;
}

export async function assertFastCandidate(path) {
  const { createCpu } = await import(pathToFileURL(resolve(path, 'build/host/index.js')));
  const compiler = await WebAssembly.compile(await readFile(resolve(path, 'build/ring64.wasm')));
  const cpu = await createCpu({
    compiler,
    memoryModel: 'ia32e-paged',
    memory: {
      backings: [{ id: 'probe', bytes: Uint8Array.of(0x82) }],
      mappings: [
        {
          base: 0n,
          backing: 'probe',
          offset: 0,
          length: 1,
          permissions: { read: true, write: false, execute: true },
        },
      ],
    },
    memoryLimits: { maxBackings: 1, maxMappings: 1, maxBackingBytes: 1 },
    entry: 0n,
    paging: { cr0: 0x80000033n, cr2: 0n, cr3: 0x1000n, cr4: 0x628n, efer: 0x500n },
    limits: {
      maxInstructions: 128,
      maxSourceBytes: 2048,
      maxArtifactBytes: 262144,
      maxCachedArtifacts: 32,
      maxCachedBytes: 4194304,
      maxTranslationsPerRun: 32,
    },
  });
  try {
    if (typeof cpu.readFastSystemState !== 'function')
      throw Error('current build lacks fast-system API; refusing stale-build performance evidence');
    const bank = cpu.readFastSystemState();
    if (Object.keys(bank).length !== 7 || Object.values(bank).some((value) => value !== 0n))
      throw Error('current fast-system default bank is incompatible');
  } finally {
    cpu.dispose();
  }
}
