# descriptor tables and segment loads

## objective and profile

execute guest descriptor-table operations, selector queries and segment reloads against the existing private mapped memory. a guest must be able to install a GDT/LDT, load a segment, change descriptor memory without changing its loaded cache, then explicitly reload and observe the new state. LSS must publish a new SS and its encoded general-register destination together; existing memory and stack instructions must subsequently use that state.

the selected cohort is16 mnemonics: SGDT, SIDT, LGDT, LIDT, SLDT, LLDT, MOV segment forms, LDS, LES, LFS, LGS, LSS, LAR, LSL, VERR and VERW. retain the14 imported mode/size profiles and their register/address rules. protected, compatibility and long64 execution have an imported CPL; real and virtual8086 execution retain their own segment-load rules. UMIP and alignment checking remain disabled. there is no guest CPL/mode transition, paging, descriptor-backed CS transfer, TSS/task switch, interrupt/debug delivery or general CR/MSR implementation in this scope.

MOV to SS, POP SS and all segment PUSH/POP forms remain unselected. MOV to CS is invalid. LSS is selected because it atomically loads SS and a GPR without the MOV/POP-SS event-inhibition behavior. LSS does not inherently write SP: its ModRM destination may name any admitted GPR. IDTR is readable/writable state here; installing it does not deliver an event or execute an IDT gate.

## one imported context

extend the canonical execution context to retain mode, CPL, six visible selectors and their loaded caches, GDTR, IDTR and the visible/hidden LDTR state. descriptor memory is separate guest memory. context readback/import must neither consult it nor silently reconstruct hidden state from current table bytes.

provide a complete owned `ExecutionContextSnapshot` through `readContext()` and accept it in `Options.context` and idle `setContext()`. the complete shape has required top-level `mode`, `cpl`, `segments`, `gdtr`, `idtr` and `ldtr`; it must roundtrip every retained field, including long64 fields not used for ordinary address generation. the existing long64 `{mode, fsBase, gsBase}` and nonlong `{mode, segments}` objects remain accepted input shorthands; readback now returns the normalized full snapshot. presence of any snapshot-only field, even with value undefined, selects complete validation; long64 segments also selects it. reject partial mixtures and missing full fields instead of falling back to a shorthand. full long64 snapshots use `segments.fs.base`/`segments.gs.base`, not a second editable fsBase/gsBase copy; reject those mixed aliases. this is an explicit output/type extension: update host types, copy/validation paths, tests and public documentation rather than discarding new state in the legacy JSON projection. `setContext()` replaces one complete normalized snapshot, not a merge with hidden state from a previous checkpoint.

the snapshot contains these values, with one authoritative representation of each attribute:

| state                  | retained values                                                                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| execution              | mode; CPL0..3, with real fixed0 and virtual8086 fixed3                                                                                                     |
| each CS/SS/DS/ES/FS/GS | visible16-bit selector; base; effective32-bit limit; usable/type/default32; descriptor DPL/present, conforming, accessed and applicable L/G/AVL attributes |
| GDTR, IDTR             | base and16-bit limit; base is32-bit in real/virtual8086/protected and64-bit in compatibility/long64                                                        |
| LDTR                   | visible16-bit selector, valid/invalid flag and loaded base/effective limit/attributes; the base has the same legacy/IA-32e domains as GDTR                 |

field validation retains the existing imported-cache profile, including deliberately unusual caches used to test access faults. it does not require a matching descriptor in memory or prove that every host checkpoint has a realizable guest history. do not infer CPL from DS/RPL or derive a protected-mode selector from an arbitrary imported base. full-snapshot table/LDTR bases must fit their declared32/64-bit domains; a raw imported64-bit base need not be canonical until an instruction uses or loads it. ordinary compatibility data-segment bases retain their existing32-bit constraint; that validator must not truncate64-bit system roots. newly executed guest loads must apply the descriptor checks below.

expand old shorthands deterministically. use CPL0 except virtual8086 CPL3; for protected/compatibility/long64 use CS=`0008`, SS=`0010`, DS/ES/FS/GS=`0018`. retain every supplied nonlong cache field. added attributes are DPL=CPL, present=accessed=usable, conforming=L=AVL=0, and G=1 iff the supplied effective limit exceeds `fffff`; this normalization does not rescale that imported limit. for long64 use readable-code CS with base0/limit`ffffffff`, usable/P/A/G/L=1 and D/AVL/conforming=0; other caches are read-write with limit`ffffffff`, usable/P/A/G/D=1, L/AVL/conforming=0, DPL0 and base0 except the supplied FS/GS bases. real-mode shorthand selectors default0 while its arbitrary imported caches remain intact; virtual8086 selectors equal their already-constrained `base >> 4`. initialize both table registers to base0/limit0 and LDTR invalid/selector0 with zero cache fields. a valid loaded segment may coexist with empty or later-edited tables. full snapshots, rather than the legacy shorthands, preserve previously installed table/selector state across imports.

where a guest load below specifies an unusable zero cache, its normalized fields are base=limit=0, type=read-only, usable=default32=0 and DPL/P/conforming/A/L/G/AVL=0; retain the original visible null selector. invalid LDTR uses zero base/limit/attributes with its original visible null selector. these are deterministic checkpoint representations of unusable state. full-snapshot validation must accept every state produced by a successful instruction, including long64 unusable SS and data caches, and preserve every supplied field without descriptor reads. virtual8086 retains its existing normal-cache constraints and selector/base relationship.

capture and validate input objects before any asynchronous Core creation. readbacks are independent copies; invalid imports and busy/disposed calls preserve all CPU state, code owners and context generations. mode remains the only mode authority; do not invent CR0/EFER values that independently disagree with it. this scope does not expand arithmetic FLAGS beyond the existing admitted bits or enable interrupt/debug controls.

## selected encodings and widths

| forms           | opcode and operand contract                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| SGDT / SIDT     | `0F 01 /0,/1`, memory only; write6 bytes outside long64,10 in long64                                                      |
| LGDT / LIDT     | `0F 01 /2,/3`, memory only; read6 bytes outside long64,10 in long64                                                       |
| SLDT            | `0F 00 /0`; memory destination16 bits, register destination effective16/32/64 bits                                        |
| LLDT            | `0F 00 /2`; source low16 of register or m16 regardless of operand size                                                    |
| MOV r/m,Sreg    | `8C /r`; memory destination16 bits; GPR destination effective16/32/64 bits                                                |
| MOV Sreg,r/m16  | `8E /r`; sources low16/m16, destinations ES/DS/FS/GS only                                                                 |
| LDS / LES       | `C5 /r`, `C4 /r` legacy memory forms outside long64; pointer4 or6 bytes for destination16/32                              |
| LSS / LFS / LGS | `0F B2/B4/B5 /r`, memory only; pointer4/6 bytes for destination16/32; long64 REX.W adds pointer10 bytes and destination64 |
| LAR / LSL       | `0F 02/03 /r`; low16 of register source or m16 selector; effective16/32/64 GPR destination                                |
| VERR / VERW     | `0F 00 /4,/5`; low16 of register source or m16 selector                                                                   |

segment encoding numbers are ES0, CS1, SS2, DS3, FS4, GS5, independently of any internal enum order. reserved segment numbers6/7 are invalid. `8E` CS is invalid; `8E` SS remains unsupported. REX.R does not extend a segment number or an opcode-group selector. REX.B extends the GPR r/m bank; LxS/LAR/LSL destination ModRM.reg uses REX.R. ordinary REX.B/X address extensions remain effective. LLDT, VERR, VERW and `8E` never read a widened memory operand because of REX.W. selector/rights/limit results are zero-extended within the destination width; LxS writes its captured offset. apply inherited GPR-write rules afterward:16-bit writes preserve upper bits, long64 writes to32 bits clear bits63:32, and every non-long64 write preserves bits above its destination width, including upper32 on a32-bit write. failed LAR/LSL performs no GPR write at any width.

outside long64, LGDT/LIDT with operand16 load the16-bit limit and24-bit base from a nominal6-byte source; byte5 is ignored but still admitted. operand32 loads32-bit base. SGDT/SIDT write the full low32-bit base and limit in6 bytes at either legacy operand size in this modern profile. long64 pseudo-descriptors always use limit16+base64 in10 bytes;66/REX.W do not change that size. after complete long64 LGDT/LIDT source admission/read, validate the loaded base value against this CPU's canonical48 rule before publication: a noncanonical value gives protection-fault vector13/errorCode0/phase descriptor, without probing the prospective table or changing its old root. this is separate from the source operand's address check. little-endian far pointers place the offset first and selector immediately after it. use inherited address size and segment overrides independently of these fixed data widths. no new alignment requirement is introduced.

SLDT, LLDT, LAR, LSL, VERR and VERW are selected only in protected/compatibility/long64; their real/virtual8086 encodings are invalid. LGDT/LIDT/LLDT require CPL0, checked before explicit operand data access. SGDT/SIDT/SLDT are not privileged in the fixed UMIP0 profile. other selected forms do not require CPL0.

66 selects ordinary operand sizes where applicable; F2/F3 are ignored on these selected legacy forms. preserve inherited prefix ordering, REX cancellation and address-size rules. a single LOCK is invalid after required bytes of an otherwise selected form are fetched; inherited repeated-LOCK/mixed-LOCK-repeat exclusions remain unsupported. distinguish selected form/mode/LOCK failures from valid unimplemented neighbors.

in long64, C4/C5 belong to unselected VEX space, not selected invalid LDS/LES. outside long64, a second byte with mod=3 selects the VEX neighbor and remains unsupported without fetching its tails; only actual legacy memory forms enter LDS/LES. `0F 01` mod3 neighbors such as VMCALL/XGETBV remain unsupported at the deciding ModRM, not invalid pseudo-descriptor operands. unselected `0F 00` selectors retain their unsupported frontier. LFS/LGS/LSS mod3 is invalid without fetching nonexistent address tails. required-byte truncation and the15-byte limit must remain precise; compilation lookahead does not execute a later load or table check.

## descriptor resolution and loaded lifetime

for a non-null selector, TI selects the current GDT or the loaded LDTR cache, and the byte index is `selector & fff8`. only values0..3 are null; LDT entry0 selected by0004..0007 is not null. check the required descriptor extent against the selected table's effective limit using widened arithmetic, separately from address formation. invalid LDTR is a selector failure for ordinary loads and a failed query for queries.

descriptor-table accesses are unsegmented system accesses. in compatibility and long64, retain the full64-bit root base and compute `base + index + sliceOffset` without reduction, then apply canonical48/private64-bit-span checks to each actual access. compatibility's ordinary segmented operands remain unchanged. in real/virtual8086/protected, reduce each system-access starting address modulo2^32, then require its entire attempted byte span to fit the32-bit domain. a private attempted read/write does not wrap its endpoint; an endpoint crossing2^32 yields system-memory-fault/address-range at2^32. this is the selected non-wrapping private admission policy, not a claim about all hardware bus transactions. IA-32e widened overflow similarly gives a system-memory-fault, not a wrapped low-address read. do not reuse the nonlong DS translator for compatibility system roots. no table-limit/index expression is reduced modulo16/32 bits.

ordinary code/data descriptors are8 bytes in every mode. decode the split32-bit base,20-bit limit, G expansion `(limit << 12) | fff`, type/S, DPL, P, D/B, L and AVL fields. mode and table bounds, descriptor type/privilege and presence checks are separate phases; a non-present invalid-type descriptor must not bypass a required type/privilege failure merely because P=0.

for protected/compatibility non-null ES/DS/FS/GS loads require S=1 and data or readable code. data and nonconforming code require `max(CPL,RPL) <= DPL`; conforming readable code uses its documented privilege exemption. reject unsuitable types/privilege/table references with #GP(selector), and a qualifying non-present descriptor with #NP(selector). install the original visible selector and a captured hidden cache only on success. null ES/DS/FS/GS loads in these modes install the original selector and the unusable zero cache without a descriptor/A-bit access; a subsequent reference follows the inherited unusable-segment fault contract.

LSS requires writable data with RPL=CPL=DPL. in protected/compatibility modes null SS is #GP(0). in long64 null SS is permitted only if RPL=CPL and RPL is not3; otherwise #GP(0). a qualifying non-present SS descriptor raises #SS(selector). a permitted long64 null SS receives an unusable zero cache; long64 stack size and ordinary ignored-SS-base rules still apply. descriptor load does not validate the resulting GPR as a stack address: a noncanonical RSP value can be loaded, and only a later access/transfer applies its own rule.

in long64, non-null DS/ES/FS/GS loads still perform selector/descriptor checks. loaded DS/ES bases/limits are retained for the checkpoint but ignored by inherited long64 address generation. non-null FS/GS loads replace the full base with the zero-extended descriptor32-bit base. for null ES/DS/FS/GS, install an unusable zero cache. in particular this profile clears FS/GS base on a null load; it does not promise AMD's alternative preserve-base behavior. long64 address generation retains its existing ignored-usability rules, so a null DS or FS does not by itself become a protected-mode unusable-segment fault.

real and virtual8086 MOV/LxS reloads perform no descriptor access: write visible selector and `base = selector << 4`, preserving the old limit/type/D-B and other imported hidden attributes/usability. zero is an ordinary selector in these modes. virtual8086's imported normal caches consequently remain normal; a real-mode unreal-size stack keeps its old B/limit fields. these operations never infer mode or CPL from selector low bits.

when loading a qualifying non-null code/data descriptor with A=0, set only its accessed bit before publishing the selector/cache/LxS destination. capture the source pointer/selector and descriptor before this write. in private memory this is a checked one-byte write of `oldAccessByte | 1` at descriptor+5; it must not require unrelated descriptor bytes to be writable, re-read through an RMW path, or alter neighboring bits. the installed cache records accessed=true; its other decoded fields retain the captured values even if backing aliases cause other memory views to change. A=1 causes no write attempt. a failed accessed-byte write preserves all architectural destinations and completed predecessors; no numeric status, GPR or cache effect is speculative. actual backing writes, including identity/alias effects, use normal code-validity tracking.

LLDT accepts only a GDT LDT descriptor, not a TI=1 selector. null marks LDTR invalid without fetching descriptor0; retain its original visible null value and deterministically zero its invalid cache. non-null failure uses #GP(selector) for table/type/format violations and #NP(selector) for absence. in protected legacy mode the descriptor is8 bytes; this profile selects the Intel IA-32e16-byte system format in both compatibility and long64. for that format require highest-dword bits12:8=0, ignore its other reserved bits, and require a canonical48 loaded LDT base. violations give #GP(selector) before publication. this is an explicit selected system-format profile; do not infer a complete AMD compatibility-mode implementation from it. LLDT does not set a code/data accessed bit or a TSS busy bit.

LGDT/LLDT and descriptor-memory writes do not reload any existing CS/SS/data cache. LDTR's loaded base/limit also survives edits to its GDT entry. each explicit same-selector reload fetches and checks current descriptor memory again; no selector-only memoization is allowed. changing descriptor roots may affect future lookup assumptions without changing an already-loaded DS or SS.

## selector queries

LAR/LSL/VERR/VERW share lookup and privilege rules where they coincide, not the load instruction's failure/publication policy. null, table-limit, invalid-LDTR, disallowed type or insufficient visibility produces ZF=0; LAR/LSL preserve the entire destination. actual explicit operand or required descriptor-memory access failures are faults, not successful ZF=0 queries. P is not a success predicate. no query sets A, loads a segment, refreshes LDTR or changes a root/cache.

| query | S=1 descriptors                | allowed S=0 type numbers, protected legacy | allowed S=0 type numbers, IA-32e |
| ----- | ------------------------------ | ------------------------------------------ | -------------------------------- |
| LAR   | all code/data                  | 1,2,3,4,5,9,B,C                            | 2,9,B,C                          |
| LSL   | all code/data                  | 1,2,3,9,B                                  | 2,9,B                            |
| VERR  | readable data or readable code | none                                       | none                             |
| VERW  | writable data only             | none                                       | none                             |

conforming code bypasses both CPL/RPL comparisons where admitted; other queries require `max(CPL,RPL) <= DPL`. VERR is not an execute permission query. a non-present otherwise-visible descriptor can succeed. LAR returns the access-rights/flag value extracted with `00f0ff00`; this profile chooses zero for undefined bits19:16. compare all architecturally defined zero/output bits, not just that extraction mask. LSL returns the expanded effective32-bit limit, then applies the destination width. only ZF changes; preserve all other admitted FLAGS including DF and live producer bits.

independent literals must include descriptor high-dword `12ca9a34` with low limit `3456`: LAR gives `00c09a00`, LSL `a3456fff`, with16-bit results `9a00`/`6fff`. non-present conforming readable code with access byte`1e`, DPL0 at CPL3/RPL3 succeeds in LAR/VERR without an A write. for the selected LLDT upper-tail profile, highest-dword `ffffe0ff` passes the MBZ check while `fffff0ff` fails it; other descriptor checks still apply.

the ordinary lookup reads8 bytes. this profile chooses an8-byte LAR access-rights lookup with no extended-base/tail validation; the Intel entry's lack of a tail check is not a universal hardware bus-footprint guarantee. LSL for admitted IA-32e LDT/TSS types requires16 bytes and highest-dword bits12:8=0; that rejection is ZF=0, not a load exception. VERR/VERW do not read a system-descriptor tail merely to reject S/type. use these literal private phases, with faults only at a required access:

| lookup                  | ordered checks/accesses before its final publication                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LLDT                    | null; TI=GDT and full8/16-byte table extent; read low8; LDT type/S; P; for IA-32e read upper8 then MBZ and loaded-base canonicality; publish LDTR                                           |
| non-null code/data load | valid chosen table and8-byte extent; read8; S/type/privilege; P; optional A-byte write; publish selector/cache/GPR                                                                          |
| LAR/VERR/VERW           | null/invalidLDTR/8-byte extent → ZF0; read8; type/visibility → ZF0 on failure; otherwise return its query result, with no tail or A write                                                   |
| LSL                     | same low8 checks/read/type/visibility; for an admitted IA-32e system type, check16-byte table extent → ZF0 if short, read upper8, MBZ12:8 → ZF0 if nonzero; otherwise return expanded limit |

LLDT type or P failure does not probe an upper half. LSL must inspect low8 before knowing whether a system tail is required: an inaccessible low8 faults even if a later16-byte extent check would reject the descriptor. a wrong low type or failed visibility returns ZF0 without tail access; a qualifying low half with short16-byte table extent returns ZF0; a qualifying extent with inaccessible required upper8 gives system-memory-fault. these are selected private ordering rules, not a universal claim about undocumented hardware fault arbitration. do not replace them with generic full16-byte backing admission before the low-half checks.

## faults, publication and reuse

add two exclusive resumable outcomes without changing the meaning of old memory, segment, MXCSR or numeric records:

```ts
interface ProtectionFault {
  instructionPc: bigint;
  vector: 11 | 12 | 13;
  errorCode: number;
  phase: 'privilege' | 'selector' | 'descriptor';
  selector?: number;
}
interface SystemMemoryFault {
  instructionPc: bigint;
  address: bigint;
  width: number;
  access: 'read' | 'write';
  cause: 'address-range' | 'noncanonical' | 'unmapped' | 'permission';
  failingAddress: bigint;
  phase: 'descriptor-read' | 'descriptor-accessed-write';
  table: 'gdt' | 'ldt';
  selector: number;
}
```

`RunResult.protectionFault` is present only for reason `protection-fault`; `systemMemoryFault` only for `system-memory-fault`. retain the existing general-protection/MXCSR record and all old reason identities. selector error codes preserve index/TI and strip RPL (`selector & fffc`); null/privilege failures use0 as specified. preserve the original16-bit selector separately where available. no IDT/EXT bit is invented for these instruction-originated selector failures. system memory faults identify the actual attempted access, including separate low8/upper8 reads or a one-byte A-write, without inventing a segment or #PF/CR2. address is the attempted start after the specified legacy reduction or IA-32e widened addition. for a range failure with start outside the domain, failingAddress equals that start; if start fits but the endpoint crosses, failingAddress equals the first out-of-domain byte,2^32 or2^64. retain these bigints exactly, without wrapping or clamping. other access failures retain the existing first-failing-byte rules. explicit instruction operands still use the old segmented fault schemas. this does not retrofit all existing detected faults or decode-invalid causes into a complete architectural exception envelope.

faults retire zero, preserve current RIP/budget/repeat allowance and all unpublished current-instruction destinations, and retain completed predecessor effects and live values. diagnostics are exclusive and cleared on subsequent run/import/repair through the same lifecycle as existing records; clearing a diagnostic must not change descriptor/table/cache state or x87 pending state.

the execution order is: deciding-byte/required-tail fetch and legality; privilege check; explicit operand admission/read under the old context; required descriptor reads and checks; admitted A-byte write if needed; atomic selector/cache/LDTR/root and encoded-GPR publication. no single global numeric-vector sort replaces the per-instruction checks. pseudo-descriptor stores admit their full nominal6/10-byte write before publishing any byte. retain existing private full-span operand admission and lack of device/shared-memory observers.

successful context changes must end old generated assumptions before any successor uses them, including SS.B, FS/GS base, selector/CPL/table state and mode-derived decode views. publish the encoded GPR through the live generated register rules; do not merge a16-bit result with a stale canonical upper value. source addresses use old GPR/segment caches, including LSS with SP-based source or LFS through old FS. unchanged query failures preserve the live destination.

retire a successful instruction exactly once, then apply existing budget, stop-at-next and dispatch priority. a successful accessed write may invalidate executable backing and a segment load may simultaneously change context: aggregate both reasons for redispatch, do not let one successful effect erase the other or replay the instruction. host context replacement, pending compilation and cached middle-entry reuse must reject stale assumptions. descriptor edits invalidate executable dependencies only through actual written backing bytes; they do not implicitly refresh loaded segments.

all selected instructions preserve x87/MMX/XMM/MXCSR and existing arithmetic FLAGS except query ZF. descriptor operations do not check pending x87. retain the existing legacy/FX numeric-image selector-field profile; do not substitute a current CS/DS selector for unrecorded historical x87 producer metadata.

## independent acceptance packets

verify through public Node and Chrome execution, with independently encoded descriptor bytes and expected caches/rights, not expectations generated by the implementation's descriptor parser:

| packet                                   | required observation                                                                                                                                                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| complete snapshot/default/invalid import | old14-profile inputs still work; full readback roundtrips all selectors/caches/roots/LDTR and successful long64 null-SS caches with no descriptor reads; failed/busy import is atomic                                            |
| guest GDT and LDT use                    | build table bytes, LGDT, LLDT, load a TI=1 selector, use its memory base/limit; SGDT/SLDT roundtrip visible state                                                                                                                |
| hidden cache lifetime                    | modify/unmap GDT/LDT, change table roots, retain loaded DS/LDTR behavior, then same-selector reload sees current bytes/faults                                                                                                    |
| real/unreal and virtual8086              | selector/base updates only, no descriptor access; preserve real SS.B/limit, zero selector and V86 lowbits not forced to CPL                                                                                                      |
| form/width/prefix frontier               | all selected widths/modes, high GPRs, dirty upper32 preserved outside long64, REX ownership, exact4/6/10 spans, legacy24-bit LGDT, long fixed10, C4/C5 VEX and0F00/01 neighbors                                                  |
| system-address domains and root values   | compatibility GDT/loaded-LDT bases above4GiB read the high mapping, not a low alias; legacy modulo32 starts and non-wrapping endpoints; mapped long64 LGDT/LIDT source with noncanonical contents faults before root publication |
| privilege and lookup failures            | CPL0..3, both RPL operands/DPLs, conforming exemptions, S/type/P, null versus LDT0, bounds/invalidLDTR; correct vector/errorCode or query ZF                                                                                     |
| SS and LSS                               | null rules per mode/CPL, present failure #SS, destination not necessarily SP; old-SS/SP source, new-SS.B PUSH/POP, partial live GPR and noncanonical loaded pointer                                                              |
| FS/GS                                    | old-base source and high nonzero host base replaced by descriptor32 bits or selected null zero-cache profile; inherited long64 ignored DS/ES rules                                                                               |
| accessed write admission                 | A1 on R-only descriptor succeeds without write; A0 with R-only access byte fails; other descriptor bytes need only R; successful cache A=true and neighbors unchanged                                                            |
| A-bit aliases and SMC                    | A-write aliases pointer/descriptor/executable bytes; capture old sources, invalidate real backing dependencies, combine context+SMC, budget1/stop-at-next retire once                                                            |
| query-only behavior                      | P0 success, rejected system types, full type tables, exact LAR defined-zero bits, failed32/64 dest remains entirely unchanged, no A/root/cache mutation                                                                          |
| descriptor widths and tails              | 8-byte data descriptors in every mode, IA-32e LLDT/LSL system tails, reserved/type checks versus missing tail; no speculative unused LAR/VERR tail                                                                               |
| private fault provenance                 | segmented source faults versus unsegmented descriptor read/write failures, exact byte/width/phase/table/selector, no stale old fault beside new record                                                                           |
| retained entry and repair                | fault, change source GPR/selector/table bytes/mappings/CPL checkpoint, retry at current or cached middle entry without predecessor replay or stale hidden assumptions                                                            |
| live predecessors and numeric state      | dirty GPR/FLAGS/XMM values survive faults and context exits; pending x87 preserved; legacy/FX image fields remain their existing private profile                                                                                 |

include limit-1/exact-limit/limit+1, noncanonical and u64-end spans, unaligned/split pseudo-descriptors and far pointers, failed A-byte permission at every relevant split, both alias write order and unchanged neighbors. separately prove destination16 upper preservation, successful long64 destination32 zero-extension, successful nonlong destination32 upper preservation and failed query total preservation. zero-budget/stop-current must prevent all new data/table probes and state effects. fresh context imports and guest writes must never reuse code compiled under an invalid assumption.

## implementation and performance acceptance

x86 owns selector/descriptor interpretation, type/privilege queries and reload effects. memory owns checked unsegmented byte access, actual A writes and backing/source validity. execution context owns visible/hidden state and replacement. generated execution owns live inputs/results, one retirement and successor assumptions; embedding owns snapshots and diagnostics. share checks only where semantics coincide, not by forcing query failure into the segment-load exception path. no generic exception interpreter, descriptor cache or always-on provider abstraction is required.

land executable increments for snapshot/table transport, GDT/LDT loads, MOV/LxS publication, queries and combined failure/reuse boundaries. every increment carries the relevant public integration guards. `npm run check` is implementation acceptance; update public context/fault usage documentation.

compare the existing74 GP/memory/stack/numeric/image/streaming/control kernels against frozen build identities. characterize ordinary accesses after descriptor reloads, reload/query-heavy loops, table/LDTR replacement, A0/A1, valid/invalid queries, LSS stack changes, split/W-only stores, A-write SMC, cold compilation and short resumes. verify complete outputs and cache/native-entry/dispatch counts before timing. record first/early/later reuse, translation/compile/instantiation, generated/cache bytes and snapshot costs. use fresh/reversed and same-build controls for small effects; newly executable forms have no old-build instruction-throughput baseline. unchanged ordinary memory execution must not repeatedly fetch descriptors or copy full context/numeric banks for each access.

## references

- [Intel SDM revision093](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html): volume2A LAR, LDS/LES/LFS/LGS/LSS, LGDT/LIDT, LLDT, LSL; volume2B MOV, SGDT, SIDT, SLDT; volume2C VERR/VERW; volume3A descriptor/privilege chapters and §7.8.3. the individual operation/type tables govern, including LSS's explicit lack of MOV/POP-SS inhibition.
- [Intel XED ISA patterns](https://github.com/intelxed/xed/blob/0bcb6237345c5066726dcc08b3d87928df3b5b26/datafiles/xed-isa.txt): selected forms, register ownership and opcode neighbors; these do not define memory fault/publication semantics.
- [AMD64 system programming manual](https://docs.amd.com/api/khub/documents/sD1_QL~h4Afq2_tvzxqqSQ/content), §§4.1–4.2: real/virtual8086 cache preservation and vendor-specific null FS/GS behavior. [Pinned QEMU real-load path](https://github.com/qemu/qemu/blob/71f25c75417d31c214ba2cd26b273c114fc99987/target/i386/tcg/translate.c#L1807) corroborates selector/base-only updates; it is a reference implementation, not an independent hardware oracle.
