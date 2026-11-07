# mode context and decoding

extend [memory map and code validity](../memory-map-and-code-validity/spec.md) and its inherited instruction contracts with imported execution contexts. execute the existing scalar integer and near-control families under real-address, virtual-8086, protected 16/32-bit, compatibility 16/32-bit and 64-bit rules. include their operand, address, stack, segment and instruction-pointer behavior.

these are imported execution views of already-loaded state. guest descriptor loads, far/privilege transfers, reset, control-register/MSR writes, paging and exception/interrupt delivery have separate contracts. the current arithmetic `State.flags` projection remains unchanged; the context supplies mode facts such as virtual-8086 operation. this does not import a complete CR0/EFER/RFLAGS/descriptor-table image.

## context inputs and observation

export these types with the host API:

```ts
type SegmentName = 'cs' | 'ss' | 'ds' | 'es' | 'fs' | 'gs';

type SegmentType =
  | 'code'
  | 'readable-code'
  | 'read-only'
  | 'read-write'
  | 'expand-down-read-only'
  | 'expand-down-read-write';

interface LoadedSegment {
  base: bigint;
  limit: number;
  default32: boolean;
  usable: boolean;
  type: SegmentType;
}

type ExecutionContext =
  | { mode: 'long64'; fsBase: bigint; gsBase: bigint }
  | {
      mode: 'real' | 'virtual8086' | 'protected' | 'compatibility';
      segments: Record<SegmentName, LoadedSegment>;
    };
```

add optional `context` to both `createCpu` memory forms. omission means `{ mode: 'long64', fsBase: 0n, gsBase: 0n }`. add synchronous idle `readContext(): ExecutionContext` and `setContext(context: ExecutionContext): void`. retain `State`'s `registers`, `flags` and `rip` fields and existing state-import behavior. importing state alone preserves the context; importing context alone preserves every raw register bank, flag and RIP bit. separate successful host operations remain separate operations.

capture the complete selected input shape before asynchronous construction or mutation publication. bases are exact bigints, limits are expanded byte limits in `0..0xffffffff`, `default32` and `usable` are booleans, and mode/type tags use the stated values. segmented bases fit u32. long64 FS/GS bases are canonical48 unsigned u64 values. no descriptor granularity, table lookup or selector-to-base reconstruction occurs during import. selectors, privilege/load-time checks and present bits are outside this execution view.

protected/compatibility CS is usable code; SS is usable writable data, including expand-down data. other segments may be usable code/data or unusable. a code segment is readable only for `readable-code`; data segments are inherently readable. `default32` represents CS.D for code defaults, SS.B for the implicit stack pointer, and the upper-bound selection for expand-down data. an empty expand-down range is a valid imported cache whose accesses fault.

real contexts retain their imported bases, limits, types and D/B facts, including usable protected-mode caches retained after PE was cleared. CS is usable with type `code`, `readable-code` or `read-write`; SS is usable writable data. the reset-style CS cache may have data type `read-write` despite its instruction-fetch role. do not replace a retained base with a selector-derived value or force D/B to zero merely because the mode is real. ordinary reset-style and selector-loaded real caches are expressible through these facts; A20 is enabled in this private profile. virtual-8086 imports use six usable expand-up `read-write` caches, including CS, with 64 KiB limits, `default32: false` and paragraph-aligned bases at most `0xffff0`. this represents its synthetic loaded state; base zero is usable.

malformed or incomplete contexts throw `TypeError` before any operation-owned change. check idle/live state before reading mutation inputs and again after their getters have run. getters may run, inspect, mutate or dispose the CPU; revalidate against the resulting lifecycle before publication. context mutation/inspection remains forbidden while execution or browser compilation is pending, or after failure/disposal. unexpected engine failures retain the failed-instance lifecycle. return deep context snapshots, including every segment record, with no mutable caller alias.

compare against the current context only after capture and the final lifecycle check; preserve the raw State that exists at publication, including successful nested host operations. an equal normalized context, independent of input property order or object identity, is a no-op for code reuse. a changed context atomically retires all retained owners and their entry/source bookkeeping before returning; preserving unrelated owners across context changes is not required. a rejected import itself changes no bytes, raw state, context, owners or accounting; effects of successful reentrant operations remain committed. context import does not rewrite mappings or backing bytes.

## sizes, registers and instruction coverage

CS.D selects the ordinary operand/address defaults outside long64: false means 16/16, true means 32/32. `66` selects the other ordinary operand width; `67` selects the other address width. in long64, ordinary defaults are operand32/address64; `66` selects operand16, REX.W selects operand64 and takes precedence over `66`, and `67` selects address32. address16 is unavailable in long64. byte operations retain width8.

implicit stack addressing is independent: long64 uses RSP64; otherwise SS.B selects SP16 or ESP32. `67` changes an explicit memory operand's addressing, not this implicit stack size. stack-slot width follows the instruction's operand rules, not address size or SS.B. segment overrides do not redirect implicit stack accesses away from SS; they apply only to explicit memory operands.

carry all currently admitted MOV/extension, arithmetic/logical/conditional, shifts/rotates/bit, multiply/divide and near-control forms into their legal mode/width combinations. include legacy `40..4f` register INC/DEC, 16/32-bit near transfers and stack slots, and long64 16-bit PUSH/POP. FF memory transfers, memory PUSH/POP, ENTER/LEAVE, LOOP/JCXZ, strings, selector loads and additional opcode families remain separate coverage. complete ordinary prefix handling is part of this work; a prefix parser with fixed `[66][REX]` ordering is insufficient.

support `66`, `67` and segment overrides in legal orders for these forms. repeated size overrides mean presence, not repeated toggling. outside long64, the last segment override selects the segment. in long64, only FS/GS overrides participate in that selection: ignored CS/DS/ES/SS prefixes do not cancel an earlier FS/GS selection. they still cancel an earlier REX as legacy prefixes. in long64, the effective REX must precede the opcode after legacy prefixes; a later legacy prefix cancels an earlier REX, and the last applicable REX supplies its bits. retain AH/CH/DH/BH versus SPL/BPL/SIL/DIL selection and R8..R15 extension only where REX applies. LOCK and REP-group execution remain outside coverage. preserve the fifteen-byte limit and required-byte probing without fetching operand data during decode.

long64 near CALL/JMP/Jcc, including register-indirect CALL/JMP and RET, use 64-bit targets and return addresses; `66` does not select a 16-bit near transfer or rel16 encoding. near relative displacements remain rel8 or rel32 as encoded. PUSH/POP instead default to operand64 and admit `66` operand16; REX.W takes precedence. outside long64, operand size selects 16/32-bit near targets, return words and rel16/rel32 encodings; short JMP/Jcc still encode rel8 but use the instruction's effective operand size for a taken target.

mode-specific opcode collisions need explicit outcomes. outside long64, `40..4f` are INC/DEC and `63` is not MOVSXD: protected/compatibility ARPL remains valid but unsupported, while its real/v8086 encoding is invalid. legacy PUSHA/POPA remain unsupported and are invalid in long64. unimplemented LES/LDS, BOUND, VEX/EVEX and other families must not be decoded as a different mode's instruction or declared invalid merely from an unfamiliar prefix.

outside long64, encodings access the eight legacy GPRs. inactive R8..R15 banks remain unchanged. for deterministic embedding behavior, every non-long64 register write preserves the incoming bits above its architectural destination width, including bits 63:32 on a 32-bit write. context changes also preserve those bits. Intel leaves upper32 undefined in 32-bit modes; this preservation is a Ring64 policy, not a hardware guarantee. retain long64 zero-extension of 32-bit destinations and all inherited defined/preserved/undefined flag rules.

## offsets, segments and checked linear accesses

`State.rip`, mapped-constructor `entry`, `run.stop` and `UnitMetadata.entries` identify logical instruction offsets in the current CS. backing/mapping bases, `readMemory`, `writeMemory` and memory-fault addresses remain linear. the legacy constructor still derives its initial raw RIP from `code.base`; use the mapped form's explicit entry when arranging a nonzero CS base. do not silently reinterpret span bases as offsets or stop addresses as linear addresses.

outside long64, reached fetch uses full EIP32 even when CS.D is zero. imported raw RIP above u32 remains inspectable and can satisfy budget/stop before fetch; a reached fetch outside CS's offset range produces a segment fault. sequential completion advances modulo 2^32. near16 transfers truncate a taken target to 16 bits; near32 transfers use 32 bits. an untaken conditional transfer follows the sequential EIP32 path. long64 retains RIP64 arithmetic. required bytes of one instruction cannot wrap its offset domain: a completed final byte may precede wrapped next IP, but an additional required byte faults. retain the inherited long64 beyond-u64 fetch tuple.

implement the complete 16-bit ModR/M address table and 32-bit ModR/M/SIB forms, including their displacement-only cases, signed displacements and base/index rules. form and truncate the starting effective offset at address size. long64 address32 retains IP-relative `mod=00,rm=101`: compute next-IP plus displacement, then truncate/zero-extend to 32 bits. the corresponding legacy address32 form is absolute disp32. moffs consumes address-size bytes independently of data width.

default DS/SS selection follows the base addressing form, including BP-based 16-bit forms and EBP/ESP-based 32-bit forms; an index alone does not select SS. in long64, actual RBP/RSP (and EBP/ESP under address32) select SS; their R13/R12 extensions select DS, so do not infer the segment from only the low register-encoding bits. outside long64 the effective segment override selects the loaded cache. in long64 CS/DS/ES/SS overrides are ignored, including their effect on fault classification; FS/GS overrides select their bases. retain the selected segment with reached diagnostics rather than reconstructing it later from potentially changed bytes.

LEA returns the effective offset, narrowed to destination width. it does not add a segment base, require a usable segment, check its bounds or touch data memory. memory bit operations apply their signed register-index word adjustment in the address-size offset domain before segment translation; truncating after adding a segment base is incorrect.

for non-long64 accesses, check usability, access type and the complete segment-offset span before any backing access. CS fetch is permitted through the imported real reset-style or virtual-8086 `read-write` cache; the protected/compatibility code-type requirement does not apply to these synthetic caches. CS.default32 still supplies code defaults according to its register role. protected/compatibility code is nonwritable and readable only when marked readable; data writes require writable data. real code may be written, while unreadable code reads and read-only data writes retain their cached restrictions. expand-up spans require every byte at or below the effective limit; expand-down spans require every byte above the limit and at or below `default32 ? 0xffffffff : 0xffff`. address16 truncates the starting offset, not the whole operand span. a word beginning at offset `ffff` can therefore be valid with a sufficiently large expand-up segment.

use widened arithmetic for all segment-span checks. Ring64 consistently rejects a span beyond the imported segment's upper bound, including a 4 GiB limit; Intel documents implementation-dependent behavior at that maximum limit. only after segment preflight, form the initial linear address as `(base + offset) mod 2^32`. real contexts do not apply an automatic 20-bit mask. for this checked embedding, the complete linear operand span must then fit the 32-bit linear domain: reject a crossing span with a linear address-range fault, failing address `2^32`, before mapping checks. do not fetch backing bytes above 4 GiB or silently wrap operand fragments to zero. this is an explicit private access policy, not a universal Intel boundary claim. required-byte fetches translate each requested offset separately.

in long64, CS/DS/ES/SS bases and runtime segment bounds/attributes are ignored. FS/GS add their full bases after offset-size truncation; form the sum modulo 2^64, then apply the inherited canonical48/full-span checks. do not reject a raw offset before forming its final linear address or truncate the final FS/GS linear address to address32. retain mapping permission checks, split/alias ordering and scalar failure atomicity after translation.

ordinary sources require segment read permission and map R; stores require segment write permission and map W; modifying RMW requires both at both layers before reading backing bytes, with a write-intent diagnostic. masked-zero counts, identity writes and false CMOV memory sources retain their inherited accesses. host memory copies use linear mappings directly and do not consult segment caches.

## faults and transfer completion

add `reason: 'segment-fault'` with a mutually exclusive `segmentFault` record:

```ts
interface SegmentFault {
  instructionPc: bigint;
  segment: SegmentName;
  offset: bigint;
  width: number;
  access: 'read' | 'write' | 'execute';
  cause: 'unusable' | 'type' | 'limit';
  failingOffset: bigint;
}
```

report usability before type before full-span bounds; then linear domain/canonical checks, then the inherited ascending linear mapping/permission checks. for RMW, segment read or write denial reports write intent. `offset` is the translated operand's adjusted starting segment offset, not its pre-adjustment GPR value. unusable/type failures report that start; bounds failures report the first invalid offset. a required-byte code-segment fault reports that byte with width one. instructionPc remains the current instruction's logical offset.

retain the existing linear `fault` tuple fields and reasons, with `instructionPc` now using the logical convention. add the selected `segment` to reached fetch/data/target fault records; preserve its DS/SS/FS/GS meaning even when bases are zero. this keeps the future #GP/#SS distinction available without delivering a handler or inventing descriptor-load faults. a noncanonical long64 RBP/RSP-based access retains SS, an FS/GS override retains FS/GS, and ignored DS/SS overrides do not change that selection. no exit returns both fault records or a stale diagnostic from a prior access/run.

fetch/probe checks code offset and CS bounds before X mapping access. unsupported/invalid bytes in an unreached successor are frontiers. near target checks use the computed offset and CS limit, not the target's linear mapped/X status. an out-of-limit near target returns segment-fault with segment `cs`, offset and failingOffset equal to the computed target, width one, execute access and cause `limit`; this checks one target point without fetching its opcode. inherited noncanonical long64 target faults retain their existing width-zero tuple. validate only a taken target. retain inherited CALL target-before-stack and RET stack-read-before-target ordering as embedding policy; a failed transfer changes no stack bytes, pointer or retirement. mapping/X validation at a successfully committed target remains a next-boundary fetch, after budget and stop.

stack-pointer arithmetic wraps at implicit stack size while slot width remains independent. preserve unrelated upper pointer-bank bits under the register policy. PUSH captures an incoming aliased source before decrement. POP increments the selected stack pointer before writing an aliased destination view; partial SP/ESP writes merge into the correctly updated bank. RET cleanup adds its unsigned immediate at stack-pointer size. a successful stack/code write completes the entire instruction, including actual logical target, pointer/register/flags and one retirement, before code invalidation dispatch; retained target routing cannot execute stale bytes.

## source validity and context changes

discovery and lowering consume one coherent context snapshot. retain actual translated linear fetch ranges and backing-offset dependencies for every admitted instruction, alongside logical entry PCs and distinct logical-source-byte accounting. source bytes at a nonzero CS base cannot be registered as `instruction.pc + byteOffset` linear addresses. a source interval crossing the linear32 boundary may require separate linear ranges; its logical source-byte budget is unchanged.

PC equality alone does not establish reuse across contexts. meaningful context imports retire all owners, including middle entries and overlapping bindings, and detach their source registry. compare the captured context/owner and source validity at asynchronous publication. pending compilation still forbids public mutation; internal tests must reject obsolete context tokens rather than publishing into a replacement context. context identity reuse must not resurrect expired artifacts. no unbounded old-context/source registry may outlive eviction or disposal.

all prior mapping/alias invalidation rules remain. a host write or guest store through any linear alias invalidates the correct logical entries, including code reached through a nonzero CS base. changes to in-memory descriptor-shaped bytes do not change already-imported segment caches. only explicit host context import changes these execution facts in this spec.

## verification

`npm run check` is the implementation acceptance command. use the existing Rust memory/decode/discovery/lowering tests and shared public Node/Chrome suite. keep one authoritative size/segment/access path; independently author expected bytes, offset arithmetic and state changes. compare all sixteen banks, defined/preserved flags, exact logical RIP, bytes/guards, complete fault records, retired/remaining counts and owner/resource lifetime. update expected snapshots for the added fault segment field; retain the three-field State API.

### literal distinctions

unless overridden, use bank `i`=`0x1122334400000000+i`, RAX=`0x1122334455667788`, flags=`0x8d7`, logical RIP=`0x1000`, sufficient explicit limits and independently guarded mappings. non-long64 contexts have usable flat expand-up caches with limits `ffffffff`; CS.D and SS.B are stated per row. each row is independent. table addresses, register values and flags are hexadecimal; budgets and retirement counts are decimal. unlisted banks and bytes remain unchanged, and flags follow their defined/preserved masks unless an exact word is stated. budget equal to retirements returns budget/remaining zero with neither fault record.

| setup and bytes                                                                                                                                                       | required result                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `40b878563412`, budget one; long64 versus protected CS.D=1                                                                                                            | long64: RAX=`12345678`, RIP=`1006`, flags unchanged. protected: INC EAX, RAX=`1122334455667789`, RIP=`1001`, flags=`3`.                                                                                          |
| long64, RIP=`ffff800000001000`, FS.base=`100000000`; `67648b0500000000`; four bytes `78563412` at linear `100001008`, budget one                                      | RAX=`12345678`, RIP=`ffff800000001008`. the low EA is `1008`; neither absolute disp32 nor a final-linear32 truncation is allowed. replacing 8B with 8D returns RAX=`1008` without data access.                   |
| long64, FS.base=`10000`, RAX=`2000`; `643e8b00` and separately `3e648b00`; dword `12345678` at linear `12000`, distinct guard at `2000`, budget one                   | both loads return RAX=`12345678`, RIP=`1004`. the ignored DS prefix cannot cancel FS; a reached memory failure retains segment `fs`.                                                                             |
| virtual8086, all six caches usable `read-write`, base0/limit`ffff`/default16; `b83412`, budget one                                                                    | RAX=`1122334455661234`, RIP=`1003`, flags unchanged. CS fetch is legal through the synthetic data-type cache.                                                                                                    |
| protected CS.D=1; `678b00`; BX=`ffff`, SI=0, DS.base=`10000`, DS.limit=`ffffffff`; bytes `78563412` at linear `1ffff`, budget one                                     | RAX=`1122334412345678`, RIP=`1003`. with DS.limit=`ffff`, instead segment-fault at offset `ffff`, width4/read, first failing offset `10000`, with no retirement or register/flag change.                         |
| protected CS.D=1, SS.B=1, SS.base=`20000`, ESP=`10010`, EAX=`11223344`; `6750`, budget one                                                                            | ESP=`1000c`, stack bytes `44332211` at linear `3000c`, RIP=`1002`. `6650` instead uses slot2 and ESP=`1000e`, bytes `4433`.                                                                                      |
| protected CS.D=0, CS.base=`20000`, CS.limit=`1ffff`; `66e9faef0000` at logical `1000`, `f5` at logical `10000`, budget two                                            | RIP=`10001`, flags=`8d6`, two retirements. fetch source ranges include linear `21000` and `30000`; stop at logical `10000` with sufficient budget stops after the jump.                                          |
| protected CS.D=1, RIP=`10000`, `667500`, budget one                                                                                                                   | incoming flags2 takes the branch to logical3; incoming flags42 leaves the branch untaken and advances to `10003`.                                                                                                |
| real, CS.type=`read-write`, CS.base=`ffff0000`, CS.limit=`ffff`, CS.D=0, `66b878563412` at linear `fffffff0`, RIP=`fff0`, budget one                                  | RAX=`1122334412345678`, RIP=`fff6`; imported hidden CS base is retained.                                                                                                                                         |
| real normal caches, DS.base=`ffff0`, DS.limit=`ffff`, CS.D=0; `a0ffff`; byte7B at linear `10ffef`, distinct guard at `ffef`, budget one                               | RAX=`112233445566777b`, RIP=`1003`; no A20-style 20-bit truncation.                                                                                                                                              |
| protected CS.D=1, DS.base=`fffffff0`, DS.limit=`ffffffff`; `8b03`, EBX=`20`, four bytes `78563412` at linear10, budget one                                            | RAX=`1122334412345678`, RIP=`1002`. with DS.base=`fffffffe`, EBX=0 instead gives the private linear32 address-range fault at start `fffffffe`, width4/read, failing `100000000`, before any mapped byte is read. |
| protected CS.D=1; `670fa308`; BX=2, SI=0, ECX=`ffffffff`, DS.base=`10000`, DS.limit=`1ffff`; word32=`80000000` at linear `1fffe` and zero guard at `fffe`, budget one | BT reads offset `fffe` after signed word adjustment in address16, RIP=`1004`; CF=1 and the inherited preserved ZF remains. all banks/bytes unchanged.                                                            |
| long64, RSP=`4010`, RW stack at `4008..400f`; `66e801000000`, target offset `1007`                                                                                    | CALL length6, return word `1006`, eight-byte slot and RSP=`4008`; with budget one RIP=`1007`. `66e901000000` jumps to `1007` without stack access.                                                               |

also test protected CS.D=1/CS.limit=`10ff`: `e8fb000000` at offset `1000` has target `1100` and returns the exact target segment-fault above, without touching even an unmapped stack. `c3` instead reads a four-byte return word `00110000` from SS:ESP first: an unreadable stack faults before target validation; with readable stack the same CS-limit fault preserves ESP and all bytes. both instructions remain unretired.

also require public tests for every admitted mode/CS.D/SS.B combination and rejection of inconsistent profiles, all 16-bit address forms, displacement/SIB exceptions, all segment overrides and REX byte-register boundaries. distinguish default SS from index-only BP forms and R12/R13 bases; verify that FS/GS prefixes on PUSH/POP/CALL/RET do not redirect their implicit SS accesses; test ignored long64 DS/SS overrides, FS/GS with address32, unusable/read-only/code/expand-down segments, empty ranges, linear32 boundaries, both canonical halves and partial pointer aliases. include raw out-of-domain imported RIP, complete versus incomplete final-byte instructions, false CMOV and zero-count RMW faults, divide-source versus divide-error priority, and taken/untaken target boundaries.

repeat source/cache tests at nonzero CS bases, across linear fetch wrap, with RW/RX aliases, FS/GS/context changes, retained middle entries, older/newer overlapping owners, same-context no-op, malformed/reentrant import, pending compilation, obsolete publication, repaired faults, disposal and deep returned snapshots. without completed reentrant changes, rejected imports must preserve a warm artifact's reuse. successful context changes preserve raw State but prevent every old entry from executing under replacement facts.

## performance

compare the existing imported64 scalar, memory/RMW, stack, multiply/divide, retained-entry, short-resume and forced-churn workloads before/after with identical code, inputs, limits and checked observations. preserve the optimized private-memory path: avoid unconditional generic mode/segment branches per instruction/byte, cache flushes on ordinary data writes or state publication on each access. fixed-context specialization is allowed when its dependencies are validated.

characterize the new contexts separately: 16/32-bit ModR/M/SIB, address-size overrides, SS.B/slot-size mismatches, FS/GS, nonzero CS/data bases, segment-fault/repair paths, context imports and code-writing aliases. measure first completion, translation/browser compile/instantiation, early/later reuse, code/dependency memory, native entries and dispatches. include alternating data/stack mappings and observation before resume so cold fetch or host inspection cannot hide a cache-history regression.

keep balanced repeated raw samples, complete output checks outside timing, environment/core/host identities and meaningful intervals. use same-core/matched-host controls to attribute small resume differences. new mode forms have no executable old baseline; first completion in a shared browser is not independent cold evidence. report measured overhead rather than claiming all workloads improve or extrapolating to games.

## references

- [Intel SDM volume 1, 253665-093US](https://cdrdv2.intel.com/v1/dl/getContent/671436), §§3.3.5–3.5 and 6.2.3: sizes, register projections, segment/default selection and stack addressing.
- [Intel SDM volume 2A, 253666-093US](https://cdrdv2.intel.com/v1/dl/getContent/671199), §§2.1–2.2 and CALL/JMP/Jcc instruction entries: prefix/address forms and transfer widths. [Intel XED instruction patterns](https://github.com/intelxed/xed/blob/main/datafiles/xed-isa.txt) and [operand-size rules](https://github.com/intelxed/xed/blob/main/datafiles/xed-eOSZ.txt) resolve mode-specific encodings; [addressing patterns](https://github.com/intelxed/xed/blob/main/datafiles/xed-addressing-modes-new.txt) distinguish extended-register segment defaults.
- [Intel SDM volume 3A, 253668-093US](https://cdrdv2.intel.com/v1/dl/getContent/671190), §§3.4.4–3.4.5, 6.3–6.4 and 12.1.4/12.9.2: loaded-cache behavior, limits/types and retained/reset state. the strict maximal-limit and linear32-span checks above are Ring64 embedding policies.
- [Intel SDM volume 3B](https://cdrdv2.intel.com/v1/dl/getContent/671427), §23.1.1, and [volume 3C](https://cdrdv2.intel.com/v1/dl/getContent/671506), §29.3.1.2: real-address calculations and virtual-8086 synthetic segment state. [manual collection](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html).
