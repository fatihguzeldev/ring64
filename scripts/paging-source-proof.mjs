import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { encode, hash, manifest, root } from './paging-support.mjs';

const families = {
  'src/embedding/exports.rs': ['load', 'load_for_write', 'store'],
  'src/embedding/exports/context.rs': [
    'segmented_load',
    'segmented_load_for_write',
    'segmented_store',
  ],
  'src/embedding/exports/vector.rs': ['vector_load', 'vector_store'],
  'src/embedding/exports/numeric.rs': ['load_mxcsr', 'store_mxcsr'],
  'src/embedding/exports/x87.rs': ['x87'],
  'src/embedding/exports/mmx.rs': ['mmx'],
  'src/embedding/exports/numeric_image.rs': ['numeric_image'],
  'src/embedding/exports/streaming.rs': ['masked_store', 'clflush'],
  'src/embedding/exports/protection.rs': ['protection'],
  'src/embedding/exports/far_control.rs': ['far_control'],
  'src/embedding/exports/software_events.rs': ['software_event'],
};
const files = [],
  wrappers = [],
  references = [];
for (const [path, names] of Object.entries(families)) {
  const bytes = await readFile(resolve(root, path)),
    source = bytes.toString();
  files.push({ path, sha256: hash(bytes) });
  for (const name of names)
    for (const observed of name === 'clflush' ? [false] : [false, true]) {
      const symbol = `core_${name}${observed ? '_observed' : ''}`;
      const anchor = `pub extern "C" fn ${symbol}(`,
        start = source.indexOf(anchor);
      const dispatch = `core_${name}_impl::<${name === 'clflush' ? 'false' : `${observed}, false`}>`;
      const call = source.indexOf(dispatch, start);
      if (start < 0 || call < start || call - start > 800)
        throw Error(symbol + ' no longer explicitly specializes PAGED=false');
      const signature = `fn core_${name}_impl<${name === 'clflush' ? '' : 'const OBSERVED: bool, '}const PAGED: bool>`;
      if (!source.includes(signature)) throw Error(name + ' lost const paging specialization');
      wrappers.push({
        export: symbol,
        path,
        line: source.slice(0, start).split('\n').length,
        dispatch,
        pagingIsCompileTimeFalse: true,
      });
    }
}
for (const [path, anchors] of Object.entries({
  'src/embedding/exports.rs': ['macro_rules! guest_access', 'macro_rules! guest_semantics'],
  'src/dbt/wasm/mod.rs': [
    'emit_profile(unit, observed, false)',
    'let observed = observed || paged;',
    'let access_reason = (segmented || paged).then',
  ],
  'src/dbt/wasm/boundary.rs': ['if self.paged {'],
  'src/embedding/exports/system_flags.rs': ['pub(super) fn boundary_observed(&self)'],
  'host/core.ts': ['if (this.isPaged)', '...PAGED_HELPERS', 'run(this.#statePointer, budget'],
  'src/memory/access.rs': [
    'fn preflight<const PHYSICAL: bool>',
    'self.preflight::<false>(address, width, Access::Read',
    'self.preflight::<true>(address, width, Access::Read',
  ],
  'src/x86/access.rs': ['impl GuestMemory for Image'],
  'src/embedding/exports/paging.rs': [
    'pub(super) fn paged_decode(',
    'fn encoding_current(',
    'pub extern "C" fn core_paged_debug_begin(',
  ],
  'src/x86/paging/walk.rs': [
    'walk_with::<false, false>',
    'walk_with::<true, FETCH>',
    'actual_walk::<true>',
  ],
})) {
  const bytes = await readFile(resolve(root, path)),
    source = bytes.toString();
  files.push({ path, sha256: hash(bytes) });
  for (const anchor of anchors) {
    const at = source.indexOf(anchor);
    if (at < 0) throw Error('missing source proof anchor: ' + anchor);
    references.push({ path, anchor, line: source.slice(0, at).split('\n').length });
  }
}
const evidence = {
  at: new Date().toISOString(),
  manifest: await manifest(root),
  files,
  wrappers,
  references,
  staticWarmFetchCostModel: {
    measured: false,
    conditions:
      'Successful stable required-byte decode, every relevant A bit already set, four-level4KiB mapping, no alias changes/faults/debug source. Derived from the source hashes above, not a runtime walk counter.',
    tableWordReadsForNBytes: '4 * (n*(n-1)/2 + 2*n)',
    examples: {
      twoByteInstruction: 20,
      threeByteInstruction: 36,
      fifteenByteInstruction: 540,
      threeByteLoadPlusTwoByteLoopPlusDataWalk: 60,
    },
    explanation:
      'Each required byte has one actual walk and a pure current-byte rewalk, plus a pure rewalk of every previously consumed byte. One ordinary4KiB data access adds four table-word reads. This excludes cold A/D paths, discovery/compilation, backing probes, data/code copies, allocator and event work.',
    ceiling:
      'Warm means warmed A/D metadata and reused artifact, not retained instruction/data translation; no instruction TLB is implemented or claimed.',
  },
  findings: [
    'All18 legacy memory/system families explicitly instantiate const PAGED=false, including all17 existing debug-observed variants. guest_access/guest_semantics choose Image directly in that compile-time branch; no mutable PG check is added to these successful guest accesses.',
    'The shared backing preflight also selects linear versus physical domain through const PHYSICAL, not a per-access mutable memory-model branch. Image retains the inherited linear canonical check; physical entry points instantiate the physical check.',
    'The existing artifact emission profile supplies paged=false for linear owners. Paged mode adds its own admission/finish helpers through one-time host instantiation binding selection, rather than changing the five-argument generated invocation.',
    'Inactive means paging absent here: existing debug-observed artifacts remain part of the strict inherited byte/import/helper-count proof; they are not excluded as active debug work.',
    'Source specialization and unchanged generated modules do not imply identical compiled core helper bodies, zero host snapshot overhead, or universal no-regression. Core struct/code layout and frontend/error checks changed and require matched timing controls.',
    'The paging bank stays an explicit projection. Only frozen vector14 source transport is appended to RunState; existing numeric/scalar/event/debug offsets are verified through the runtime descriptor by paging-observer.mjs.',
  ],
};
await mkdir(resolve(root, 'build/verification'), { recursive: true });
const output = resolve(root, 'build/verification/paging-source-proof.json');
await writeFile(output, encode(evidence));
console.log({
  output,
  helperExports: wrappers.length,
  families: Object.values(families).flat().length,
});
