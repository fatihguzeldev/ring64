# call gates and privilege stacks

## objective and selected profile

Complete call-gate CALL/JMP and their matching RETF round trips through the public CPU, starting from implementation `43dad55`. Include legacy 16/32-bit gates, IA32e 64-bit gates, same-CPL/conforming transfers, inner privilege stacks and all 0–31 legacy parameter counts. Gate selection, descriptors, TSS fields, old parameter reads, new frame admission, context publication, debug completion and generated execution form one contract; decoding a gate descriptor alone does not complete it.

This closes a selected control/protection path on the current memory/event owners. It does not complete the thirteen architectural areas. [Selection and falsification](review.md) records the alternatives and resolved review challenges. [Ordinary far transfers](../far-control-and-code-segments/spec.md), [software events](../software-events-and-iret/spec.md), [architectural faults](../architectural-access-and-legality-faults/spec.md), [paging](../long-mode-paging-and-permissions/spec.md), [legacy paging](../legacy-paging-and-permissions/spec.md), [reset/transitions](../reset-and-mode-transitions/spec.md), [debug](../hardware-breakpoints-and-debug/spec.md) and [context reuse](../context-and-code-reuse/spec.md) remain authoritative except where this spec admits the previously unsupported call-gate path and explicitly refines IA32e CALL/JMP descriptor-span canonicality below.

Run in applicable protected16/32, compatibility16/32 and long64 imported contexts, their inherited stack sizes, and the existing `linear`, fixed `ia32e-paged` and `physical` memory models. Physical protected PG0, non-PAE, PAE and IA32e use their existing control/translation family. IA32e is an active execution family, not a synonym for `paging.is_some()` or CR4.PAE. Real/v8086 far CALL/JMP retain their ordinary segment-transfer behavior and never consult a descriptor to discover a gate. Include those fourteen-profile inherited negative controls.

Keep the existing **private captured-publication profile**. Capture selected parameter values before descriptor-accessed-byte/frame payload publication; all payload admissions precede payload writes. This deliberately specifies overlapping-stack results using captured values. Intel's sequential description pushes old SS/SP before copying parameters; this spec does **not** claim equivalent native ordered-alias or microcode partial-store behavior. Page-table A/D effects remain governed by the existing eager-A/prepared-D contracts and are not rolled back. This distinction is normative, not an implementation shortcut to be inferred later.

Hardware task switching, task/IDT gates, NT task returns, CR8 execution, CPU identity/clocks, x87 transcendentals, XSAVE/AVX, shared-vCPU memory, MMIO, CET, FRED, MPX and speculative execution remain separate. A call gate does not switch a task, update TSS busy state, set CR0.TS/NT, manipulate IST, push FLAGS or acquire a MOV-SS shadow.

General CR0.AM/RFLAGS.AC alignment checking remains outside the inherited far profile. Preserve current AM import/control frontiers and raw AC flag without adding #AC behavior. An unaligned gate stack has no new gate-specific alignment requirement.

## instruction forms and independent widths

The existing far opcodes and required-byte grammar apply: nonlong `9A`/`EA`, memory `FF /3`/`FF /5`, and `CB`/`CA iw` returns. No new opcode is needed. Immediate far forms remain invalid in long64; register FF /3 or /5 remains invalid. Preserve deciding opcode/ModRM, required tails, sole LOCK versus repeated/mixed-prefix frontiers, REX cancellation, ignored F2/F3, address size and source segment rules. A valid unsupported neighbor is not blanket architectural #UD.

The instruction still captures its entire far operand: offset16/32/64 plus selector16, requiring exactly 4/6/10 memory bytes. Once its selector identifies a gate, that operand's offset **value is ignored**, even if it exceeds the destination limit or is noncanonical. Its bytes are still required and can fault. The gate's embedded selector/offset provide the target; they are not the generic descriptor base/limit fields. A later runtime selector can change between ordinary code and gate without recompiling the source instruction.

Keep these dimensions separate:

| fact                                    | authority                                                       |
| --------------------------------------- | --------------------------------------------------------------- |
| far operand width / source next-PC      | source instruction and prefix grammar                           |
| frame slot and legacy parameter width W | gate: 2, 4 or 8 bytes                                           |
| legacy old parameter pointer steps      | old SS.B: 16 or 32 bits                                         |
| legacy destination pointer steps        | unchanged SS.B for same CPL; new SS.B for an inner call         |
| TSS field width                         | cached TR type: 16/32-bit legacy TSS, or 64-bit IA32e TSS       |
| destination instruction decoding        | loaded CS.D/L and active family                                 |
| return frame consumption                | RETF's own effective operand width; no remembered gate metadata |

A 32-bit gate reached by operand16 still pushes dwords and captures dword parameters; a 16-bit gate reached by operand32 pushes words. IA32e gates always push qwords from either compatibility or long64, including source operand16/32. The corresponding RETF must explicitly select the matching width; long64 `48 CB`/`48 CA iw` selects64 under the existing far-return grammar. Do not change ordinary far or RETF defaults to make an incorrectly written return work.

## gate lookup and target admission

Resolve the far selector through the existing GDTR/loaded-LDTR system-access owner. Only selectors0..3 are null; LDT entry zero is valid. Bounds and address arithmetic are widened; legacy system-start wrapping and complete-field domain checks retain their existing rules. GDT/LDT metadata reads use supervisor provenance and do not use the operand's DS/SS override.

Select these descriptor forms:

| active family         | gate type / extent   | target offset                                                 | count                       |
| --------------------- | -------------------- | ------------------------------------------------------------- | --------------------------- |
| legacy protected      | S=0, type4, 8 bytes  | low16                                                         | byte4 & 31, words           |
| legacy protected      | S=0, typeC, 8 bytes  | low16 plus bits63:48                                          | byte4 & 31, dwords          |
| IA32e, either submode | S=0, typeC, 16 bytes | the same assembled low32 as gate32, plus bytes8..11 as high32 | ignored; no parameter reads |

An IA32e type4 gives #GP(gate selector), not a legacy16 call and not Unsupported. Existing unselected legacy task/TSS handlers retain their Unsupported frontier after the low descriptor classifies them; this spec does not admit a task body. Other non-code/non-gate descriptors retain #GP. RETF never interprets its saved selector as a gate.

Pin this selected lookup order, including private physical-failure frontiers:

1. Capture the instruction's operand, resolve the gate selector, require the low8-byte descriptor extent and read those8 bytes. Ordinary-code classification retains its existing path.
2. For a selected IA32e typeC, require the **whole16-byte table extent** before gate privilege/presence checks. Extent failure gives #GP(gate selector) without reading the tail. This post-classification extent check must not make ordinary8-byte code descriptors require16 bytes.
3. Require source CPL <= gate DPL and gate-selector RPL <= gate DPL. Failure gives #GP(gate selector), before a P0 gate gives #NP(gate selector).
4. Only after those low-half checks, read the IA32e high8 bytes using the original widened lookup index+8. Reject nonzero bits12:8 of the highest dword with #GP(gate selector). The remaining ignored fields do not acquire an IDT IST/reserved-byte rule: the former count byte is ignored and does not select a stack, copy or #GP. Legacy count uses only its low5 bits; the16-bit gate's unused high offset field does not widen its target.
5. Resolve the embedded code selector, ignoring its RPL for these gate privilege tests. Null gives #GP(0); bounds/type/privilege failures name the code selector. Require code type. CALL permits code DPL <= source CPL; JMP permits nonconforming DPL = source CPL, or conforming DPL <= source CPL. IA32e additionally requires target L=1,D=0. These checks precede target P0, which gives #NP(code selector).

For a conforming destination, retain old CPL even when its DPL is numerically lower. Otherwise CALL changes CPL to target DPL only when it is lower; JMP never enters an inner nonconforming privilege level. Install CS.RPL = resulting CPL, not gate RPL, embedded RPL or conforming DPL. Capture target code cache fields through the existing descriptor owner; same-selector transfers still read the descriptor anew. Legacy L bits do not activate IA32e.

The original gate selector remains the provenance for its tail and errors; do not turn a tail lookup into selector+8 with u16 wrap, or an IDT vector reference. An expanded LDT can admit a gate at indexfff8 with its tail aboveffff; a GDT limited toffff cannot. Gate descriptors receive **no descriptor A/busy write**. ORing ordinary code A into typeC would corrupt the gate to typeD.

In-domain noncanonical IA32e descriptor spans in this CALL/JMP consumer select architectural #GP(the selector being resolved), not the old generic GDT/LDT #GP(0) source. The initial low8-byte lookup names the original far selector, before code-versus-gate classification is possible; this narrow refinement therefore also applies to ordinary-code CALL/JMP at that initial lookup. A selected gate tail names its original gate selector; its target code lookup names the embedded code selector. Apply these checks at their selected read phases: a denied/P0 gate does not read or canonical-check its tail. Selector extent failures still precede memory access. Widened u64/domain overflow retains the inherited private address-range diagnostic and takes precedence over an in-domain canonical classification. Do not change RETF, LTR, unrelated descriptor consumers or the global system-fault mapper to obtain this local rule.

Preserve the existing report/delivery split for these access failures. Report mode still returns `system-memory-fault` with the complete original address/width/failing byte/cause/table/selector/`descriptor-read` metadata. Capture the far consumer's architectural #GP(selector) source at that producer boundary, and select it ahead of the generic #GP(0) fallback only when opt-in pending/delivery captures the exception. Do not change the report reason to `protection-fault`, drop metadata, re-decode RIP or reread the gate to reconstruct this code. Clear transient producer provenance with the corresponding diagnostics on new work, import/reset and unrelated producers; a later Unmapped/Permission/AddressRange failure must not inherit the earlier #GP. Once copied into a pending event, the saved source/error code retains its existing checkpoint/resumption lifetime independently of those transient diagnostics.

Independent raw descriptor examples, in byte order (all unmentioned byte values are literal):

- Gate32, DPL3/P1, target CS08/offset2000, count3: `00 20 08 00 03 ec 00 00`.
- Gate16, DPL3/P1, embedded selector000b/offset3456, count1, ignored high offsetabcd: `56 34 0b 00 01 e4 cd ab`.
- IA32e gate64, DPL3/P1, target CS08/RIP00000001_23456789, ignored count byteff: `89 67 08 00 ff ec 45 23 01 00 00 00 00 00 00 00`.

## privilege stacks and frame geometry

JMP and same-CPL/conforming CALL do not read TR/TSS or copy parameters. Count0 in an inner legacy CALL reads no old parameter bytes or old-SS parameter geometry. All applicable return-frame writes still occur.

For an inner legacy CALL, validate the current cached TR as the existing privilege-stack consumer does: valid, nonnull global selector, present system busy16/32 TSS, with the selected complete SS/SP field extent inside its cached limit. No new LTR, TSS-descriptor refresh, busy write or task-register publication occurs. Read new SS16 **first**, then SP16/ESP32:

| cached TSS         | pointer offset for destination CPL d | pointer width | SS offset | required last byte |
| ------------------ | ------------------------------------ | ------------- | --------- | ------------------ |
| busy16             | 2+4d                                 | 2             | 4+4d      | 5+4d               |
| busy32             | 4+8d                                 | 4             | 8+8d      | 9+8d               |
| busy64, IA32e only | 4+8d                                 | 8             | none      | 11+8d              |

The complete cached-field-limit check precedes either legacy field read. New SS must be nonnull, in its selected table, writable data, with RPL=DPL=new CPL. Invalid selector/type/privilege gives #TS(new SS), absent SS gives #SS(new SS). This is **not** RETF's #GP admission rule. Bad cached TR/field limit or an IA32e noncanonical TSS field address gives #TS(TR); private system-domain/backing/page failures retain their widened access provenance. TSS reads are `tss-read`, with table `tss` and TR selector reference.

IA32e inner CALL reads only the selected RSPn qword, without IST or an SS descriptor read. Force new SS selector to the new CPL (null index/TI0); preserve old hidden SS cache fields with usable=false, set its loaded DPL to new CPL, and otherwise retain the current null-SS checkpoint policy. Destination stack semantics are long64/base0/64-bit pointer regardless of old SS.B. Same-CPL64 CALL retains SS entirely and uses the **full supplied raw RSP**, including compatibility-source upper bits, under those long64 stack semantics. This deterministic raw-bank rule is a private profile choice for hardware's undefined upper bits.

Do not align RSP to16. Check the actual pushed qword spans for canonical48; do not independently reject an initial RSP merely because its value is noncanonical. Initial RSP=`0000800000000000` can succeed when all required pushes fall below the hole. Initial RSP=`ffff800000000000` fails when subtracting touches the hole. A TSS **field address** and its **pointer value** have different validation rules. A whole-slot u64/domain overflow retains the existing widened private span failure rather than bytewise wrap.

Freeze old CPL/SS/pointer bank, source next-PC, gate width/count and selected target before payload publication, while retaining earlier read/walk effects in their stated order. Use the prospective destination stack context for frame geometry. Each pointer subtraction wraps at its selected stack-address width; each complete W-byte slot then has its normal unwrapped span checks. SP=0 is not a generic underflow failure. Do not replace independently wrapped slots with one contiguous frame span.

Frame push order and resulting layout:

| path                                 | push order                                          | final ascending slots                               |
| ------------------------------------ | --------------------------------------------------- | --------------------------------------------------- |
| same-CPL/conforming CALL, all widths | old CS, return PC                                   | return PC, old CS                                   |
| inner legacy CALL, count n           | old SS, old pointer, P[n-1]…P[0], old CS, return PC | return PC, old CS, P[0]…P[n-1], old pointer, old SS |
| inner64 CALL                         | old SS, old raw RSP, old CS, return PC              | return PC, old CS, old RSP, old SS                  |
| JMP through gate                     | no stack operations                                 | unchanged raw stack bank                            |

Every selector slot is a complete W-byte zero-extended write. Saved PC is the source completed next-PC truncated to gate W. Saved old pointer is low W bytes of the **raw** old bank: gate32 saves ESP32 even if old SS.B=16, gate16 saves SP16, and gate64 saves full RSP. The gate's argument count and DF do not change ESI/EDI/ECX or perform REP elements. Do not change FLAGS, numeric state, other GPRs or unrelated loaded segments beyond the existing instruction-begin/completion effects.

For a new legacy stack, zero-extend the captured TSS SP/ESP into the initial raw bank, then merge each wrapped pointer step at new SS.B. For an unchanged legacy stack, preserve its old upper bank bits. Qword stacks publish the full resulting RSP. Maximum legacy capacity is n+4 = **35 slots**, not the current event frame's ten or ordinary far CALL's two. This is transient bounded work; no persistent partial-copy/checkpoint state is introduced.

## parameter capture, faults and publication

For an inner legacy CALL, capture P[i] once in ascending i=0..n-1 at `(oldRawSP + i*W) & oldStackMask`, through old SS and old CPL. Require its full W-byte span; never wrap individual bytes or read count*W as one scalar/vector. Existing paged vector reads have a16-byte bound. DF does not reverse this selected capture order. Earlier page-table A updates from a capture may change later captures; parameters are not an instantaneous global RAM snapshot. After capture, later payload/descriptor aliases do not reread or change the captured values.

The following phases are normative for this selected private-memory profile. Tests must combine faults in different phases, rather than only testing isolated failures:

| order | phase and first selected failure                                                                                                                |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | existing budget/stop/event/debug arbitration and instruction byte/decode boundaries; no gate data work before reaching the instruction          |
| 1     | complete far operand capture and gate lookup/admission in the order above                                                                       |
| 2     | target code descriptor type/privilege/L-D/presence                                                                                              |
| 3     | for an inner CALL only, cached TSS and selected fields, then new legacy SS descriptor admission                                                 |
| 4     | CALL: geometry of **all** destination frame slots in push order; no parameter backing reads or destination W-permission probes yet              |
| 5     | gate target offset: legacy gate16 low16 / gate32 full32 against target limit; IA32e full gate RIP canonical48; #GP(0) on failure                |
| 6     | selected old parameter slot geometry+read, ascending; an earlier slot's physical refusal wins over a later slot fault                           |
| 7     | prepare target code descriptor A byte if captured A0, new legacy SS A byte if needed, then frame W admissions in push order at destination CPL  |
| 8     | existing all-participating-write dirty-metadata admission/publication; preserve the captured begun instruction even if its source becomes stale |
| 9     | nonfaulting payload: captured code A byte, captured new-SS A byte, frame slots in push order, then one complete context/GPR-target publication  |

JMP skips phases3/4/6 and all frame work. Same-CPL/conforming CALL skips phase3/6 and uses two slots regardless of gate count. Type/presence validation and target checks still occur. Code/stack limits do not cause speculative destination instruction fetch; a successful transfer to an unmapped target retires, and only a subsequent reached fetch can fail.

In phase4, legacy limit violations on a newly selected stack give #SS(new SS); unchanged-stack limits give #SS(0). Noncanonical64 touched stack spans give #SS(0), including forced-null new SS. Other existing private geometry/access refusals keep their typed diagnostics. In phase7 all source operands retain old CPL, all new frame admissions use the prospective destination CPL, and descriptor metadata uses supervisor provenance. Do not call an old-CPL generic write check for a new kernel stack.

Selector-bearing #GP/#NP/#TS/#SS error codes use selector & fffc, preserving TI and clearing RPL; EXT=0 for this synchronous instruction. Preserve selector/descriptor/target phases from existing far diagnostics: gate permission/type/presence and target-code permission/presence are descriptor-phase checks. Null/lookup extent errors retain selector phase; target/stack geometry errors retain target phase. GDT/LDT gate low/tail traffic is `descriptor-read` with original selector reference; do not label it an IDT `gate-read`/vector access. Target/SS descriptor A traffic is `descriptor-accessed-write`. Metadata failures retain complete address, width, failing byte, table, selector and paging physical phase. #PF alone updates CR2 through the existing owner.

All selected reads and payload destinations are captured before payload publication. The existing page walker still makes eager A updates; a later fault does not promise byte-identical RAM. All participating D updates must be admitted before any D/payload publication under the inherited owner. Retain captured physical fragments across descriptor/frame/page-table aliases, without a rewalk or faulting permission probe at commit. The new frame can overwrite its own PTE or a descriptor A byte; do not restore captured page/descriptor bytes afterward. Installed caches reflect their successfully captured loads, not rereads of aliased RAM.

On failure: no descriptor-accessed-byte/frame payload publication or new CS/SS/CPL/RSP/RIP publication, failed-instruction retirement0 and unchanged REP progress. Previously permitted page-table A/D effects, live predecessor outputs, incoming histories and the existing RF-begin boundary remain observable. Do not assert all frame/TSS/descriptor bytes unchanged if a retained page-table effect aliases them. Incoming RF clears at the existing reached instruction-begin frontier; a fault does not resurrect it. Discard every partial parameter/frame/dirty plan before handler entry, retry, import/reset or other private exit; a later owner's publication must not flush work from a failed gate.

On success: publish the prepared destination RIP and complete raw pointer together with CS/CPL/mode and, if switched, SS. Retire once. No stale generated local may overwrite them during redispatch. Inner entry retains DS/ES/FS/GS caches; matching outer RETF performs its existing loaded-cache cleanup. There is no direct gate/TSS write or TR update; permitted frame/descriptor/page-table aliases can still change the same RAM bytes. Only loaded target code/new legacy SS descriptors acquire descriptor A.

## returns, debug and lifecycle

RETF consumes only its own width and saved selector RPL, not the previous gate's identity/count. Preserve existing outer-return slot reads, descriptor validation, unwrapped cleanup-gap geometry and raw restored-pointer rule. For an outer `RETF imm16`, skip the inner copied parameter bytes before reading saved SP/SS, then apply the same unsigned byte cleanup to the restored outer stack using its new stack width. The adjusted restored pointer is not probed merely to validate RETF. An unmatched immediate or width is guest program behavior, not automatically repaired by the engine. A correctly matched gate32/count31 uses cleanup124; gate16/count31 uses62. Gate64 has no copied parameters and needs no implicit cleanup.

Observe actual successful instruction operand spans: far memory pointer read; each old parameter read under old SS; each frame write under its destination SS/context; existing RETF reads. Descriptor/TSS reads and descriptor/page A/D writes remain excluded from operand watchpoints under the bounded debug profile. Watchpoints compare the proper translated **linear** addresses, not physical aliases. Failed/tentative spans produce no current-instruction completion trap. Private refusals retain earlier SS-deferred causes for repair; a recognized architectural successor fault cancels that unselected history in report and delivery modes under the inherited debug contract. Aggregate multiple slots and TF once, with instruction PC at the gate CALL/JMP and resume PC/context at the completed destination. JMP has only its explicit pointer operand, not fictitious frame traffic.

The old observer's two old-stack writes at instruction width cannot represent gate execution. Obtain the actual admitted footprint or completion mask from the semantic preparation; do not reread gates/TSS after aliases commit, duplicate gate classification in the observer, or acquire a global tracing log. The unobserved path does not need debug-only allocations or metadata sampling.

A gate lookup is runtime data, never a compile/discovery assumption. Discovery does not read gate/target/TSS/parameters or prevalidate a future stack. Repeated same-source calls reread dynamic descriptors/body fields even when the target context and installed owner remain equal. GDT/TSS RAM edits do not refresh loaded LDTR/TR/segments by themselves. A descriptor edit matters next time that descriptor is architecturally consumed. Backing writes invalidate active/dormant executable aliases under the current owner; no second gate cache or broad GDT-as-code dependency is introduced.

Distinguish two source-change boundaries. Before instruction begin, required-fetch A effects retain the existing consumed-encoding/hierarchy checks and finite PagingRestart behavior; an abandoned decode has not performed gate data work or cleared RF. After begin, A/D effects from operand, descriptor, TSS, parameter or frame admission may make the source owner stale, but do not cancel/redecode the already captured CALL/JMP. Complete that captured gate when all required admissions pass, retire once and redispatch before a successor. If it faults, report its selected fault with the permitted memory effects and no retirement. Do not import a numeric operand helper's source-abort rule into far execution or select a different gate by redecoding already captured operand bytes.

Changed loaded execution facts use existing context selection and bounded owner reuse. Test retained middle entries, source and target aliases, A→B→A gate edits, ordinary-code↔gate reclassification, evicted owners/backing incarnations and exhausted context counters. No retained gate pointer or equal selector bypasses validity checks. Full ready/debug-pending checkpoints must reproduce resulting mode/CPL/null-SS/raw-stack state and pending numeric/event/debug history. Reset retains its current contract; no new public projection or machine-local gate state is required.

Keep existing budget/stop/IRQ/NMI/debug arbitration. Budget0 and stop-current do no dynamic gate work. All selected parameters belong to one bounded instruction, with no per-parameter yield/event poll or REP allowance consumption. Successful transfer completion is visible before destination budget/stop/fetch/resource outcomes; exhausted instruction budget wins before stop, otherwise stop-at-destination precedes fetch. A later resource/cache refusal must not replay the gate or its frame writes. IRQ/NMI/TF service uses the completed context when selected afterward. An implicit gate stack switch neither creates a new SS shadow nor clears NMI blocking/IF/NT/CR0.TS; successful completion consumes prior histories only under their existing rules.

## literal acceptance and falsification

Use independent raw descriptors, instruction bytes, guarded RAM and expected bank/frame values. Expectations must not call production descriptor/frame helpers. Applicable packets preserve all unrelated GPR/FLAGS, XMM, MXCSR, x87/MMX payloads/pending state, paging/fast-system banks and event/debug history. Mask only bits already defined as architecturally undefined by inherited contracts.

1. **Selection/width:** all source forms and widths, GDT/LDT, gate4/C, source CS.D16/32, target CS.D16/32, old/new SS.B16/32, both legacy TSS formats and IA32e compatibility/long64. Vary source offset away from gate offset, including noncanonical ignored m16:64 values; full pointer tails remain mandatory. Same selector reclassifies ordinary code→gate→ordinary code without recompiling guest meaning. Real/v8086 negative controls perform no gate reads.
2. **32-bit round trip:** protected32 CPL3, CS1b, SS23/B32, raw ESP4000; gate32 count3, target CS08/D32/CPL0, SS10/B32, TSS ESP9000; parameters `[A1,B2,C3]` at4000/4004/4008. `9A off32 sel16` at1000 completes at1007. Final ESP8fe4; ascending dwords are `[1007,1b,A1,B2,C3,4000,23]`. Matching `CA 0c 00` returns CPL3/IP1007/ESP400c. Repeat source `66 9A off16 sel16`: return PC1006 but the same dword frame. Verify callee parameter use before return, not only byte layout.
3. **Full bound:** counts0/1/31, gate16 and32; maximum frame70/140 bytes, with 35 complete slots. TSS pointer9000 yields final8fba/8f74 at count31; matching cleanup62/124 returns old4000 to403e/407c. Select a callee RETF width matching its gate independently of CS.D. Count0 succeeds with old parameter memory denied; same/conforming/JMP succeeds with TSS body denied.
4. **Independent wrap/raw banks:** old SS.B16/raw pointer12345678_0000fffe, gate32 count2, old SS limit1ffff: P0 is the complete4-byte spanfffe..10001; P1 starts0002. Saved old pointer is low32 raw value0000fffe in that example; repeat with raw low32abcdfffe to prove it is abcdfffe, notfffe. Use new TSS32 ESP12340008/new SS.B16 to verify zero-extended initial raw bank, wrapped per-slot subtraction and retained high bank. Include SP0, expand-down bounds, complete-slot u64 tails and noncontiguous physical pages. Kill contiguous-frame and per-byte-wrap implementations.
5. **64-bit geometry:** inner gate target2030, old CS1b/SS23/raw RSP4000, TSS RSP9003: final8fe3, qwords `[nextPC,1b,4000,23]`; no alignment, FLAGS or parameters. Same-CPL gate starts raw RSP9003 and finishes8ff3 with only `[nextPC,oldCS]`; `48 CB` returns to9003 without a TSS read. Repeat compatibility source with dirty upper RSP and source operand16/32; raw64 destination stack rules still apply. Count byteff is ignored and cannot select IST/old parameter reads. Test initial first-hole RSP with fully canonical pushed spans, its canonical-upper-half dual that touches the hole, and malformed target code L/D. Null-SS checkpoints/IRET/outer RETF remain usable under inherited roles.
6. **Privilege/diagnostics:** enumerate CPL/RPL/gate DPL and conforming/nonconforming target DPL0..3 for CALL and JMP. Include ignored embedded RPL, null versus LDT entry0, invalid LDTR/TR, P0 gate/target/newSS, wrong newSS type/RPL/DPL and every TSS field last-byte boundary. Combine wrong privilege+P0, target P0+bad TSS, new-stack geometry+bad target, bad target+unmapped parameters, early parameter refusal+later frame refusal. Assert exact vector/error/phase and absence of later traffic.
7. **Gate extent/tail:** legacy gate ends exactly at table/backing boundary. IA32e low8 fits but whole16 does not; denied/P0 low half with inaccessible/noncanonical tail; legal low half with tail #PF/private refusal/noncanonical span; separate original-low and target-code noncanonical spans naming their respective selectors, plus widened-domain overflow retaining its private failure. For the same noncanonical input, report mode preserves its complete system-memory diagnostic; positive instruction budget with `eventDelivery: { budget: 0n }` stores vector13/errorSelector; actual delivery writes that error to the handler frame. Instruction budget0 still prevents all gate work. Repeat with forward ordinary-code lookup (same new rule), RETF/LTR/unrelated metadata controls (inherited sources), a later private refusal (no stale source) and pending checkpoint/import/resume (captured source stable). Include nonzero upper type field, ignored unrelated fields and expanded LDT indexfff8/tail10000 versus GDTffff limit. Nonalias gate/TSS read-only, target/newSS A1 must succeed without a direct W probe of gate/TSS; typeC staysC in that fixture. Alias fixtures separately permit indirect changes to those bytes.
8. **Captured alias policy:** gate32/count1, old SP8000,arg11223344,new SP8008: copied argument at7ffc stays11223344 even though the saved-pointer write at8000 aliases the old argument. Count2/new SP800c with old `[A,B]` at8000/8004 gives copied A at7ffc/B at8000. Include different linear mappings of the same backing, DF1, parameter/descriptor-A aliases, overlapping frame slots, gate/target/SS/TSS/code aliases and an A0 descriptor byte overwritten later by the frame. Compare the exact chosen captured-publication result; do not label this a native alias oracle.
9. **Late refusals/page effects:** count31 last source slot, each destination slot, target/SS accessed-byte W refusal, dirty-metadata refusal and cross-page physical gaps. Expect no frame/descriptor payload or architectural transfer; compare whole RAM including permitted earlier A/D deltas. New supervisor stack succeeds with U/S0 from CPL3; old parameters on U/S0 fail with U=1; gate/TSS metadata on U/S0 remains supervisor. Exercise WP0/1, NX/NXE and non-PAE/PAE/IA32e error codes without misclassifying PAE as IA32e. Gate success to a denied target fetch retires once and faults only when that fetch is reached.
10. **Source/table self modification:** required-fetch A aliases consumed instruction bytes and must abandon/redecode before begin under the existing finite restart rules. Contrast a post-begin metadata walk whose present A0 PTE low byte13 aliases an already-fetched immediate gate-selector low byte13: the A update changes it to33, but this CALL still completes captured gate13, not a newly decoded gate33. Use different valid destinations and A-prefilled instruction-fetch tables so mutation occurs only during the metadata work. A0-present-PTE alias to even opcode9A is not a valid construction. Cover both successful and faulting post-begin cases, frame/descriptor payload aliases to active/dormant code and frame payload aliasing its own PTE. Retain captured physical destinations, observable actual-width A/D effects and successor redispatch. A fault/redispatch cannot duplicate a committed gate or change its captured arguments.
11. **Completion:** dirty live source GPRs/FLAGS/XMM/raw80; indirect EA using SP; retained middle entry; last budget, REP budget0, stop-current/target, post-transfer resource refusal, #PF handler repair+IRET retry. TF plus multiple matching pointer/parameter/frame watchpoints aggregates once at destination; GDT/TSS-only watches do not. Faulting plans have no new completion hit. Cover old SS-deferred causes, queued IRQ/NMI while shadowed, NMI blocking, checkpoint/import/reset and ordinary cache caps.

The implementation mutation campaign must make each nontrivial boundary falsifiable. Mutants include source-width frames, target-D parameter width, count truncation at10, copying parameters for count0/same/JMP/64, old-CPL new-frame checks, supervisor old-parameter reads, gate A/busy writes, extra FLAGS/IST/alignment, initial-RSP-only rejection, lost raw ESP high16, contiguous/wrapped-byte capture, wrong capture/publication order, descriptor reread after alias, D or payload before complete admission, fresh commit walks, guessed two-slot debug masks, premature debug hits, stale gate/TSS/owner reuse, wrong RETF cleanup, target overwritten by source next-PC, double retirement and replay. Count only named unchanged semantic assertion failures, not compile errors, arbitrary traps or timeouts. Mutants and old inputs must be restored before the final gate/artifact freeze.

## implementation owners, style and order

Keep behavior with existing owners; these are affected responsibilities, not a prescribed new tree or framework:

- [far semantics](../../src/x86/protection/far.rs), descriptor/access and TSS consumers: distinguish ordinary code, selected gate and unselected task handlers; prepare prospective context, slots and captures. Share appropriate lookup/stack facts, not the whole interrupt-entry algorithm. Existing CALL and RETF admission differ and must not be unified by changing their exception classes.
- [GuestMemory](../../src/x86/access.rs) and [paged memory](../../src/x86/paging/access.rs): preserve ordinary/system/prospective-frame access provenance, captured physical fragments, A/D and nonfaulting publication. Do not widen all scalar reads/state banks for a124-byte parameter block.
- [far bridge](../../src/embedding/exports/far_control.rs), [operand observation](../../src/x86/protection/operands.rs) and [lowering](../../src/dbt/wasm/far.rs): carry actual prepared outcomes/footprints, live locals, one completion and context redispatch. Extend the narrow contract that needs it instead of adding an independently mutable gate authority.
- Native tests stay beside the semantic/memory/debug owner; shared public literal packets extend [far-control execution](../../tests/execution/far-control/index.ts) and applicable paging/event/debug groups. The existing Node/Chrome runners execute them. No browser UI workflow or provider API is required.

Use existing Rust typed outcomes and early `Result` failures, not host-side exception interpretation or a whole-state-copy workaround. Existing style:

```rust
let lookup = Lookup::resolve(context, selector)
    .filter(|lookup| lookup.fits(8))
    .ok_or_else(|| selector_fault(selector, 13, ProtectionPhase::Selector))?;
```

Implement in reviewable dependency order: (1) independent literal native/public gates and width/lookup failures; (2) same/conforming CALL/JMP and gate classification; (3) legacy inner TSS/parameter capture/bounded frames and RETF round trips; (4) IA32e inner/same stack geometry and null-SS lifecycle; (5) paged provenance/A-D/alias/source-validity and exact debug footprints; (6) repair/reuse/checkpoint integration, adversarial mutations, final performance and independent cross-review. All are required for delivery; intermediate commits/slices do not narrow the agreed cohort. Tests must demonstrate the relevant failure before the corresponding fix, and commits should be individually reviewable.

## commands, performance and completion

Existing commands, from repository root:

```sh
npm run format:check
npm run lint
npm run typecheck
cargo test --locked
npm run build
npm test
npm run test:browser
npm run check
```

Use scoped native/public checks while developing and the complete `npm run check` at final production source. Independent expectations include literal frame/selector/error packets and a bounded standalone frame/round-trip oracle expressed without production decode/descriptor/stack helpers. Its minimum legacy domain is both W2/4, every n0..31 and both old/new SS.B16/32 combinations, plus the selected raw-bank/wrap/alias literals and64-bit cases. Run both public runtimes; native-only semantics or static arithmetic is not emitted-Wasm evidence.

Freeze the built predecessor and final Core/host/benchmark fixtures with exact source/hash provenance. Preserve the [recovery protocol](../five-spec-integration/performance-recovery.md): both recovered x87/MMX kernels and five matched IA32e kernels are mandatory no-spillover controls, alongside unchanged ordinary far CALL/JMP/RETF, syscall/IRET, short-resume and context-owner workloads. For example:

```sh
node scripts/benchmark.mjs --baseline BUILT_BASELINE --workloads x87-stack-churn,mmx-x87-emms --iterations 1000001 --samples 17 --output build/verification/call-gates-x87-node.json
node scripts/benchmark.mjs --baseline BUILT_BASELINE --workloads x87-stack-churn,mmx-x87-emms --browser --reverse --iterations 1000001 --samples 17 --output build/verification/call-gates-x87-chrome.json
node scripts/paging-latency-audit.mjs --baseline BUILT_BASELINE --current . --iterations 100001 --samples 18 --output build/verification/call-gates-paging-node.json
node scripts/paging-latency-audit.mjs --baseline BUILT_BASELINE --current . --browser --reverse --iterations 100001 --samples 18 --output build/verification/call-gates-paging-chrome.json
node scripts/check-x87-raw-store-oracle.mjs --current . --output build/verification/call-gates-raw-store.json
```

Newly executable gates have no executable predecessor denominator: characterize same/conforming/inner, W2/4/8, count0/1/31, source/target stack widths and memory families, first-use target-CS/new-legacy-SS descriptor A0 versus A1 separately from cold/warm page-table A/D, context-equal versus round-trip reuse, debug miss/hit, aliases/repair and short resumptions. A gate descriptor has no A0/A1 accessed state. Validate the complete guest result and effective retired work outside timing; report copied bytes, successful calls, source/system/frame operations and generated/cache resources with explicit counting scope. Parameter copy has zero repeat elements. Separate first compile/creation from warm and control actual effective caps. Do not subtract a syscall/INT path into claimed gate cycles or compare a gate result to old Unsupported latency.

Serialize timing without builds/guest workloads from other agents. Reproduce suspected regressions with paired snapshots, reversed order and A/A before attribution; retain zero/sub-resolution observations as undefined ratios, not floored or selectively omitted denominators. Check emitted code/inlining/helper work when source changes unexpectedly affect unrelated kernels. Avoid new per-instruction gate/descriptor checks, imports, allocations or large bank copies in code without selected far operations. Do not claim a speedup, native cycles or whole-application performance from static sizes or one synthetic loop.

Completion requires every selected form/profile and positive/negative packet above, complete generated/public execution and finite independent expectations, reviewed fault/alias/debug/publication behavior, semantic mutation evidence, full final checks, source/artifact identities and bounded timing conclusions. Unsupported selected call gates, a capped parameter count, missing paged/observed consumers, an unfinished alias/cleanup policy or unexplained repeatable control regressions block completion. Hardware task gates/returns and native overlapping-stack/microcode equivalence are explicitly outside this selected contract. README, dependencies and unrelated interfaces are not part of the change. Implementation/commit/push are not performed by this specification-preparation task.

## primary references

Inspected Intel SDM **093, September2026**, refreshed against the [official manual portal](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html). Use the detailed CALL/JMP/RET operations and cross-check Vol3A §§6.8.3–6.8.6/Table6-2; do not transplant INT's stack rules. The snapshot hashes below identify the PDFs used, not a promise that a latest-content URL will remain immutable.

| source                                                                | selected sections                                                            | inspected PDF SHA256                                               |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [Vol2A, 253666-093](https://cdrdv2.intel.com/v1/dl/getContent/671199) | CALL gate admission/MORE-/SAME-PRIVILEGE, JMP CALL-GATE and exception tables | `87c5acb6f27e24d9d364841a0d2346c91a8482e36f403409954e2d2a8c817bac` |
| [Vol2B, 253667-093](https://cdrdv2.intel.com/v1/dl/getContent/671241) | RET far/outer-return operations and cleanup                                  | `a261998ace8e07f624bf3e2486bb6cfe950fb8be8d0dc9631bcecb4c5ec953e4` |
| [Vol3A, 253668-093](https://cdrdv2.intel.com/v1/dl/getContent/671190) | call-gate formats/privilege/stack switching/return, Table6-2                 | `310c6a64513e8095abfc32b6a158539560f499d53444050343022f7dda240211` |

Resolve the same-CPL64 narrative's loose stack-switch wording with the detailed two-slot CALL operation and Table6-2's explicit CPL-change frame. Resolve JMP's ambiguous `DEST(Offset)` pseudocode notation with §6.8.4's gate indirection: the encoded operand offset is unused. These are documented source readings, not permission to copy narrative shorthand into behavior. This preparation establishes a reviewed contract; it does not establish implementation, runtime conformance or native-hardware proof.
