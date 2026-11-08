# mmx and numeric state images

extend [x87 state and execution](../x87-state-and-execution/spec.md), [SIMD integer and data](../simd-integer-and-data/spec.md) and [SIMD floating point and controls](../simd-floating-point-and-controls/spec.md) with MMX execution and guest numeric save/restore. a guest must be able to save a numeric context, run another one, and restore the first through ordinary decoded instructions, including within one generated region and at retained middle entries.

use all fourteen imported profiles under the existing enabled numeric view: MMX, SSE, SSE2 and FXSR available; CR0.EM/TS clear, CR0.NE set, CR4.OSFXSR set, and fast-FXSAVE EFER.FFXSR clear. retain deprecated/zero FCS/FDS selectors and non-deprecated FDP. these assumptions do not add CPUID, guest control writes, #NM, architectural reset, task switching or handler delivery. construction defaults and host checkpoints remain separate from guest images.

MASKMOVQ, MOVNTQ, fences, 3DNow!/FEMMS, SSE3 and later operations, XSAVE/XRSTOR variants and wider state remain separate work. x87 remainder/exponent, transcendental and packed-decimal execution remains in `x87-special-functions`. this selection closes the stated MMX and legacy image forms, not the whole numeric or system architecture.

## one physical numeric state

MM0–MM7 name bits0–63 of physical x87 R0–R7, independently of TOP and tags. do not introduce another architectural MMX bank or a persistent MMX-mode flag. host `readX87State`/`setX87State` already expose these bits; no new public MMX projection is needed. every raw payload, including an empty slot, remains observable through that existing projection.

successful selected MMX execution sets TOP=0 and all physical tags valid (`0000`), except EMMS, which sets TOP=0 and all tags empty (`ffff`) in this profile. writing an MMX destination also sets that bank's bits64–79 to `ffff`; reading an MMX source or storing it to memory leaves its full payload unchanged. preserve other SW bits, CW, pointers/FOP, MXCSR and EFLAGS unless the particular conversion below updates MXCSR. EMMS preserves all payloads and other numeric fields; it is not FNINIT. capture sources before clearing TOP or overwriting an aliased destination.

these operations do not inspect raw80 classes or report x87 stack underflow/overflow merely because tags are empty or inconsistent. pending x87 exceptions are different: selected MMX instructions, including EMMS, check existing pending state after inherited fetch/decode/legality and before data access or transition effects. return the existing exclusive `x87-exception` at the checking PC with zero retirement and unchanged destinations. the CVTPI2PD memory exception to this rule is explicit below. neither MMX nor EMMS updates saved x87 pointers/FOP.

## selected encodings

opcode numbers are hexadecimal; byte widths and lane indices are decimal. NP below selects the legacy no-mandatory-prefix form. the existing mandatory-prefix rules still route `66` integer forms to XMM instructions; they must not accidentally select MMX. inherit segment/address-size, prefix ordering, REX cancellation, required-byte fault and 15-byte rules.

| forms                     | encodings and operands                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| MOVD / long64 GPR MOVQ    | NP `0F 6E/7E`, MMX ↔ GPR/m32; effective long64 REX.W selects GPR/m64                           |
| MOVQ                      | NP `0F 6F/7F`, MMX ↔ MMX/m64; REX.W does not change its width                                  |
| bitwise                   | NP `0F DB/DF/EB/EF`: PAND/PANDN/POR/PXOR                                                       |
| wrapping add/sub          | NP `0F FC/FD/FE/D4`: PADDB/W/D/Q; `F8/F9/FA/FB`: PSUBB/W/D/Q                                   |
| saturating add/sub        | NP `0F EC/ED/DC/DD`: PADDSB/W, PADDUSB/W; `E8/E9/D8/D9`: PSUBSB/W, PSUBUSB/W                   |
| comparisons               | NP `0F 74/75/76`: PCMPEQB/W/D; `64/65/66`: PCMPGTB/W/D                                         |
| min/max/average           | NP `0F DA/DE/EA/EE/E0/E3`: PMINUB/PMAXUB/PMINSW/PMAXSW/PAVGB/PAVGW                             |
| products and reduction    | NP `0F D5/E5/E4/F4/F5/F6`: PMULLW/PMULHW/PMULHUW/PMULUDQ/PMADDWD/PSADBW                        |
| packing                   | NP `0F 63/6B/67`: PACKSSWB/PACKSSDW/PACKUSWB                                                   |
| unpacking                 | NP `0F 60/61/62/68/69/6A`: PUNPCKLBW/LWD/LDQ/HBW/HWD/HDQ                                       |
| immediate shuffle         | NP `0F 70 /r ib`: PSHUFW                                                                       |
| variable shifts           | NP `0F D1/D2/D3/E1/E2/F1/F2/F3`: PSRLW/D/Q, PSRAW/D, PSLLW/D/Q; MMX or m64 count               |
| immediate shifts          | NP `0F 71/72/73 /2,/6 ib`: PSRLW/D/Q, PSLLW/D/Q; `/4` only for 71/72: PSRAW/D; MMX destination |
| insertion/extraction/mask | NP `0F C4/C5 /r ib`: PINSRW/PEXTRW; NP `0F D7 /r`: PMOVMSKB                                    |
| MMX/XMM copies            | `F2 0F D6 /r`: MOVDQ2Q MMX,XMM; `F3 0F D6 /r`: MOVQ2DQ XMM,MMX; register-only                  |
| empty MMX state           | NP `0F 77`: EMMS, no ModR/M                                                                    |

ordinary binary forms have MMX destination and MMX/m64 source. immediate shifts, PEXTRW, PMOVMSKB and MMX/XMM copies require their documented register classes; reject a memory class at ModR/M before unrelated address tails. PINSRW reads a GPR's low16 bits or m16, then uses `imm8 & 3`; PEXTRW extracts `imm8 & 3` into a zero-extended 32-bit GPR result. PMOVMSKB produces an 8-bit mask with the same GPR write semantics. PSHUFW uses four independent 2-bit selectors. every MMX bank field uses its low three encoded bits: REX does not create MM8–MM15. apply REX.R/B to actual GPR/XMM fields and B/X to memory addressing; opcode-extension fields are not extended banks.

MOVD into MMX zeroes bits32–63; a 64-bit move replaces all low64 bits. MMX destination writes then install the `ffff` high marker. GPR destinations follow existing 32/64-bit write rules, including non-long64 preservation above32 bits. MOVDQ2Q copies XMM low64; MOVQ2DQ copies MMX low64 and clears the destination XMM high64. both have the MMX transition effects above, even when the destination is XMM. register copies do not imply a numeric conversion.

integer meanings match the existing packed-lane contracts at a 64-bit bank width. no cross-lane carry is introduced. packs concatenate the narrowed old-destination half and source half; unpacks select halves of a 64-bit bank. PMULUDQ multiplies dword0 only and returns one qword. PSADBW returns one zero-extended qword sum of eight unsigned byte differences. PMADDWD's double `-32768 * -32768` pair wraps to `80000000`; no saturation or numeric status is added. variable shift counts use the complete unsigned64-bit count, not its low byte or a modulo-lane-width mask. zero and oversized counts still execute the MMX transition.

memory forms access exactly their declared 2/4/8-byte span and have no extra SIMD alignment requirement. stores need W, not destination R. preserve inherited full-span private preflight, fault atomicity, ascending aliased-byte order, identity-store invalidation and code-write restart. unsupported neighboring forms remain unsupported; invalid encodings of selected forms, including LOCK, retain the inherited deciding-byte and legality ordering.

## MMX and SIMD conversions

add these six legacy forms with existing exact signed-i32 and SSE numeric rules. no conversion passes through host Number or applies x87 PC/RC. each uses MXCSR where rounding or numeric status is relevant; truncating forms ignore RC, and conversion to f64 is exact. none raises DE. unused source lanes do not participate.

| instruction          | encoding, source and destination                                          | numeric conditions | successful x87 effects                                                                             |
| -------------------- | ------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------- |
| CVTPI2PS             | NP `0F 2A /r`, two i32 from MMX/m64 → low two f32 in XMM; preserve high64 | PE                 | all forms check pending first, then TOP0/tags0000; source payload unchanged                        |
| CVTPI2PD             | `66 0F 2A /r`, two i32 from MMX/m64 → two f64/full XMM                    | none               | MMX source checks pending and transitions; m64 source neither checks pending nor changes x87 state |
| CVTPS2PI / CVTTPS2PI | NP `0F 2D/2C /r`, low two f32 from XMM/m64 → two i32 in MMX               | IE/PE              | all forms check pending, then TOP0/tags0000 and destination high16=`ffff`                          |
| CVTPD2PI / CVTTPD2PI | `66 0F 2D/2C /r`, two f64 from XMM/m128 → two i32 in MMX                  | IE/PE              | same MMX destination transition                                                                    |

the f64 memory sources require the inherited 16-byte alignment and full16-byte access. other memory sources use8 bytes without that alignment. REX.W does not widen the integer lanes. for `2A`, ModR/M.reg is XMM and may use REX.R; register r/m is MMX and ignores REX.B. for `2C/2D`, reg is MMX and ignores REX.R; register r/m is XMM and may use REX.B. memory address extensions remain effective.

masked invalid lanes produce signed-i32 indefinite `80000000`; otherwise use exact per-lane results, reportable conditions and priority from the SSE conversion contract. an unmasked SIMD condition uses existing pre/post-computation `simd-exception`, publishes the permitted MXCSR status, preserves the complete XMM/MMX destination, raw80 bank, TOP/tags and environment, and retires zero at unchanged RIP. do not publish a speculative MMX transition before a source fault or #XM. masked outcomes publish the whole instruction once. successful or faulting conversions preserve EFLAGS.

## guest environment and state instructions

| instruction          | encoding                                | image                                     | pending check                      |
| -------------------- | --------------------------------------- | ----------------------------------------- | ---------------------------------- |
| FLDENV               | `D9 /4`, memory-only                    | environment14/28                          | waiting; old pending before memory |
| FNSTENV              | `D9 /6`, memory-only                    | environment14/28                          | no-wait                            |
| FRSTOR               | `DD /4`, memory-only                    | environment plus eight raw80 slots:94/108 | waiting; old pending before memory |
| FNSAVE               | `DD /6`, memory-only                    | environment plus eight raw80 slots:94/108 | no-wait                            |
| FXSAVE / FXRSTOR     | NP `0F AE /0,/1`, memory-only           | nominal512-byte FX area                   | neither reports old pending #MF    |
| FXSAVE64 / FXRSTOR64 | long64 effective REX.W + previous forms | FX area with 64-bit pointers              | same no-wait behavior              |

FNSTENV stores the old environment before masking CW bits0–5. it preserves payloads, physical tags, TOP, pointers/FOP and the remaining CW bits; this profile preserves its architecturally undefined C0–C3. refresh ES/B after the mask change. FNSAVE stores the old environment and logical stack, then performs the existing FNINIT state change, preserving the physical payload bytes while resetting CW/SW/tags and pointers/FOP. neither save's post-effect occurs on failed admission/publication.

FLDENV loads environment controls/metadata and tags without replacing raw payloads. FRSTOR additionally loads all eight raw80 slots. FXSAVE changes no architectural numeric field and does not mask or clear pending state. FXRSTOR replaces the selected x87/XMM/MXCSR fields. a successful load may install pending x87 status, but only a later waiting x87/MMX instruction detects it. FXRSTOR also does not deliver a SIMD exception merely because the loaded MXCSR already has an unmasked sticky bit; the next numeric operation uses ordinary occurrence rules.

FSTENV and FSAVE assembler spellings are standalone WAIT (`9B`) followed by the FN instruction. retain separate PCs, budget/stop boundaries and retirements. no eager lookahead or fused wait/save operation is allowed. all image instructions are control operations for x87 metadata: save does not replace the saved producer pointer/FOP with its own PC/address; restore installs the image's supported metadata fields without a later helper epilogue overwriting them.

### legacy layouts

image width follows inherited 16/32-bit operand-size rules, including `66` and CS.D. long64 defaults to the 28/108-byte form; without an effective REX.W, `66` selects14/94. effective REX.W selects the existing 28/108-byte form even with `66`, not a new64-bit legacy layout. prefix ordering and REX cancellation remain effective. address size, segment selection and effective offset are independent of image size. use the real layout in real/v8086 and the protected layout in protected/compatibility/long64 contexts.

all byte offsets below are decimal, all fields little endian. serialize the defined fields; choose zero for unused bits within a written word/dword and preserve wholly reserved bytes. selector-deprecated FCS/FDS fields save zero and their loaded values are ignored. neither instruction loads guest segment state.

| environment   | fields                                                                                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| protected14   | CW16@0, SW16@2, physical TW16@4, FIP16@6, FCS16@8, FDP16@10, FDS16@12; no FOP field                                                                                                |
| protected28   | CW16@0, SW16@4, TW16@8, FIP32@12, FCS16@16, FOP11 in word@18, FDP32@20, FDS16@24; preserve bytes2–3,6–7,10–11,26–27                                                                |
| real/v8086 14 | CW16@0, SW16@2, TW16@4, FIP low16@6, word@8=`((FIP>>16)&0xf)<<12 \| (FOP&0x7ff)`, FDP low16@10, word@12=`((FDP>>16)&0xf)<<12`                                                      |
| real/v8086 28 | CW16@0, SW16@4, TW16@8, FIP low16@12, dword@16=`((FIP>>16)&0xffff)<<12 \| (FOP&0x7ff)`, FDP low16@20, dword@24=`((FDP>>16)&0xffff)<<12`; preserve the high16 at offsets0,4,8,12,20 |

pointer truncation follows the selected layout, not the host pointer size: protected14 retains16 offset bits, real14 retains20 linear bits, and the 28-byte layouts retain32 bits. reconstruct pointers by the inverse packing, zero-extending omitted high bits. protected14 does not encode FOP; this profile preserves the existing FOP when loading it rather than inventing a field. loading arbitrary full tag codes is not a raw host checkpoint import.

94/108-byte images append eight10-byte payloads at `environmentSize+10*i` in logical ST(0)…ST(7) order. the tag word remains physical. saving uses the saved TOP to select each physical source; restoring uses the loaded TOP to place each logical payload at physical `(TOP+i)&7`, including empty slots. do not reorder the physical tag bits with the payload slots.

for environment/full-image restoration, image tag `11` marks a physical bank empty; any other code requests nonempty and the full tag is reconstructed by the existing raw80 classification, using the existing payload for FLDENV and the restored payload for FRSTOR. a save preserves empty/nonempty identity and serializes the matching full classification for nonempty payloads in this profile. saving must not normalize the canonical raw payloads or change their in-memory physical tags as a side effect. fixtures must include host-imported tag/payload disagreement.

### FX layout and field effects

the selected FX encodings are NP, optionally with effective long64 REX.W. `66`, F2 and F3 refining-prefix forms remain unsupported in this selection; do not reinterpret them as 14-byte images or classify their omission as a universal hardware #UD. REX.W affects pointer format only in long64. address-size and segment overrides retain their normal meaning. require a translated16-byte-aligned start. save/restore XMM0–15 in long64 regardless of REX.W, and only XMM0–7 in other profiles. preserve inaccessible upper banks in both canonical state and live generated values.

| offset   | selected field                                                                                      |
| -------- | --------------------------------------------------------------------------------------------------- |
| 0,2,4,6  | CW16, SW16, abridged physical FTW8, FOP11 in a16-bit word; byte5 is reserved                        |
| 8,16     | FIP/FDP64 with REX.W; otherwise FIP/FDP32 plus zero/deprecated selectors16@12/20 and unused16@14/22 |
| 24,28    | MXCSR32 and MXCSR_MASK32=`0000ffff`                                                                 |
| 32+16*i  | logical ST(i) raw80 in bytes0–9 of each slot; preserve the six padding bytes                        |
| 160+16*i | XMMi raw128; i=0…15 in long64 or0…7 otherwise                                                       |
| 416…511  | reserved/software tail: preserve every byte on save, ignore content on restore                      |

outside long64, preserve/ignore bytes288…415 as well. save the FOP word's upper five bits as zero and ignore them on restore; canonical FOP remains11 bits. ignored bits/bytes are not implicit zeros, registers or executable dependencies. FXRSTOR ignores image MXCSR_MASK; validate loaded MXCSR against the supported mask `0000ffff`, not against attacker-supplied MASK bits. reserved MXCSR bits cause the existing exclusive `general-protection` / `generalProtectionFault` with cause `mxcsr-reserved-bits` and the loaded32-bit value. it is not an x87 exception.

FX FTW bitj corresponds to physical Rj: 0=empty,1=nonempty. the raw80 slots remain logical ST(i). restore payloads using loaded TOP, then reconstruct each nonempty physical tag from its payload; preserve every payload in empty slots too. FX save emits only the nonempty bits, without converting raw80 or changing canonical full tags. non-REX.W pointer restoration zero-extends the32-bit offsets; deprecated selector values in an image do not become canonical segment selectors.

all restore forms load CW and the supported SW bits, then derive ES/B from `SW & ~CW & 3f`, ignoring supplied summary bits `8080`. do not reject a guest image using strict host-checkpoint validation before this normalization. retain all other SW bits and the existing full16-bit CW policy. host `setX87State` continues to reject inconsistent ES/B; a state generated by these instructions remains a valid public checkpoint.

## memory, publication and generated execution

retain the existing private-memory profile: validate nominal14/28/94/108/512-byte operand geometry and required R/W mapping permissions before any image or numeric effect. source admission requires R; destination admission requires W only. for FX forms use context/segment and address-domain checks, then alignment, then mapping admission, matching the existing enabled SIMD ordering. report complete nominal widths in faults; FX alignment diagnostics use width512 and alignment16. LOCK/encoding failures and prior waiting #MF checks precede these data operations.

nominal admission and actual effects are separate. the full-area policy does not claim that hardware probes every unused byte; an unmapped reserved tail may fail admission in this private profile even though its content is ignored. actual transfers are field-specific: never read/serialize reserved fields as register values, write padding/tails/inactive XMM slots, or invalidate executable aliases belonging only to untouched bytes. no destination R permission is needed to preserve an omitted field. use the existing memory/source owner for preflight, selected writes and aggregate invalidation rather than bypassing it with direct backing access.

capture all image source bytes or numeric source values before publishing any destination. aliases may map ascending guest slices onto overlapping backing slices; retain ascending-linear write order for actual stored fields and aggregate every affected source owner. on failed private admission or invalid restored MXCSR, preserve the instruction's entire incoming numeric/scalar state, guest bytes and source validity, while retaining completed predecessor effects. this is the selected deterministic private-fault policy; hardware descriptions permitting partial image stores/restores are not universal rollback guarantees. no REP-style partial-image progress or new repetition allowance is introduced.

image helpers must observe preceding in-region XMM/MMX/x87 changes, not stale canonical copies. restoration must replace subsequent readers' values and the values eventually published by the region. a later statically selected XMM writer that is skipped must not overwrite a restored value at exit. failed restoration must preserve live predecessor values. cover branch paths that skip a restore and retained entry points that do not execute its predecessors. this contract does not prescribe unconditional whole-bank spilling, another effect IR or another architectural state cache.

every successful selected instruction retires once and advances RIP before handling completed code-writing effects. image loads do not write guest bytes or invalidate executable owners. stores that modify successors publish all permitted image bytes, FNSTENV masking/FNSAVE initialization and one retirement before existing code-write restart. budget, next-PC stop and subsequent dispatch preserve their inherited priority. budget0, stop at the current PC, resource refusal, eviction and transient diagnostic clearing retain existing behavior; none may clear pending numeric state or speculate an unexecuted transition.

keep the five-argument generated entry ABI and existing scalar/XMM/MXCSR/raw80 host projections. no image helper may route every memory operation through a JavaScript callback. GP-only regions must acquire no MMX/image snapshots, locals or per-instruction status materialization. changed idle imports and restored controls at a retained entry remain invocation inputs, not recompilation constants. numeric restore alone changes neither the execution-context version nor executable-source validity; changed image bytes must be observed as data without requiring retranslation.

## independent acceptance packets

unless stated otherwise, use long64, enough resources, one-instruction budgets, flags=`cd7`, distinct raw physical banks and XMM values, and guards around operands. hex values are hexadecimal; byte widths and slot indices are decimal. compare all projections, complete memory/guards, exclusive diagnostics, RIP and both budget pairs. masks for undefined outputs must be explicit.

| packet                                                                                  | required observation                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TOP5, partial tags, R0 and R5 distinct; MOVQ MM1,MM0                                    | read physical R0, write R1 low64/high16=`ffff`; TOP0/tags0000; R5 unchanged                                                                                                                              |
| same state; MOVQ m64,MM0, then EMMS in a separate run                                   | store physical R0 without changing its payload; store transitions TOP/tags; EMMS empties tags and TOP0 without clearing any payload/CW/other SW                                                          |
| standalone EMMS with imported TOP5 and partial tags, without a preceding MMX operation  | TOP becomes0 and tagsffff under this profile; all physical payloads, other SW, CW and environment metadata survive                                                                                       |
| MOVD to MM0 from `ffffffff`; PINSRW word index5; PEXTRW/PMOVMSKB                        | MOVD low64=`00000000ffffffff`; marker=`ffff`; immediate index5 selects word1; GPR32 publication and raw80 aliasing checked                                                                               |
| zero/oversized shift or identical-register operation on an empty tag                    | result follows lane rules and the MMX transition still occurs; no x87 stack exception                                                                                                                    |
| pre-existing pending ZE; missing MMX memory source, or EMMS                             | #MF before data/transition; clear via FNCLEX and retry without recompilation                                                                                                                             |
| CVTPI2PD m64 of `(1,-2)` under pending ZE                                               | exact f64 `3ff0000000000000,c000000000000000`; x87 completely preserved; next EMMS detects the pending state. CVTPI2PS m64 instead detects it before memory                                              |
| CVTPI2PS `(16777217,-16777217)`, source64=`feffffff01000001`                            | RN/RZ lanes=`4b800000,cb800000`; RD=`4b800000,cb800001`; RU=`4b800001,cb800000`; PE. PM clear faults with destination/high half and all x87 state preserved                                              |
| CVTPS2PI `(QNaN7fc12345,1.5)`                                                           | masked RN low64=`0000000280000000`, high16=`ffff`, IE/PE and MMX transition. IE unmasked: pre-stage IE only; IE masked/PE unmasked: post-stage IE and PE; both fault cases preserve x87/XMM destinations |
| FNSTENV with pending state and nonzero TOP                                              | image contains old CW/SW; only after store does CW gain3f and ES/B clear; raw banks/tags/TOP unchanged. failed last-byte admission does not mask                                                         |
| FNSAVE with logical/physical order distinguished, including empty payloads              | old environment and eight logical payloads saved, then FNINIT-equivalent controls with all raw payloads retained. late fault prevents bytes/reset/invalidation                                           |
| R0 raw zero but imported tag00; other banks empty, TW=`fffc`; FNSTENV                   | image TW=`fffd` by classification; canonical TW remains`fffc` and raw bytes unchanged. FXSAVE instead emits abridged FTW=`01`                                                                            |
| FLDENV / FRSTOR / FXRSTOR with CW037b, imageSW0004; reverse case CW037f/imageSW8080     | first restores SW8084 and next WAIT detects ZE; second restores SW0000 and WAIT succeeds. repeat with independently wrong ES-only/B-only bits                                                            |
| loaded TOP5; nonempty image tag paired with zero, normal, special and unsupported raw80 | reconstruct physical tags from the corresponding payload; image tag11 remains empty even with nonzero payload. FLDENV uses existing payloads, full restore uses image payloads                           |
| long64 FXSAVE under pending state; then FNINIT and FXRSTOR                              | save preserves pending/state; restore reinstalls raw state, TOP and eligible XMM/MXCSR; no #MF at either FX instruction; following WAIT detects restored pending                                         |
| high64 pointers and REX.W variants                                                      | FX64 retains full pointers; FX without W keeps32 bits but still saves16 XMM banks in long64. real/v8086 legacy packing and protected14 absent FOP follow their selected rules                            |
| long64 `66 48 D9 20` versus `48 66 D9 20`, and `66 48 DD 30`                            | effective W FLDENV reads28 bytes despite66; cancelled W reads14. FNSAVE with effective W stores108. no numeric form or altered image from applying generic64-bit GPR width                               |
| sentinel-filled FX area and executable aliases only over slot padding/tail              | bytes5,14–15/22–23 when unused, raw-slot padding and416…511 survive; outside long64 also288…415 survives. owners covering only untouched bytes remain valid                                              |
| FX image MXCSR80000000, MASKffffffff, pending before restore                            | full source admission then #GP reserved bits, not #MF; loaded MASK cannot legalize the value; all predecessor state survives and zero retirement                                                         |
| dirty SIMD → FXSAVE; FXRSTOR → SIMD read; skipped later writer                          | image sees latest values, restored values feed computation and epilogue, skipped paths preserve the correct bank; repeat from retained middle entries with changed imports                               |
| retained entry after a skipped FXRSTOR, with host bank A and stale image B              | use A; the entry did not execute the restore predecessor and cannot inherit its old image or prior invocation's restored values                                                                          |
| image store through an executable alias, budget1 and stop at next PC                    | completed bytes and FN post-effects visible; budget takes priority at committed next boundary. with positive remaining budget, next-PC stop beats stale fetch/dispatch                                   |

test every selected encoding direction, MM0–7, every TOP, all relevant source/destination aliases, all14 imported mode profiles and address/operand-size combinations. use nonzero segment bases, all permission combinations, every split/failure byte for legacy images and representative FX field/padding/page boundaries, aligned/misaligned starts, high addresses and a nominal span ending exactly at `2^64`. validate unchanged owners on failed/omitted writes, identity-store invalidation and multiple overlapping backing slices. do not infer tag/pointer/padding correctness from a same-codec round trip.

use literal independently encoded image fixtures and lane/integer models separate from production codecs; verify selected defined fields against identified primary hardware/reference observations where available. record CPU/model, image format, controls and source lineage; do not treat Rosetta execution, stale summary tables or the production serializer as an independent oracle. host lifecycle/capture/layout tests remain required wherever interfaces change. no new host API is an acceptance shortcut for guest instruction execution.

## verification, performance and increments

`npm run check` is implementation acceptance. update public usage documentation for MMX aliasing and guest images. x86 owns encodings, lane/numeric meaning and image codecs; memory owns admission, selected writes and source validity; generated execution owns live-state handover and retirement; embedding owns transport/diagnostics; host owns lifecycle and browser artifact ownership. retain these authorities without prescribing a new source tree or dependency.

land executable increments: physical MMX integer/data and EMMS; mixed XMM/MMX conversions with precise faults; legacy image codecs and guest controls; FX images with same-region handover; complete mode/fault/alias/restart and performance coverage. each increment includes tests through its relevant public boundary. the final scope is every selected form and image variant, not a state container or a single successful round trip.

compare unchanged GP, checked scalar/vector store, SSE numeric, x87 arithmetic and budget-one kernels with frozen build identities and checked outputs. characterize MMX arithmetic, GPR/XMM bridges, mixed x87/MMX/EMMS, legacy/FX save/restore, same-region state changes and short resumes separately. record translation/browser compilation/instantiation, first/early/later reuse, resources, generated bytes, native entries and dispatches. distinguish nominal checked bytes from actually copied image bytes. use same-host and A/A/reversed-order controls when small differences may come from JIT/session behavior. CI smoke runs are correctness checks, not performance thresholds or game/native CPU claims.

## references

- [Intel SDM collection](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html), revision093: volume1 §§8.1.3,8.1.7,8.1.10,9.6 and10.5; volume2 selected instruction entries and image layouts; volume3A §§7.5,11.1.1 and15.2, plus #MF/#XM entries. use individual instruction/state chapters to resolve overbroad summary text; in particular FXSAVE does not reset x87 tags.
- [AMD APM volume1](https://docs.amd.com/api/khub/documents/sfvvekC9mDflu6vd3R0NXA/content),24592 revision3.24: MMX physical aliases/TOP and x87 status/pointers, especially §§6.2.2 and6.2.2.8 for derived ES/B. the chosen image/profile rules above are explicit where reserved or implementation-dependent behavior is involved.
- [Intel XED ISA patterns](https://github.com/intelxed/xed/blob/main/datafiles/xed-isa.txt): operand classes, mandatory prefixes and REX field ownership; architectural semantics come from the manuals.
