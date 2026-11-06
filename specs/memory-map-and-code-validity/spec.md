# memory map and code validity

extend [initial execution](../initial-execution/spec.md) and its inherited instruction contracts with multiple private memory mappings, backing aliases, independent permissions and writable code. a running CPU can execute code written through a writable mapping, and retained code remains usable only while its source and mapping assumptions hold.

replace the fixed code/RAM roles and immutable-code assumption with the rules below. retain the imported 64-bit execution context, existing instruction forms, register/flag semantics, exact instruction accounting, checked scalar accesses and artifact ownership. these map addresses are the current flat linear address space under identity translation. canonical48 validation belongs to this context, not to backing offsets or a universal physical-address rule. guest paging, segmentation, other modes, MMIO/providers, shared memory and parallel vCPUs have separate contracts.

## backing and mapping inputs

separate copied byte storage from the guest addresses that expose it. a backing has a CPU-local string name, private owned bytes and an internal incarnation distinct from its name. a mapping exposes one bounded slice of a backing at a guest base with independent read/write/execute permissions. several mappings may expose the same backing bytes, including a writable alias of executable bytes.

use these public input shapes and export their types with the existing host types:

```ts
interface MemoryBackingInput {
  id: string;
  bytes: Uint8Array;
}

interface MemoryPermissions {
  read: boolean;
  write: boolean;
  execute: boolean;
}

interface MemoryMapping {
  base: bigint;
  backing: string;
  offset: number;
  length: number;
  permissions: MemoryPermissions;
}

interface MemoryLimits {
  maxBackingBytes: number;
  maxBackings: number;
  maxMappings: number;
}
```

`createCpu` retains `compiler` and the existing execution `limits`, and accepts exactly one initial-memory form:

- legacy `code` and `ram` spans: normalize them to private backings named `code` and `ram`, mapped RX and RW respectively, with initial RIP at `code.base`. retain their nonempty, disjoint, canonical, nonwrapping validation and input-copy behavior.
- `memory: { backings: MemoryBackingInput[], mappings: MemoryMapping[] }`, `entry: bigint` and `memoryLimits: MemoryLimits`: initialize the owned storage and complete mapping table together. `entry` is an exact raw u64 initial RIP; validate it as a fetch address only if execution reaches fetch. backing and mapping arrays may be empty.

the legacy form requires `code` and `ram` and forbids `memory` and `entry`. the mapped form requires `memory`, `entry` and `memoryLimits` and forbids `code` and `ram`. reject mixed or incomplete forms. the legacy form may supply the complete `memoryLimits` group; without it, its effective capacities are two backings, two mappings and the sum of the two initial byte lengths. a legacy caller that needs more capacity supplies the group. the new form always supplies the complete group, including for an empty layout. no memory-capacity setter is added.

backing names are nonempty strings with exact, case-sensitive equality; reject duplicates. copy input bytes and retain no mutable caller alias. each backing is nonempty and its length fits the wasm32 storage domain. names are references within one CPU, not shared-storage handles between CPUs. removing and recreating a name creates a new incarnation; old code dependencies cannot bind to it by name alone.

mapping bases are exact u64 bigints. offsets and lengths are integers in the unsigned wasm32 domain, with positive lengths. check `offset + length` in widened arithmetic and require it to fit within the referenced backing. every mapped guest span is nonwrapping and wholly canonical48, including a one-byte mapping ending at `0xffffffffffffffff`. guest intervals may be adjacent but must not overlap, even if they refer to the same backing. backing slices may overlap freely. input order does not select mapping precedence.

require every permission field to be a boolean; all eight combinations are admitted. a mapped no-access region produces a permission failure, while an absent region produces unmapped. execute permission does not imply read permission, and write permission does not imply read permission. these are private embedding permissions, not guest page-table bits.

all three memory capacities are explicit positive finite wasm32 integers. `maxBackingBytes` bounds the sum of owned backing lengths, counting aliases once; `maxBackings` bounds backing records and `maxMappings` bounds mapping records. removed unmapped backings release their logical byte/record capacity. aliases consume mapping capacity. actual allocator/browser limits may be lower; reject declared-capacity or reported allocation refusal before publishing a partial operation. storage locations and backing identities must not depend on a lossy guest-address-to-number conversion.

## idle host mutations

add three synchronous methods to `Cpu`:

```ts
addBacking(input: MemoryBackingInput): void;
removeBacking(id: string): void;
setMappings(mappings: MemoryMapping[]): void;
```

`addBacking` copies a new, initially unmapped backing; reject an existing name. `removeBacking` requires an existing backing with no current mappings. `setMappings` replaces the entire table atomically, using existing backings; it covers map, unmap, remap and protection changes. the empty table unmaps everything. independent successful host operations remain separate operations: a later rejected table replacement does not undo an earlier backing allocation.

check idle/live state before examining mutation inputs. preflight actual input counts and byte lengths against capacities before proportional capture or allocation. then snapshot accepted-size array entries, nested permissions and byte inputs, and revalidate current identities, counts, capacities and lifecycle before publication. input accessors may start a run or dispose the instance. validate the complete table, references and spans before replacing anything. malformed inputs, duplicate/unknown names, mapped backing removal and invalid spans throw `TypeError`; capacity/allocation refusals reported without an engine failure throw `RangeError`. these are host errors, not simulated guest access faults or `run` results. a rejected operation itself changes no backing bytes, mapping table, architectural state, cached owner or accounting. unexpected engine failures retain the failed-instance lifecycle.

host mutations, state imports, memory inspection and disposal remain forbidden while a run or its browser compilation is pending. retain existing failed/disposed/concurrent-operation behavior. this contract does not permit concurrent mutation during an awaited compilation.

`readMemory` and `writeMemory` use the current mappings and require R and W respectively. host writes do not bypass RX or execute-only permissions; patch through a writable mapping or change the table first. initialization through copied backing inputs needs no mapped write permission. host writes preflight their entire span before changing bytes and participate in code invalidation. returned byte/state/translation snapshots expose no mutable alias to owned storage or dependency metadata. preserve the existing empty host-copy behavior: zero bytes access no address and invalidate nothing.

## checked accesses and aliases

fetch obtains each required instruction byte through its current X mapping. ordinary data sources require R; stores require W. modifying read/modify/write operands require both R and W over the full operand before any backing read, with a write-intent diagnostic. masked-zero counts and identity results retain the required accesses from their instruction contracts.

preserve whole-span range and canonicality checks before mapping checks. after those checks, walk guest addresses in increasing order and report the first unmapped byte or mapping lacking the permissions required for that access. for RMW, either missing R or missing W is a permission failure reported with `access: 'write'`. retain the original operand start, full width, instruction PC and first failing guest address. an in-domain required-byte fetch failure reports that byte with width one and execute access. required instruction bytes never wrap: if the next required byte is beyond u64, retain the inherited address-range tuple with the instruction start, number of bytes requested so far and failing address `2^64`. these priorities are the Ring64 embedding policy.

an access may span adjacent mappings, backing slices or distinct backings. preflight the complete span before reading backing storage or committing any store byte. failed scalar stores change no bytes, code revisions or architectural state; failed reads and RMW preserve every incoming bank and actual flag bit. retain decode-before-data, target/stack access ordering, divide-error priority and completed-prefix behavior from the instruction contracts.

assemble reads in little-endian guest-byte order from the old backing contents. after successful preflight, commit a store in increasing guest-byte order. if different guest bytes of one operand alias the same backing byte, the last guest-address write to that byte wins. capture the complete old RMW operand before any store byte is committed. do not turn split accesses into partially committed scalar operations or treat logical adjacency as backing adjacency.

## fetch, discovery and validity dependencies

discovery uses executable mappings rather than one `codeBase/codeLen` interval. admit an instruction whose required bytes cross adjacent executable mappings or backings, including execute-only mappings. discover supported static successors in other executable regions within the existing limits. gaps, disabled execute permission and unimplemented bytes beyond the reached instruction remain frontiers, not early failures of a valid prefix. preserve the bounded diagnostic probe before resource admission.

the distinct-source-byte budget counts guest fetch addresses, including distinct aliases of the same backing slice; deduplicating backing offsets does not reduce this budget. instruction entries still identify exact guest PCs. equal backing bytes at different PCs do not imply equal decoded RIP-relative addresses or branch targets.

retain the source facts needed to validate each artifact: guest fetch intervals and mapping/execute assumptions, their backing incarnations and backing-offset intervals, plus any other map/content facts used for specialization. counts alone are insufficient. dependencies include any negative fetch/decode fact materialized as an exit; a frontier merely dispatched for a fresh reached probe need not become a baked diagnostic. capture a coherent source/dependency snapshot before browser compilation and publish only while that snapshot, CPU owner and fixed execution context remain valid.

a write through any mapping or host API affects dependencies by backing incarnation and offset, regardless of which alias supplied the destination address or its current X permission. mapping changes affect dependencies by the guest ranges and assumptions they replace. removing X, replacing a source backing at the same PC, or remapping a source interval cannot leave an old installed entry executable. data helpers must consult current mappings; a lowered direct-access shortcut must either validate or invalidate every assumption it embeds.

invalidate the complete affected artifact owner and all entry bindings still owned by it. preserve overlapping entries installed by a newer, unaffected owner. invalidation, ordinary eviction, replacement and disposal must agree on ownership and resource accounting. no uncapped dependency registry may outlive evicted owners. cached bytes keep their existing generated-Wasm-byte meaning; dependency bookkeeping must be bounded by the declared discovery/cache/map capacities and measured separately.

unrelated mappings and backing offsets do not make source facts stale. a table replacement retaining identical mappings, even in a different input order, preserves reusable owners. ordinary stores outside all source/specialization dependencies must not globally flush code merely because a backing also contains executable bytes. coarse revision tracking may trigger revalidation, but cannot force every such store to exit or discard otherwise valid owners. identity/revision reuse or wrap must never resurrect stale code; use fresh incarnations or safe retirement before an identity can collide with a live dependency. identity exhaustion does not add a guest-store failure: internal retirement/rotation must retain complete instruction semantics and prevent reuse of every expired token.

## guest code writes and instruction boundaries

successful writes are visible through every backing alias at the next reached instruction boundary. this immediate visibility is Ring64's sequential private embedding policy; it does not claim to reproduce every Intel prefetch/cache behavior or add hardware serialization instructions.

when a store affects the current artifact's dependencies, complete the entire writing instruction before leaving that artifact. commit its bytes, specified flags, register effects, actual next RIP and one retirement exactly once. this includes arithmetic RMW, zero-count writes, SETcc, PUSH and CALL. an exit directly from the memory helper must not skip flags, RSP or transfer completion. no instruction from a stale decoded suffix may run afterward, even when the write used a non-executable alias or changed an already-executed source byte.

at the resulting boundary, budget wins over stop, then reached fetch/decode/resource checks apply. a code write is not an extra retired instruction or public yield reason. with remaining work, internal dispatch or an equivalent validated route obtains code for the current bytes and permissions. a fresh valid entry can be reused; otherwise compile under the ordinary attempt/cache limits. a later resource refusal or fetch/coverage failure preserves the completed writing instruction and its effects.

a write affecting only other artifacts may leave an unaffected current artifact running. before any later cache entry is used, and before public cache inspection/accounting is returned, affected owners must be retired or revalidated. host writes and mapping replacement complete their invalidation effects before returning. retained middle entries, overlapping ownership and evicted/reinstalled artifacts obey the same validity rules; entering a suffix cannot bypass them.

## verification

`npm run check` is the implementation acceptance command. cover the memory owner, decoder/discovery dependencies, generated-Wasm write completion, cache/lifecycle behavior and shared public Node/Chrome execution. use the existing code organization and one authoritative access/ownership path. author expected bytes, address arithmetic and state changes independently of mapping and invalidation code.

compare all sixteen banks, complete actual flags where preserved, exact RIP/reasons/retired/remaining counts, full backing-visible aliases, guarded bytes and complete fault records. check cache entries, owners, generated bytes and resource counts, including removal of stale owners without erasing newer bindings. any exposed nested dependency metadata must be a deep snapshot. migrate tests of the old fixed-span restriction to the generalized contracts while retaining legacy-form validation and all still-applicable failures.

### literal distinctions

use imported64 state with bank `i` initially `0x1122334400000000+i`, RAX=`0x1122334455667788`, flags=`0x8d7` and explicit sufficient execution/memory limits. each row is an independent CPU/layout. load the stated code bytes into a private backing; additional backing guard bytes start at `a5`. unlisted banks, flags and backing bytes remain unchanged. successful packets with budget equal to the stated retirements return budget/remaining zero and no fault.

| setup and code                                                                                                                                                                                                            | required result                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X-only map at `0x1000` holds `b878563412`, budget one                                                                                                                                                                     | RAX=`0x12345678`, RIP=`0x1005`, retired one. host/data reads of those X-only bytes fail with read/permission.                                                                                                                                                                          |
| X-only maps at `0x1000` and `0x1002` hold `b878` and `563412` in separate backings, budget one                                                                                                                            | the same successful MOV. removing X from the second map instead gives fetch-fault at required byte `0x1002`, width one, with no retirement or bank/flag changes.                                                                                                                       |
| RX map at `0x1000` holds `8903`; RBX=`0x4000`, RAX=`0x44332211`. adjacent RW maps `0x4000..4001` and `0x4002..4003` both expose offsets `0..1` of one two-byte backing, budget one                                        | backing bytes `33 44`; a four-byte read at `0x4000` returns `33 44 33 44`; RIP=`0x1002`, retired one.                                                                                                                                                                                  |
| RWX at `0x1000` holds `c60500000000bbb801000000`, budget two                                                                                                                                                              | first instruction changes the next B8 opcode to BB. RBX=1, original RAX preserved, RIP=`0x100c`, retired two. the first store's full instruction length is seven.                                                                                                                      |
| RX at `0x1000` and RW at `0x4000` alias the same backing holding `c603bbb801000000`; RBX=`0x4003`, budget two                                                                                                             | the alias store changes code at `0x1003` to BB. RBX=1, original RAX preserved, RIP=`0x1008`, retired two.                                                                                                                                                                              |
| the same backing slice holding `488d0500000000` is RX-mapped at `0x1000` and `0x2000`; enter each PC independently with budget one                                                                                        | RAX=`0x1007` or `0x2007` respectively, with corresponding RIP. cache reuse must retain the guest-PC-relative meaning.                                                                                                                                                                  |
| RX mapping at `0x1000` covers a 64-byte backing whose first eight bytes are `fe034883e90175f8`; RW at `0x4000` aliases backing offset 32, length one. RBX=`0x4000`, RCX=1000, backing byte 32 initially zero, budget 3000 | byte 32 becomes `e8`, RCX=0, flags=`0x46`, RIP=`0x1008`, retired 3000. nativeEntries=1 and dispatches=0; a retained repeat with the stated input state/data restored compiles no new unit. code and data share an executable backing range, but writes never touch this unit's source. |
| RWX at `0x1000` holds `fe03b801000000`; RBX=`0x1002`, budget two                                                                                                                                                          | INC changes the next B8 opcode to B9. RCX=1, original RAX preserved, flags=`0x83`, RIP=`0x1007`, retired two.                                                                                                                                                                          |
| RWX at `0x1000` covers a 32-byte backing beginning `e803000000a5a5a5b901000000`, followed by `a5` guards; RSP=`0x1010`, budget two                                                                                        | CALL targets `0x1008` and pushes return word `0x1005` over its target bytes. the changed target executes ADD EAX,`0x10`. RSP=`0x1008`, RAX=`0x55667798`, original RCX preserved, flags=`0x2`, RIP=`0x100d`, retired two.                                                               |

### mutation, failure and reuse cases

- exercise all permission masks separately for fetch, ordinary read/store, RMW and host copies. W-only accepts a store but rejects RMW before a backing read with a write/permission tuple. X-only fetch works and data read fails. no-access differs from unmapped. check every scalar width across adjacent backings, permission changes, gaps, high addresses, the last u64 byte, canonical holes and full-span overflow; failed split stores leave earlier writable bytes and validity state unchanged.
- make an instruction span mappings and backing slices, change an opcode, ModR/M, displacement or immediate through another alias, then enter every retained affected suffix. repeat at a noncontiguous direct target and with a RIP-relative operand. test host patch, same-PC remap to different backing, X revocation/restoration, unmap/remap, backing removal/recreation under the same name and equal byte contents under distinct incarnations.
- invalidate an older artifact while a newer unaffected owner supplies an overlapping middle entry. check that only stale bindings disappear; vary ordinary eviction order, empty-cache limits and reinstallation. change an unrelated map or data offset, and repeat an identical reordered mapping table, requiring unaffected code to remain reusable. test bounded identity/revision exhaustion through internal validity cases without a live-token collision.
- run each self-modifying literal with budget one, a stop at its next PC, enough budget to execute the changed instruction, and a translation/cache limit that refuses the changed suffix. budget/stop/resource exits keep the completed store, flags and full state. patch the writing instruction itself and a previously executed predecessor as well as its suffix. patch through RMW and stack writes, checking flags, old-source aliases, RSP and CALL's actual committed target before invalidation dispatch.
- for the INC literal, budget one, stop at `0x1002` and a fresh CPU with `maxTranslationsPerRun: 1` must retain flags=`0x83` after its completed write. for the CALL literal, the corresponding boundary is its target `0x1008`, with RSP=`0x1008`, flags=`0x8d7` and pushed return word `0x1005`. use sufficient other limits and native multi-entry fixtures so stale suffix/target execution would otherwise be possible. budget/stop results already exclude an invalidated sole owner from public cache bytes/counts. in a separate CALL case with budget three and sufficient translation capacity (at least two attempts), the packet reaches new bytes `00 00` at `0x100d` and returns a write/unmapped data fault at `0x55667798`, width one, retired two and remaining one; the old A5 decode frontier is obsolete.
- attempt an invalid or over-capacity backing/table mutation and require no operation-owned change. remove a mapped backing, refer to an unknown name, use duplicate names, overlap guest ranges, exceed backing bounds, and reuse names across separate CPUs. check counted-once backing bytes versus alias mapping capacity. after successful removal, reclaim logical capacity. preserve caller/returned-buffer isolation and names such as `__proto__` as ordinary exact identifiers.
- reject over-capacity input counts/lengths before proportional copying, including constructor inputs and a large table with a small mapping cap. allocate additional backings far enough to grow or relocate storage, then verify existing aliases, architectural snapshots and retained code still use the correct bytes; no cached host buffer view or backing pointer may become a stale shortcut.
- delay browser compilation and attempt every forbidden host mutation, import, observation and disposal. include input accessors that start a pending run or dispose the CPU; final validation must not publish a replacement into the wrong lifecycle. changed caller buffers must not alter the owned source snapshot. internal validity tests must reject an obsolete compilation/dependency token at publication. rejected host operations and later budget/stop/success/data/target/divide/resource exits retain only their own diagnostics.

## performance

compare existing scalar, logical/conditional, addressing, memory RMW, stack/transfer, multiply/divide and short-resume workloads before/after with identical guest bytes, inputs, limits, checked outputs and observation work. retain the legacy two-span case as a normalization/control case. record first completion, translation/browser compilation/instantiation, early/later retained execution, forced code-cache churn, generated/cache bytes, dependency bookkeeping, native entries and dispatches. same-backing unrelated data stores and stable large mapping tables need explicit controls; unchanged code should not pay a global flush or unconditional public state publication on each store.

characterize multiple maps, split accesses, sparse executable targets, permissions, RW/RX aliases, host patches, same-PC remapping and self-modifying loops separately. compare source-range invalidation with unaffected-owner reuse and repeatedly patched code under small cache/translation capacities. include mapping-count growth and bounded refusal behavior; no prescribed interval tree, page size, generation scheme, helper ABI or final translation geometry is required.

keep balanced repeated samples, independent expected outputs, raw timings, environment/artifact identities and first/early/later windows. use meaningful intervals above timer quantization; new behavior has no executable old baseline. check guards, complete state and exact exits/counts outside timing. resolve repeated regressions beyond observed variation, with same-core/matched-host controls before attributing small resume differences. first completion in a shared browser is not independent cold evidence; logical invalidation/accounting does not promise immediate browser-native-code reclamation.

## references

- [intel SDM volume 3A, 253668-093US](https://cdrdv2.intel.com/v1/dl/getContent/671190), §11.1.3 pp. 11-5–6 and §14.6 p. 14-18: self-/cross-modifying code and model-dependent visibility. [manual collection](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html). the next-boundary visibility and checked-access policies above are Ring64 embedding contracts.
- [WebAssembly JavaScript interface](https://www.w3.org/TR/wasm-js-api-2/#dom-webassembly-compile): `WebAssembly.compile` copies its source bytes and completes asynchronously. immutable Wasm bytes do not establish that the guest source/dependencies used to produce them are still current.
