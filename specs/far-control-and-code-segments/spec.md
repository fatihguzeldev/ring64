# far control and code segments

## scope

Implement ordinary code-segment far CALL, JMP and RETF through the public CPU path. Include immediate and memory-indirect transfers, same-privilege returns, outer-privilege returns, and changes between compatibility and 64-bit code within an already imported IA-32e execution family. Execute the destination using its loaded CS base, limit, D and L attributes; preserve the distinction between descriptor bytes and loaded caches.

The starting contexts are the fourteen imported mode/size profiles. Real and virtual8086 transfers retain their mode; protected transfers retain protected mode and load the next code-size attribute. Compatibility and long64 are one active IA-32e family for this contract: a successful code load selects compatibility when the target descriptor has L=0, or long64 when L=1. This changes no CR/EFER state and does not enter or leave the IA-32e family. Direct ordinary-code CALL/JMP preserve CPL. In protected/IA-32e contexts RETF also supports an outer return selected by a greater return-selector RPL. Real/V86 RETF always consumes the two-slot form; selector low bits never request an outer return or change CPL.

Call gates, task gates, TSS/task switching, IRET, interrupt delivery, MOV/POP SS inhibition, reset and CR/EFER-driven family transitions have separate contracts. CET, FRED, alignment checking and paging are disabled in this private-memory profile. No instruction here changes FLAGS, XMM, MXCSR, x87/MMX state or pending numeric exceptions.

## forms and decoding

| encoding | selected form                    | operand size and source                                                  |
| -------- | -------------------------------- | ------------------------------------------------------------------------ |
| `9A`     | far CALL immediate               | nonlong only, offset16/32 followed by selector16                         |
| `EA`     | far JMP immediate                | nonlong only, offset16/32 followed by selector16                         |
| `FF /3`  | far CALL memory                  | offset16/32 plus selector16; long64 additionally permits offset64        |
| `FF /5`  | far JMP memory                   | same pointer forms as CALL; memory only                                  |
| `CB`     | RETF                             | two operand-width current-stack slots, plus two more for an outer return |
| `CA iw`  | RETF with unsigned imm16 cleanup | same slots; parameter-skip rules below                                   |

Nonlong operand size follows source CS.D and `66`. In long64, all selected far forms default to32, `66` selects16, and effective REX.W selects64. This includes CALL and RETF; the existing default64 rule for near CALL/RET does not apply. REX cancellation, B/X effective-address extension, address-size overrides and segment selection retain the established decoder rules. The pointer and frame widths belong to the source instruction, not the destination's D/L attributes. The encoded imm16 cleanup is unsigned independently of operand size.

`9A` and `EA` are invalid in long64 at the deciding opcode. `FF /3` and `/5` with Mod=3 are invalid at ModRM; they have no register-pointer form. Group selection ignores REX.R. F2/F3 are ignored for these selected base instructions; no MPX/CET effect is enabled. Single LOCK is invalid after the required selected tail has been fetched. Repeated LOCK and mixed LOCK/repeat retain the existing unselected-prefix frontier. `CA` requires both immediate bytes before legality is resolved. Truncation and the fifteen-byte limit retain their established fetch frontier. An engine invalid-encoding result is not a universal architectural #UD classification.

## authoritative state and checkpoints

Use the canonical execution context for CPL, selectors, hidden segment caches, mode family and table roots. Publish changed CS, mode, CPL and, where required, SS as one transition with the new logical instruction pointer and raw stack-pointer bank. Do not add an independently mutable active-mode or loaded-descriptor authority. A same-selector transfer resolves the descriptor again; table edits alone do not refresh loaded state.

A CS-only switch can retain a null, unusable or unusual SS imported in long64. It can also retain upper bits of loaded data-segment bases. The next compatibility access applies compatibility address/type/usability rules; the transfer itself does not reload SS or data segments to make them usable.

Full snapshots must represent and round-trip every resulting context. In particular, full compatibility snapshots accept retained SS caches without the legacy shorthand's writable/usable-SS requirement, and preserve raw64 non-CS cache bases. Compatibility address generation still uses its32-bit linear profile. FS/GS raw bases remain canonical48 in both IA-32e submodes, so a retained base can survive a later return to long64. Legacy shorthand validation and legacy/protected base domains retain their existing constraints. Full CS snapshots retain the applicable usable-code role check. A rejected import changes nothing; valid equal-context repair preserves owners while clearing transient diagnostics.

## code descriptor resolution

Capture an indirect far pointer through the old execution context as one complete4/6/10-byte operand. Immediate pointers require no data access. Resolve selectors through GDTR or the loaded LDTR using the existing unsegmented system-access domain, widened bounds, low8-byte descriptor read and exact accessed-byte write. Selector0..3 is null; LDT entry zero is not null. Do not mask a widened table extent or reinterpret internal descriptor access as a DS operand.

For protected and IA-32e ordinary-code CALL/JMP:

- require a code descriptor, including execute-only code;
- nonconforming code requires DPL=CPL and selector RPL<=CPL;
- conforming code requires DPL<=CPL and ignores selector RPL;
- in IA-32e, L=1 with D=1 is invalid;
- check type/privilege before presence; qualifying absent code gives #NP(selector);
- install the visible CS selector with RPL forced to the unchanged CPL.

For protected/IA-32e RETF, require a code descriptor and reject IA-32e L=1/D=1 with #GP(selector) before return-RPL/privilege and presence checks. Return-selector RPL must be >= old CPL. Nonconforming code requires DPL=return RPL; conforming code requires DPL<=return RPL. Type and these checks precede presence. In these contexts an RPL equal to old CPL selects the two-slot return; a greater RPL selects the outer return and becomes the new CPL. RETF to a system descriptor is #GP(selector), not an unimplemented gate return.

For CALL/JMP, recognized legacy system-target handlers `{1,3,4,5,9,B,C}` are outside this ordinary-code cohort. In IA-32e only the call-gate type C reaches that unselected handler frontier. Return engine `unsupported` after the low descriptor has identified that handler, before gate/task-specific presence, busy, tail, target or stack work. This frontier makes no claim that the unimplemented handler would succeed. Other non-code kinds, including IA-32e legacy gate/task kinds, give #GP(selector). No unselected handler performs an A write or publishes state.

For all new loads, the cached conforming flag is descriptor type bit2 only for code; data type bit2 remains expand-down and is not a conforming exemption. Descriptor-base fields are captured even when a destination long64 CS ignores its base and limit for fetch. In legacy protected mode L does not activate IA-32e; D determines the next code-size profile. Existing GDT/LDTR caches and unrelated loaded segments remain unchanged unless outer-return cleanup explicitly affects them.

## target offsets and real-mode caches

CALL to a compatibility target reduces a supplied offset to32 bits before the target-limit check; operand16 additionally clears bits above15. JMP follows the selected detailed Intel algorithm: operand16 clears bits above15, but a wide offset to compatibility must pass the code-limit check before publication, without CALL's extra low32 reduction. Protected targets use the admitted16/32-bit offset. A long64 target uses the admitted zero-extended16/32-bit or raw64 offset and checks canonical48, with its code base and limit ignored for execution. Failure is #GP(0), with no transfer or retirement.

RETF consumes the admitted return-offset slot; it does not reuse CALL's compatibility truncation. For a nonlong target the resulting offset must fit the loaded target code limit; a wide return offset is not silently wrapped to make it fit. A long64 target requires a canonical offset. These value checks do not probe the target instruction's execute mapping.

Real/virtual8086 CS loads replace the visible selector and base=selector<<4, retaining the previous hidden limit, D and other attributes under the selected cache-preserving profile. They do not consult descriptor tables or set A. Keep the instruction-specific target clauses separate: CALL checks the retained CS limit at both widths, and real/V86 operand32 CALL additionally requires offset[31:16]=0; JMP checks the retained CS limit; RETF checks its resulting offset against the retained CS limit in this private profile. Virtual8086's existing fixed cache constraints remain valid. Selector0 is an ordinary real/V86 selector. A real-mode16-bit RETF frame containing IP=`1000`, CS=`0003` uses only its four frame bytes, publishes CS base=`30` and CPL0, and never reads restored SS/SP based on selector RPL bits.

A successful transfer to unmapped or non-executable destination memory still completes. Budget and stop checks at the new logical RIP can finish the run before destination fetch. Otherwise the subsequent instruction fetch reports its own fault using the new CS; do not move that fetch fault back onto the CALL/JMP/RETF.

## stack slots and pointer updates

Freeze the old mode, SS cache and stack-address width at instruction entry. Let W be the operand byte width2/4/8. A pointer step wraps at that frozen stack-address width; each W-byte slot then uses the existing segment and linear-span rules. Do not wrap each byte of a slot or replace separately wrapped slots with one contiguous2W/4W memory access.

CALL computes `p1=oldSP-W` and `p2=p1-W` using old-width pointer steps. The CS slot is W bytes at p1; the return-offset slot is W bytes at p2. The selected private-RAM profile writes the complete CS slot as zero-extended old selector, and the offset slot as the low W bytes of the completed source next-PC. This requires only W permission for frame writes, including their defined padding. Commit CS first, then return offset: backing aliases can distinguish that order. The final raw SP merges p2 into the old bank using the frozen old stack-address width. A target64 does not retroactively make a compatibility CALL's source stack64.

RETF first captures the complete W-byte offset slot at oldSP and the complete W-byte CS slot at the next old-width pointer. Only the low16 bits of the CS slot select a descriptor, but all W bytes require read access. Same-CPL RETF completes both old-width pop steps, then applies imm16 using that same frozen old-width arithmetic. This cleanup does not itself probe memory or the adjusted pointer's bounds. Subsequent stack operations use the newly selected mode.

For an outer RETF, skip imm16 parameter bytes on the old stack after the first two slots, using old-width arithmetic; the following W-byte restored-SP and W-byte restored-SS slots are also read through the old context. For nonzero imm16, admit one skipped-span geometry from the post-two-pop pointer with width=imm16, without per-byte stack-width wrap; advance its pointer once using the frozen old width. There is no backing read or R-permission requirement for that gap. For imm16=0 there is no gap admission. Then admit geometry and read the restored-SP slot before admitting geometry and reading the restored-SS slot; do not precheck both slot geometries before the first read. There is no parameter copy. All four actual slots are captured before any A write; the restored SS selector uses its low16 bits.

Validate restored SS under the **prospective** target mode and new CPL. A nonnull SS must be writable data with RPL=DPL=new CPL; type/privilege precede presence, and absence gives #SS(selector). Null SS is permitted only for target long64, new CPL<3, and matching SS.RPL. It skips descriptor lookup, replaces the visible selector and marks the cache usable=false while retaining old base, limit, type, D and raw attributes. That usability marker is an explicit private checkpoint policy; no new descriptor is decoded. This is distinct from LSS's explicit null-cache transition. Null SS in compatibility/protected targets or at CPL3 gives #GP(0).

The skipped span is one widened, unwrapped interval in old logical stack offsets. For old SS.B16, W4, old SP=`fff0` and imm=`10`, the actual slots are at`fff0/fff4/0008/000c`, but gap geometry covers`fff8..10007`: limit=`ffff` fails at offset`10000`, while retained limit=`ffffffff` admits it. Do not split the gap at the16-bit pointer wrap.

The private raw-bank rule for an outer return is to zero-extend the popped W-byte restored pointer into raw RSP, then add imm16 using the **target** stack-address width:64 in long64, otherwise new SS.B16/32. Bits outside that target-width addition belong to the newly restored value, not the old RSP. Do not use an ordinary low16 destination merge. Neither the restored pointer nor the adjusted new pointer is accessed merely to validate the return; a noncanonical raw64 restored RSP can be published and fail on the next stack access. Target RIP checks remain mandatory.

## outer-return data cleanup

After successful validation, use the old loaded ES/DS/FS/GS type, conforming and DPL facts. If a cache denotes data or nonconforming code and its DPL is below new CPL, clear its visible selector to0 and set usable=false. Preserve its other hidden fields and base, including FS/GS base. Conforming-code caches are retained. No fresh descriptor-table read or A write belongs to this cleanup. Test the captured cache facts even for an already-null or unusable imported selector; do not skip the cleanup predicate merely because its visible selector was null.

This implicit invalidation is not an explicit null segment load. In long64 an ignored data cache can remain unusable while its preserved FS/GS base still contributes to address formation; in compatibility its unusable state is observed by the next relevant access. The exported snapshot must preserve this distinction. No data cleanup occurs for same-CPL returns or solely because CS.L changes.

## checks, side effects and failure order

Reuse existing explicit-operand segment/data records for indirect pointer access. Old implicit SS geometry, canonical/range and backing failures use the existing SS-segment/data records; they are not fabricated #PF/CR2 outcomes. Descriptor-table extent/type/privilege/presence failures and restored-SS failures use `protectionFault`; internal descriptor backing failures use `systemMemoryFault`, with their existing8-byte read and1-byte A-write metadata. Add `target` to `protectionFault.phase` for #GP(0) target-value failures. Existing reason IDs, other phase values and numeric diagnostics remain stable.

Null/table-selection/extent failures use phase `selector`; code/SS type, L/D, privilege and presence failures use `descriptor`. RETF's return-RPL-below-old-CPL failure uses `descriptor` after the required code read/type checks. Selector-related records retain the original selected low16 selector and mask RPL from the architectural error code; null-selector #GP has errorCode0. Target-value #GP(0) uses phase `target` and omits selector. Internal A-byte/read backing faults retain the original selector including its RPL. All records name the source instruction PC, and transient records remain mutually exclusive and clear together on the next valid run/import.

The selected failure phases are:

| operation          | required phases before write admission                                                                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CALL/JMP indirect  | complete selected fetch/legality; old-context pointer capture; null/table/descriptor/type/privilege/presence checks                                                                                         |
| CALL ordinary code | above; both old-SS slot geometry checks in CS-then-offset order; target-value validation                                                                                                                    |
| JMP ordinary code  | descriptor checks; target-value validation                                                                                                                                                                  |
| RETF same CPL      | old offset slot then CS slot capture; return-CS descriptor/type/privilege/presence; target-value validation                                                                                                 |
| RETF outer         | first two slots and return-CS checks; old skipped-span geometry; restored-SP geometry+read; restored-SS geometry+read; new-SS checks; target-value validation                                               |
| real/V86           | CALL: old pointer capture if indirect, CS-slot geometry, IP-slot geometry, target checks, then CS/IP W admissions; JMP: pointer capture then target; RETF: offset/CS captures, target, nonaccessing cleanup |

For copied private RAM, select pre-admission of every required write before committing any write: code A byte if captured A=0; restored-SS A byte if outer and nonnull A=0; CALL CS slot; CALL return-offset slot. Check W permissions in that order after the preceding required phases. A1 descriptors require no write permission. Once all admissions pass, commit those writes in the same order, then publish the prepared register/context transition. Mapping/permissions cannot change during this synchronous private-RAM instruction. All pointer values, frame inputs and installed cache fields derive from the captured pre-write bytes. Alias writes must not cause descriptor or frame rereads.

This pre-admission policy prevents partial memory/state publication on these private backing failures. It is not a hardware guarantee about later page-walk A/D updates, MMIO effects or #PF side effects. Later memory-provider and paging contracts must define their own effects. A frame write can overwrite a descriptor's just-set A byte through an alias; the installed cache still has A=true from the successful captured load. Do not force the final descriptor bytes back to the captured cache.

On failure, retain original CS/SS/CPL/mode/SP/RIP and the live predecessor outputs, retire0 for the failed instruction and preserve both allowance pairs. No numeric state or pending exception changes. On success, retire exactly once and make the new RIP and full prepared raw SP visible together. A context change and any code-alias write share one completed transfer boundary; they do not cause two retirements or replay.

## generated execution and reuse

A far transfer's destination is its prepared target RIP, not source next-PC. Do not use a completed context-redispatch path that overwrites the prepared target or restored SP with old generated locals. Capture live source GPR/EA/SP inputs before helper effects; merge or install the complete prepared pointer according to this contract, including when the source and destination bank is SP. Preserve live FLAGS and predecessor XMM locals without whole-bank spills unrelated to this operation.

Changed CS/CPL/mode/SS assumptions retire stale translations and pending publications before any successor runs. Context-equal transfers may retain valid owners, but still perform required fresh descriptor checks. A-bit/frame writes participate in normal backing-identity invalidation, including identity writes and aliases to the source or destination code. Cached middle entries and direct target reuse must check the context and source generations that justify them.

Entry budget0 and stop-at-current prevent operand/stack/descriptor effects. After one successful transfer, exhausted instruction budget wins before stop; otherwise stop at the new logical RIP wins before destination fetch. A remaining budget dispatches under the new context. REP allowance is preserved; these instructions perform no repeated elements. Units without far operations gain no far helper import, per-access descriptor lookup, event poll or numeric-bank copy.

## acceptance packets

Run independent literal and generated-Wasm/public Node/Chrome packets. Preserve complete scalar/FLAGS, XMM, MXCSR and raw pending x87 projections around each applicable case; compare undefined raw bits only where the selected private policy defines them.

1. Cover immediate and memory forms, every admitted width and all fourteen starting profiles. Verify exact4/6/10-byte pointer reads, full frame-slot widths, source segment/address overrides and execute-only destination code.
2. In long64, `FF 1B`, `66 FF 1B`, `48 FF 1B` with old RSP=`4020`, old CS=`8`, target long64 offset=`2000`: final SP=`4018/401c/4010`; return offsets=`1002/1003/1003` in4/2/8-byte slots; matching-width RETF restores the frame. Default `CB` consumes8 bytes, `66 CB`4, `48 CB`16, regardless of target L.
3. Test required-tail/fifteen-byte frontiers, prefix cancellation and REX group/address ownership; direct9A/EA invalid-long, register FF/3/5 invalid, and unselected neighbors remain distinct. Budget0/stop-current have no dynamic accesses.
4. Change protected CS.D in both directions at the same logical target PC and execute bytes whose16/32 decode differs. Change CS base and limit independently; edits to the old descriptor alone do not refresh CS, while same-selector transfer does.
5. Execute compatibility→long64 and long64→compatibility code at retained/middle PCs. Verify source widths versus target decode, logical RIP versus CS-based linear fetch, old SS-based frame handling and target mapping fault only after successful retirement.
6. Use old SS.B16, limit=`ffffffff`, raw SP low16=`6`, operand32: CALL CS slot is at2 and IP slot at`fffe`, whose four-byte span ends`10001`; RETF reads those two locations in reverse push order and returns SP low16 to6. Dirty raw upper SP bits survive ordinary old-width steps. A contiguous eight-byte frame implementation must fail this packet.
7. Exercise nonconforming/conforming code at every CPL/RPL/DPL boundary, including ignored conforming source RPL, forced installed CS.RPL, execute-only code, null selectors, invalid LDTR, LDT entry zero, table last-byte limits, P0 and IA-32e L=1/D=1. Type/privilege beats presence.
8. Verify engine frontier for recognized gate/task handlers without fake #GP, tail fetch, A writes or frame effects. RETF to the same system descriptor still gives #GP. Distinguish IA-32e invalid legacy system kinds.
9. With a compatibility target limit=`ffffffff` and supplied64-bit offset=`1_00002000`, CALL selects offset=`2000`; JMP and RETF give #GP(0). Do not share CALL's extra reduction with those operations. Test noncanonical long64 RIP, real operand32 CALL's upper16 rule and real/V86 retained CS cache facts.
10. Place competing failures in pointer tail, code descriptor, old stack geometry, target value, CS-A, SS-A and CALL slots; assert the chosen phase, exact width/address/selector/table and no partial private writes. A1/R-only code must work; A0 requires only its one-byte W permission. For real CALL with CS.limit=`10` and target=`20`, bad old-SS geometry wins; with valid geometry but W-denied stack, target #GP(0) wins before private W admission. In outer operand32 RETF with old SP=`4000`, SS.B32/limit=`401b`, imm=`10`, restored-SP at`4018` unmapped and restored-SS at`401c` beyond the limit, the SP-slot data-fault wins before the later SS-slot geometry failure.
11. Alias A bytes, pointer bytes, frame slots and retained executable bytes. Distinguish CS-first/IP-second writes when both slots alias the same backing; capture descriptors before an A write mutates another descriptor field. Test a frame overwriting a just-set A byte while the loaded cache stays accessed.
12. Outer return covers CPL0/1/2→greater CPL, conforming/nonconforming targets, SS RPL/DPL/type/P checks and null-SS exceptions. Missing SS is #SS(selector) after qualifying type checks. All frame reads use old SS before new SS/CPL publication.
13. For long64 `48 CA 10 00`, old stack=`4000`, frame slots RIP=`2000`, CS=`1b` at`4000/4008`, restored SP=`5000`, SS=`23` at`4020/4028`: valid DPL3 descriptors produce CPL3, RIP=`2000`, RSP=`5010`. Leave`4010..401f` unmapped: skipped parameters are not RAM reads.
14. With restored32-bit SP=`89abfffe`, target SS.B16 and imm3, final raw SP=`89ab0001` under the defined restoration policy. Also return with allowed null SS selector1 from CPL0 to CPL1 long64, then switch only CS to CPL1 compatibility: retained SS is unusable and the next PUSH faults. Test restored16/32/64 values against dirty old raw SP, same-CPL old-width cleanup versus outer target-width cleanup, and a noncanonical restored raw64 pointer whose next stack use faults after successful return.
15. Outer cleanup uses loaded caches despite changed/unmapped backing descriptors. DPL0 data/nonconforming caches become selector0/unusable at CPL3 while bases and hidden fields survive; conforming caches remain. Contrast implicit FS/GS cleanup with explicit null MOV's zero-base policy.
16. Preserve null/unusable SS and canonical high FS/GS bases across long64→compatibility. Round-trip every resulting full snapshot, including unusable SS and retained raw upper non-CS bases; the next compatibility stack/data access applies its actual usability and32-bit address rules.
17. Test unmapped destination with budget1, positive budget plus stop-at-target, and continued fetch. Check new-context metadata and exactly-once retirement when both A/frame SMC and CS/CPL changes invalidate old owners. Repair failure and resume without replaying predecessors.
18. Compare cold, retained and middle entries, equal-context reloads, pending publication guards, host context replacement and different CPU instances. Snapshot/import errors and malformed private descriptors cannot mutate owners or state. Existing numeric images retain their saved-selector profile.

## verification and performance

Use the repository's existing decoder, Rust semantics, generated-Wasm and common Node/Chrome test paths; run `npm run check`. Independent descriptor/frame literals and a pinned primary decoder reference must determine encodings and defined outputs rather than copying the implementation's calculations. Verify new checkpoint admissibility and malformed-input boundaries at the public host path.

Compare all88 existing checked kernels against the frozen pre-feature build using `npm run bench -- --baseline /path/to/built/baseline` and the corresponding `--browser` run. Record build hashes, environment, cold translation/compile/instantiation, first/early/later completion, generated/cache bytes, native entries and dispatches. New far forms are unavailable on an unsupported baseline, not speedups over it. Characterize immediate/indirect CALL-JMP-RETF loops,16/32/64 slots, A0/A1, same/changed CS, submode handover, outer returns, split/aliased frames, fault repair and budget-one resume. Ordinary execution after a transfer must not acquire an ongoing descriptor-fetch or whole-state-copy tax. Investigate apparent regressions with fresh/reversed/A/A controls; no throughput claim substitutes for checked state, effects and reuse.

## references

- [Execution contexts](../mode-context-and-decoding/spec.md), [near control and stack](../near-control-and-stack/spec.md), [descriptor tables and segment loads](../descriptor-tables-and-segment-loads/spec.md), and [memory/code validity](../memory-map-and-code-validity/spec.md).
- [Intel SDM collection](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html), revision093: Vol2A CALL3-121–137 and JMP3-504–516; Vol2B RET4-569–581; Vol3A§6.8.1,§6.8.5.1 and§6.8.6. Detailed algorithms govern the selected frame/type/absence cases; private padding, raw-bank and RAM admission choices are named above.
- [AMD64 Architecture Programmer's Manual](https://docs.amd.com/v/u/en-US/24593_3.44_APM_Vol2), Vol2§4.1–4.2, for real/V86 CS cache retention; Intel-selected far encodings are not a blanket vendor-conformance claim.
- [Pinned Intel XED base encodings](https://github.com/intelxed/xed/blob/0bcb6237345c5066726dcc08b3d87928df3b5b26/datafiles/xed-isa.txt): CALL_FAR, JMP_FAR and RET_FAR. XED encoding metadata is not a descriptor/fault-order oracle.
