# masked and streaming memory

## purpose

execute legacy masked stores, non-temporal stores, fences and memory-use hints across the imported execution profiles. guest code can use MMX/XMM/GPR streaming sequences, preserve masked bytes through checked stores, and execute their fences and cache hints with defined fault, retirement and code-validity behavior.

this covers MASKMOVQ, MASKMOVDQU, MOVNTQ, MOVNTDQ, MOVNTPS, MOVNTPD, MOVNTI, LFENCE, MFENCE, SFENCE, PREFETCHNTA/T0/T1/T2, PAUSE and CLFLUSH. it uses private copied RAM with synchronous checked accesses and one executing vCPU. the MMX, SSE, SSE2, FXSR and CLFSH capabilities needed by these forms are enabled for this profile; use CR0.EM=0, CR0.TS=0, CR0.NE=1 and CR4.OSFXSR=1, retaining the existing disabled alignment-check view. this is an execution profile, not a CPUID completeness claim.

retain every supported imported real, virtual-8086, protected, compatibility and long64 profile, including independent operand/address/stack defaults. descriptor loads, guest feature/control writes, paging, architectural handler delivery, shared memory/vCPUs, device memory, write-combining buffers and cache timing have separate contracts. do not add XSAVE/wider-state forms, MOVNTDQA, PREFETCHW/PREFETCHI, CLFLUSHOPT, CLWB, WAITPKG or CET as opcode neighbors.

## encodings and operands

NP below selects no 66/F2/F3 refining prefix. ordinary address-size and segment overrides follow the inherited decoder. effective REX exists only in long64; later legacy prefixes cancel earlier REX. use low ModR/M.reg bits for group selectors regardless of REX.R.

| form                 | selected encoding         | operands and width                                                  |
| -------------------- | ------------------------- | ------------------------------------------------------------------- |
| MASKMOVQ             | NP 0F F7 /r, mod=3        | data from MMX reg, mask from MMX r/m; implicit 8-byte destination   |
| MASKMOVDQU           | 66 0F F7 /r, mod=3        | data from XMM reg, mask from XMM r/m; implicit 16-byte destination  |
| MOVNTQ               | NP 0F E7 /r, mod!=3       | low64 of MMX reg to explicit m64                                    |
| MOVNTDQ              | 66 0F E7 /r, mod!=3       | raw128 of XMM reg to explicit m128                                  |
| MOVNTPS              | NP 0F 2B /r, mod!=3       | raw128 of XMM reg to explicit m128                                  |
| MOVNTPD              | 66 0F 2B /r, mod!=3       | raw128 of XMM reg to explicit m128                                  |
| MOVNTI               | NP 0F C3 /r, mod!=3       | r32 to m32 in every mode; effective long64 REX.W selects r64 to m64 |
| LFENCE               | NP 0F AE /5, mod=3        | no operand; all low r/m values ignored                              |
| MFENCE               | NP 0F AE /6, mod=3        | no operand; all low r/m values ignored                              |
| SFENCE               | NP 0F AE /7, mod=3        | no operand; all low r/m values ignored                              |
| CLFLUSH              | NP 0F AE /7, mod!=3       | one addressed byte, with ordinary EA encoding                       |
| PREFETCHNTA/T0/T1/T2 | 0F 18 /0,/1,/2,/3, mod!=3 | address encoding only; 66/F2/F3 ignored                             |
| PAUSE                | effective F3 90           | no operand; 66 and all effective REX bits ignored                   |

MOVNTI has no 16-bit data form, including under CS.D=0. 66-prefixed MOVNTI is outside this selection. REX.W does not change the fixed MMX/XMM widths. XMM reg and r/m banks use REX.R/B; GPR source reg uses REX.R. MMX indices remain three bits. REX.B/X extend explicit memory addressing normally, but never extend the implicit DI register of MASKMOV.

MASKMOV uses DS by default, with the inherited segment override rules. address size selects DI, EDI or RDI, including 67 in long64. it neither changes the index nor reads RCX. its mod=3 byte names two source registers and consumes no SIB or displacement, even when r/m=4 or5. capture data and mask from their live sources before publication, including when both name the same register.

accept every fence r/m alias: E8..EF for LFENCE, F0..F7 for MFENCE, F8..FF for SFENCE. REX fields, address size and segment overrides do not create a fence operand. NP 0F AE /5 or /6 with mod!=3 stays unsupported at the deciding ModR/M; those are unimplemented extended-state neighbors. /7 memory selects CLFLUSH rather than SFENCE. preserve the existing FXSAVE/FXRSTOR and MXCSR decode paths. non-NP AE combinations retain their unimplemented-neighbor diagnostics.

for PREFETCH select only /0..3 memory forms. /4..7 and mod=3 remain unsupported at the deciding byte; do not label those unselected forms architectural #UD by inference. ignored repeat prefixes on PREFETCH do not admit repeats on other instructions. repeated F2/F3 follow the inherited last-repeat policy. PAUSE requires effective F3; effective F2 90 remains outside this selection. in particular F3 41 90 is PAUSE in long64 and preserves RAX/R8, while unprefixed 41 90 retains its existing XCHG meaning.

retain required-byte fetch, the fifteen-byte limit, and deciding-byte diagnostics. known wrong mod classes for the selected MASKMOV and MOVNT forms are invalid before unrelated address fields. a single LOCK on an otherwise admitted complete form consumes its required encoding and then returns invalid-encoding before operand access. repeated LOCK and mixed LOCK/repeat prefixes retain inherited unsupported handling. these engine diagnostics do not introduce a universal architectural-exception mapping.

## masked and streaming stores

in MASKMOV byte i is selected exactly when bit7 of mask byte i is one. all other mask bits are ignored. selected bytes receive data byte i. MASKMOVQ has exactly eight positions, 0..7; MASKMOVDQU has sixteen, 0..15. no floating-point classification or rounding occurs.

use the existing private instruction-level admission policy: validate the complete nominal 8/16-byte destination geometry and segment/write permissions before any store. this also applies to an all-zero mask and to masked-off bytes. no source state or completed guest memory effect is published on admission failure. this is an explicit private-memory policy; Intel permits implementation-dependent address/protection faults for an all-zero mask, so do not promise masked-off fault suppression or portable hardware rollback.

after admission, write only selected positions in ascending guest-address order. do not read the destination or implement a read/merge/write of its full span. write-only mappings must work. coalescing adjacent selected bytes must preserve that order and the exact backing write footprint. an empty selected set still undergoes nominal admission, then writes nothing.

MOVNTQ and MOVNTI store exactly 8 or4/8 bytes. MOVNTDQ/PS/PD store exactly16 bytes and require the translated linear start to be16-byte aligned. MASKMOVQ/DQU and MOVNTQ/I have no additional natural/16-byte alignment requirement in this profile. preserve inherited address/context checks before the selected alignment check, and alignment before backing admission. fault metadata carries the complete access width and write direction. none of these stores requires destination read permission.

snapshot source values before guest writes and check the entire admitted store span before changing bytes or owners. successful non-temporal stores are immediately visible through every backing alias under this private execution model. they do not create a pending store buffer, hidden RAM copy, memory-type input or deferred commit at a later fence.

MASKMOVQ and MOVNTQ follow the shared MMX rules: check old pending x87 exceptions before address admission, including an all-zero mask. success sets TOP=0 and the full tag word to0000. all eight raw80 payloads, CW, other SW bits and saved FIP/FDP/FOP remain unchanged; these are source-only MMX operations and do not write an FFFF marker. failure preserves the incoming complete x87 state. MASKMOVDQU, the XMM/GPR MOVNT forms, fences and hints do not check pending x87 state or change it.

preserve all GPRs, flags including DF, XMM registers and MXCSR. data/mask/source aliases and extended XMM/GPR banks must use live generated values, not stale canonical spills. an XMM source containing NaNs, infinities or denormals is stored bit-for-bit without #XM or MXCSR updates.

## fences, prefetch and pause

LFENCE waits until all prior instructions complete locally and permits no later instruction to begin execution before it completes; prior stores need not become globally visible at that point. SFENCE orders prior stores before later stores; MFENCE orders prior loads/stores before later loads/stores. preserve these relations at the existing private-RAM observation boundaries. synchronous accesses already complete in order, so this profile needs no artificial flush, JavaScript callback or guest-visible state change. any future buffering, reordering, device or shared-memory path must supply the corresponding ordering before it can use this contract.

fences have no data operand, alignment check, x87 pending check, flag effect, source invalidation or context-version change. they do not serialize unrelated instruction streams, provide a Spectre mitigation guarantee or establish a shared-vCPU memory model here.

PREFETCH hints fully consume the selected instruction's addressing bytes, including required SIB/displacements. the selected no-cache profile ignores their data effect: do not probe segment usability/type/limit, address canonicality/range, mappings, backing permissions or destination bytes. do not implement a hint as a checked read. instruction fetch/decode failures and selected LOCK invalidity still occur normally. no numeric state, flags, memory, code owner or context version changes.

PAUSE preserves all state and retires as one ordinary instruction. F3 does not make it REP, consult RCX or consume repeatBudget. do not add a sleep, implicit scheduler exit, memory probe or special host-visible completion reason. ordinary instruction budget and stop controls continue to bound execution of spin loops.

## CLFLUSH access

probe only the one addressed byte using inherited read geometry and private backing read permission. CLFLUSH additionally allows an execute-only loaded code segment; preserve that instruction-specific exception to ordinary data-read segment type checking. it does not substitute execute permission for mapping read permission, require CS as the segment, or bypass unusable/limit/address checks. keep this rule with segment translation rather than adding a second segment translator.

do not widen admission to the containing cache line. an otherwise valid final byte of a mapping, segment or u64 address range can succeed without a mapping for the rest of a cache line. read-only backing succeeds, write-only backing fails. the byte's value is not an instruction result and no guest data byte is written.

private copied RAM has no physical cache hierarchy to evict or write back. retain its coherent bytes and every code owner, including on identity aliases; CLFLUSH is not an executable-source mutation. no context-version change or hidden executable invalidation is caused by the hint. guest page accessed/dirty bits, physical cache line size and CLFSH reporting belong to their later control/paging/identity contracts. do not emit an ordinary read from an execute-only segment and then suppress its type fault after other effects.

## publication, aliases and restart

actual writes are defined by backing incarnation and offsets. masked-off guest positions receive no direct write, but they may observe a changed byte through an alias of a selected position. a code owner depending on that changed backing byte must invalidate even if its own guest address corresponds to an inactive mask position. when selected positions alias the same backing byte, the later guest-address write wins. independent expected memory must apply writes to backing bytes in that order, then project all aliases.

invalidate owners for exactly the actual selected/streaming backing writes, including identity writes. nominal admission alone, all-zero masked stores, fences, PREFETCH, PAUSE and CLFLUSH do not invalidate owners. an admission failure publishes no byte, MMX transition or invalidation, including a late masked-off-byte fault. do not invalidate the whole nominal span simply because it was checked.

successful self-modifying stores finish all selected writes and the Q-form MMX transition once, retire once, then honor existing budget/stop/dispatch precedence. a replaced successor must be decoded from changed bytes before execution. an already retired store is not replayed on resume. retain both instruction/repeat accounting pairs; these instructions do not perform REP elements.

zero instruction budget and stop-at-current gates precede effects. repaired faults re-execute from the instruction with new live GPR/XMM/MMX values and current mappings, without requiring recompilation merely for data or raw numeric imports. retain existing resource admission, artifact ownership/eviction and host idle-mutation rules. do not add a mask-dependent translation key or treat mask/data values as compilation constants. keep the five-argument generated entry ABI and existing scalar/XMM/MXCSR/raw80 host projections.

## acceptance packets

unless a packet specifies otherwise, compare every GPR/flags/RIP, XMM bank, MXCSR and raw80/environment field, complete backing bytes and aliases, exclusive diagnostics, both budget pairs and owner/resource counts. mask undefined outputs only where an instruction permits them; these selected state-preserving operations need no broad numeric-status mask.

| packet                                                                                                                                   | required observation                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| data byte i=10+i hex; mask bytes00/01/7F/80/FF mixed                                                                                     | only bit7 selects bytes; positions0/7 and0/15 have independent literal expectations                                                            |
| MASKMOVQ imported TOP5, partial tags, distinct R0/R5; data/mask same bank and different banks                                            | physical bank selection, source snapshot, success TOP0/TW0000; every payload and environment field preserved                                   |
| pending ZE, MASKMOVQ or MOVNTQ, missing destination; zero mask too                                                                       | #MF before address access/transition; repaired pending state retries retained code with current inputs                                         |
| zero MASKMOVQ mask, valid W-only full span                                                                                               | no bytes/owners change; TOP/tag transition still occurs and instruction retires                                                                |
| zero or sparse mask, last nominal byte read-only/unmapped                                                                                | complete nominal width in fault record; no early selected store, Q transition or invalidation                                                  |
| unaligned masked8/16 stores across every split; W-only mappings                                                                          | successful selected-byte stores with exact guards; no destination read; inactive direct positions untouched subject to aliases                 |
| guest0..7 and8..15 alias backing0..7; select only byte8 with value5A                                                                     | backing0 and guest0 change to5A; owner depending on backing0 invalidates despite guest0's inactive mask position                               |
| same alias, select bytes0 and8 with distinct data                                                                                        | later guest-address value wins; all sources captured before any publication                                                                    |
| watched code bytes only in inactive, unaliased positions                                                                                 | owner remains valid; selecting a watched byte, including an identity write, invalidates                                                        |
| RDI versus R15 poisoned, long64 67,16/32-bit DI/EDI, FS/GS/other selected overrides                                                      | inherited address truncation/base rules; REX.B never redirects implicit DI; no index/count update                                              |
| all MOVNT families, every imported mode, upper GPR/XMM source banks                                                                      | exact raw4/8/16 bytes; MOVNTI remains32-bit in CS.D=0; effective long64 W selects64; sources/flags/numeric state unchanged except Q transition |
| m128 start unaligned and unmapped; address/context failure too                                                                           | inherited address/context checks win first, then alignment16, then mapping; Q/I/masked forms do not inherit this alignment                     |
| dirty XMM/GP producer followed by selected store or same-bank masked sources                                                             | stored bytes use live results; skipped writers, retained middle entries and budget-one resumes use current invocation inputs                   |
| Q/masked/NT store replaces compiled successor, budget1/2, stop-current/next                                                              | complete effects once, correct retirement/dispatch, no stale successor execution or replay                                                     |
| E8..EF/F0..F7/F8..FF fence aliases with effective REX                                                                                    | one instruction, no operand fetch beyond ModR/M, state/owners/both accounting pairs preserved as specified                                     |
| PREFETCH valid encoding but noncanonical, overflowing, unusable/limit/type-failing or unmapped EA                                        | no data fault/probe; malformed/truncated encoding and LOCK still diagnosed                                                                     |
| PREFETCH with66/F2/F3 and zero RCX; /4..7 and mod3 neighbors                                                                             | ignored selected prefixes do not become REP; unselected forms stop at deciding byte                                                            |
| F3 41 90 and66 F3 49 90; bare41 90; reversed F2/F3 order                                                                                 | PAUSE ignores REX and preserves RAX/R8; existing XCHG and last-repeat selection remain distinct                                                |
| CLFLUSH one readable final byte, absent remaining line, unaligned and u64-end addresses                                                  | one-byte checks only, no data mutation or owner/context change                                                                                 |
| protected/compatibility CLFLUSH through execute-only CS to an R-only, non-executable mapping; ordinary data-read control; W-only variant | ordinary read reports the segment type fault, CLFLUSH succeeds with R, and W-only fails; no execute-permission substitution                    |
| pending x87, fences/PREFETCH/PAUSE/CLFLUSH/XMM or GPR store                                                                              | ordinary completion or the selected memory fault; no spurious #MF or numeric state change                                                      |
| budget0/stop-current, repaired mapping, host-changed masks/data and retained entries                                                     | no speculative effects before gates; retry observes fresh invocation state and current mappings                                                |

cover all imported profiles, prefix order, required-byte truncation and length boundaries, high/noncanonical/u64-end spans, every meaningful split, masks with0/1/all/alternating/random selected bits, and ordinary stores mixed with masked/NT operations and fences. include scalar/XMM/raw80 neighbors and host transport/lifecycle checks. mask-to-byte/range logic needs independent exhaustive8-bit and16-bit selection coverage; public execution can use partitioned boundary/literal/seeded cases. do not use a masked store's own readback algorithm or code generator as its oracle.

## implementation and performance acceptance

x86 owns encodings, source banks, masks and per-form numeric effects; memory owns admission, ordered writes and backing/source validity; segment translation owns the CLFLUSH type exception; generated execution owns live sources and retirement; embedding owns transport/diagnostics. reuse the existing field-transfer, store and numeric contracts where their meaning matches.

land tested executable increments: NT store families and alignment/state rules; masked stores with full admission/selected publication and aliases; fences/hints/CLFLUSH decode and access semantics; combined restart and performance coverage. each increment includes the relevant public Node/Chrome boundary. `npm run check` is implementation acceptance; update public usage documentation for the selected private ordering/hint profile.

compare unchanged GP, checked vector4/8/16-byte access, SSE numeric, x87/MMX, state-image and budget-one controls against frozen build identities. characterize mask densities, zero masks, contiguous/split/aliased backing, W-only admission, ordinary versus NT stores, stores mixed with fences, PREFETCH/PAUSE streams, CLFLUSH probes and short resumes. check outputs, actual backing write footprints and resource counts before interpreting time. record translation, browser compile/instantiation, first/early/later reuse, generated/cache bytes, native entries and dispatches. use same-host, duplicate-instance and reversed/fresh-session controls for small effects. a non-temporal hint does not promise a host cache speedup; a newly executable form has no instruction-throughput baseline on a build that cannot run it.

## references

- [Intel SDM collection](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html), revision093: volume2B MASKMOVQ/DQU, MOVNT*, MFENCE, SFENCE, PAUSE and PREFETCHh; volume2A LFENCE and CLFLUSH; volume3B §25.25.3/Table25-8 for legacy MMX exception conditions. individual instruction descriptions govern explicit alignment and zero-mask qualifications. MASKMOVQ's eight-byte definition governs positions0..7 despite the final-offset typo in its pseudocode.
- [Intel XED ISA patterns](https://github.com/intelxed/xed/blob/main/datafiles/xed-isa.txt) and [prefix macros](https://github.com/intelxed/xed/blob/main/datafiles/xed-state-bits.txt): operand classes, REX ownership, ignored fence r/m and PAUSE REX bits, refining-prefix boundaries. these describe encoding selection; memory and ordering behavior follows the manuals and the explicit private profile above.
