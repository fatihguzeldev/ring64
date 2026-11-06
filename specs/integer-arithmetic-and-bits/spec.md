# integer arithmetic and bits

extend [scalar data and widths](../scalar-data-and-widths/spec.md) and its inherited execution contracts with carry arithmetic, unary operations, status-flag transfers, shifts, rotates and classic bit operations. retain the imported 64-bit execution context, 8/16/32/64-bit register views, 64-bit addresses, fixed RX code/RW RAM, concrete flags under `0x8d7`, checked accesses, precise exits and artifact ownership.

these operations add incoming carry and count/index operands, partial flag writers and bit-string addressing to the scalar execution path. multiplication/division, other execution modes, DF and repeated execution, guest exception delivery, LOCK/atomic execution and optional BMI/ADX/POPCNT/LZCNT/TZCNT families have separate contracts.

## forms and decoding

use `[66] [REX] opcode`, with each prefix optional and present at most once, in that order. `d` is 64 with REX.W, otherwise 16 with `66`, otherwise 32. byte opcodes remain 8 bits regardless of `66` or REX.W. inherit high-byte versus REX low-byte selection, full incoming address/register values, `/digit` selectors ignoring REX.R, unused REX fields and complete `next_pc` rules.

| family                                  | encodings                                      | operands                                                                                 |
| --------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
| ADC                                     | `10/11 /r`, `12/13 /r`, `14/15`; `80/81/83 /2` | byte/`d` r/m-first, register-first and accumulator-immediate; group immediate            |
| SBB                                     | `18/19 /r`, `1A/1B /r`, `1C/1D`; `80/81/83 /3` | the corresponding byte/`d` forms                                                         |
| INC / DEC                               | `FE /0,/1`; `FF /0,/1`                         | byte r/m; r/m at `d`                                                                     |
| NOT / NEG                               | `F6 /2,/3`; `F7 /2,/3`                         | byte r/m; r/m at `d`                                                                     |
| CLC / STC / CMC                         | `F8`, `F9`, `F5`                               | implicit CF                                                                              |
| LAHF / SAHF                             | `9F`, `9E`                                     | implicit AH and status flags                                                             |
| ROL / ROR / RCL / RCR / SHL / SHR / SAR | group 2 selectors `/0,/1,/2,/3,/4,/5,/7`       | `D0/D1`: byte/`d`, count one; `D2/D3`: byte/`d`, count CL; `C0/C1`: byte/`d`, imm8 count |
| SHLD / SHRD                             | `0F A4/AC /r ib`; `0F A5/AD /r`                | r/m at `d`, register source at `d`; immediate/CL count                                   |
| BT / BTS / BTR / BTC                    | `0F A3/AB/B3/BB /r`; `0F BA /4,/5,/6,/7 ib`    | r/m at `d`, register bit index; r/m at `d`, imm8 bit index                               |
| BSF / BSR                               | `0F BC/BD /r`                                  | register destination and r/m source at `d`                                               |
| BSWAP                                   | `0F C8+rd`                                     | r32 or r64, selected by REX.W; REX.B extends the opcode register                         |

all listed r/m forms admit registers and inherited address expressions. there are no byte SHLD/SHRD, BT-family or BSF/BSR forms. ADC/SBB immediates follow the existing arithmetic rules: byte/imm8; 16-bit/imm16; 32-bit/imm32; 64-bit/sign-extended imm32. `83` sign-extends imm8 to `d`. counts and immediate bit indices are unsigned imm8, with the reductions below.

CLC/STC/CMC and LAHF/SAHF ignore `66` and all REX fields. LAHF/SAHF always use AH, including with REX; the REX restriction on encoded high-byte operands does not redirect an implicit AH operand. this imported context admits 64-bit LAHF/SAHF. a future feature-reporting contract must agree with that admission, including `CPUID.80000001H:ECX[0]`; no feature configuration or CPUID instruction is introduced here.

select a shared opcode's family before applying its prefix coverage. `FF` now requires ModR/M to distinguish INC/DEC from the inherited transfer families: `66 FF` requires that byte, while `66 FF /2,/4` remains unsupported after ModR/M without fetching a memory tail. existing unprefixed/REX register CALL/JMP admission and all other stack/branch prefix rules remain unchanged. opcode bytes `40..4F` remain REX, not legacy one-byte INC/DEC.

group 2 `/6`, `FE /2..7`, `0F BA /0..3`, and `F6/F7 /1,/4..7` remain unsupported after ModR/M without a SIB, displacement or immediate fetch. inherited `F6/F7 /0` TEST and other `FF` coverage remain as specified. a 16-bit BSWAP without overriding REX.W is unsupported after the second opcode; no undefined BSWAP16 result is added. `82`, F3-prefixed bit-scan aliases, LOCK/REP/segment/address-size prefixes and repeated/reversed prefixes retain their unsupported classification. unsupported coverage is not an architectural invalid-encoding claim.

decode every required admitted byte before checking operands, including the imm8 after a memory address tail. preserve the existing length/domain-end diagnostics and reached budget/stop/decode/resource priority.

## arithmetic, unary operations and flag transfers

capture every source view, incoming CF and address term before any write. let `a` and `b` be unsigned width-limited operands, `c` the incoming CF and `M=2^w`.

- ADC computes the mathematical sum `a+b+c`, then writes it modulo `M`. CF records whether that sum is at least `M`.
- SBB computes `a-b-c`, then writes it modulo `M`. CF records whether `a < b+c`, with `b+c` evaluated before width truncation.
- for both, OF reports the out-of-range signed mathematical sum/difference of the two signed source values and `c`; AF reports the corresponding carry/borrow across bit 3. SF/ZF/PF describe the width-limited result, with parity from its low byte. all six arithmetic flags are defined.
- INC/DEC add/subtract one and define OF/SF/ZF/AF/PF as that arithmetic would, while preserving the actual incoming CF.
- NEG writes `-a mod M`; CF is one iff `a` is nonzero, OF is one iff `a=2^(w-1)`, and the other arithmetic flags follow subtraction from zero.
- NOT complements only the selected operand width and preserves every admitted flag.

modifying register operations apply the view-write rule even when their low result is unchanged. memory operations write exactly the selected width. do not truncate `b+c` before deriving SBB's borrow or reuse a two-input overflow/AF computation that loses the carry input.

CLC clears CF, STC sets it and CMC complements it; preserve every other actual flag bit. LAHF replaces only AH with `(flags & 0xd5) | 2`, preserving all flags and other bank bits. SAHF replaces CF/PF/AF/ZF/SF from incoming AH under `0xd5`, ignores AH bits 1/3/5, preserves OF and retains fixed flag bit 1. neither instruction writes another register or accesses memory.

## counts, shifts and rotates

CL is the incoming low byte of RCX, regardless of REX fields or aliases with the data/source operands. let `raw` be CL, imm8 or one. first compute `k = raw & 63` at width 64, otherwise `k = raw & 31`. distinguish this masked count from any later rotate reduction.

SHL/SAL shifts left with zero fill; SHR shifts right with zero fill; SAR shifts right with sign fill, rounding signed division toward negative infinity. SAL and SHL name the same admitted `/4` operation. for nonzero `k`, SF/ZF/PF describe the resulting width-limited value; AF is undefined. CF is the last shifted-out bit, except that SHL/SHR leave CF undefined when `k >= w`. SAR retains a defined last-bit/sign-fill carry even at such counts. OF is defined only when `k=1`: result sign XOR CF for SHL, original sign for SHR, zero for SAR. at larger counts OF is undefined.

ROL/ROR rotate the data bits by `n = k mod w`. when `k != 0`, CF becomes respectively the result's low/high bit, even if `n=0`. RCL/RCR rotate the data and incoming carry as a `w+1`-bit ring. their effective count is `n=k mod 9` for width 8, `n=k mod 17` for width 16, and `n=k` for widths 32/64. an effective count zero preserves data bits and CF. for all four rotates, preserve SF/ZF/AF/PF exactly. when `k=1`, OF is result sign XOR resulting CF for left rotates and the XOR of the result's top two bits for right rotates. when `k>1`, OF is undefined, including RCL/RCR with a reduced count of zero or one.

when `k=0`, every shift/rotate preserves the entire actual flag word. a 32-bit register destination still clears the bank's upper half; byte/word/64-bit destinations retain their unchanged data bits using the usual view rules. a full-width rotate with nonzero `k` is not the same flag operation as masked count zero. WebAssembly's native shift-count reduction alone does not implement narrow shifts, carry rotates or these flag rules.

SHLD/SHRD capture the old destination, register source and count before any write. for `1 <= k <= w`, SHLD writes the low `w` bits of `(a << k) | (b >> (w-k))`; SHRD writes `(a >> k) | (b << (w-k))`, limited to `w` bits. these formulas include `k=w`, where the result is the source; do not let a host shift-by-width turn that case into shift-by-zero. CF is the last bit shifted out of the old destination. SF/ZF/PF follow the result; AF is undefined. at `k=1`, OF is old destination sign XOR result sign; at larger counts OF is undefined.

SHLD/SHRD with `k=0` preserve all flags and apply the unchanged-data destination view rule, including 32-bit upper clearing. for width 16 and `k=17..31`, the destination view and all six arithmetic flags are undefined. the instruction remains admitted, still performs its required memory access and completes once. every other bank, the destination bank's upper 48 bits, fixed flag bit 1 and memory outside the selected operand remain constrained. widths 32/64 cannot reach `k>w` after masking.

## bit indices, scans and byte swap

for a register BT-family destination, reduce the register or immediate index modulo `w`. BT reads the selected original bit into CF without writing any destination bank. BTS/BTR/BTC respectively set, clear or complement that bit, applying the normal view-write rule even when the selected bit was already set/clear. all four preserve ZF and leave OF/SF/AF/PF undefined after success.

for a memory operand with a register index, interpret the width-limited index as signed. compute `q=floor(index/w)` and `r=index-q*w`, so `0 <= r < w`. form the encoded effective address with inherited 64-bit arithmetic, then add `q*(w/8)` modulo `2^64`. access the full `w/8`-byte element at that adjusted address and select bit `r`. negative indices select preceding elements; arithmetic shifts/floor division, not truncation toward zero, determine them. with an imm8 index, use `r=imm8 mod w` in the encoded element without any address adjustment; assembler rewriting of larger literal bit offsets is not decoder behavior.

validate the adjusted element's complete span, not the raw base or an individual selected byte. report that adjusted start and full width in fault metadata. a raw noncanonical/unmapped encoded address can produce a usable adjusted address, or the reverse. source-index/destination/address aliases use incoming full banks before a result or flags commit.

BSF/BSR read their full source width even when the value is zero. a nonzero source writes the least/most significant set-bit index at `d`, using the normal register view rule. a zero source preserves the entire destination bank, including its upper 32 bits for a 32-bit form. ZF is one iff the source is zero; PF is one iff the number of set bits in the complete width-limited source is even; CF/OF/SF/AF are cleared. these are the precise BSF/BSR results in Intel SDM 093US; do not substitute low-byte/result parity or an older undefined-destination/flags rule. older-processor variations described by the manuals do not relax these results.

BSWAP reverses the bytes within the selected 32- or 64-bit register, applies its normal view write and preserves all flags. unused REX.R/X do not alter the opcode register.

## access, completion and observation

BT and BSF/BSR memory sources require read permission. every modifying memory form uses full-span write-intent preflight before reading backing storage, then writes the selected element. this includes zero-count shifts/rotates/SHLD/SHRD, NEG zero and identity ADC/SBB/BTS/BTR results. a masked count of zero, a reduced rotate count of zero, or an already-set BTS bit cannot bypass an otherwise failing access. this is the existing private-memory embedding contract; it does not select MMIO cycles, LOCK behavior or a concurrent observer model.

on a failing operand access preserve every incoming bank, the entire actual flag word and all RAM. leave the instruction unretired at its original RIP, with exact access kind, actual start, width, cause and first failing address. a failed partial flag writer must not commit even CF alone. earlier completed effects remain committed. source/selector/encoding failures keep the inherited classification and access-free behavior.

successful operations commit their specified views, flags and memory, advance to complete `next_pc` and retire once. undefined results remain concrete valid state, scoped only to the stated view/flags of the completed writer. do not globally mask them in preserving successors, failures or imported entries; after observing a writer, subsequent preserving operations must retain its actual bits.

retain one authoritative embedding layout and existing artifact ownership. current operands, counts, indices and flags are inputs to every cached middle entry; a predecessor need not have run. code/context identity remains fixed for the CPU instance. this contract requires no second execution engine, new public state ABI, lazy-flags representation or final translation geometry.

## verification

run decoder tests, real generated-Wasm checks and shared public Node/Chrome cases; `npm run check` is the implementation acceptance command. author expectations from mathematical ranges, literal bytes and the referenced instruction definitions independently of the decoder/lowering. cover each listed encoding, legal width and memory/register/immediate form, all banks, high-byte/REX views and ignored fields. compare complete banks, exact exits/counts, guarded RAM/code and complete diagnostics.

exhaust all byte ADC/SBB operand pairs with both incoming carries in reusable generated-Wasm cases. verify wide carry/borrow, signed overflow and nibble boundaries separately, including `b=max,c=1`. for shifts/rotates test every count byte with both carries and boundary source patterns, covering `0,1,w-1,w,w+1,31,32,33,63,64,65,255`; include exhaustive byte data/count combinations in the direct generated path. the independent oracle may perform one-bit steps on a mathematical bit vector; it must not inherit WebAssembly's native count masking or lowering formulas.

check defined, preserved and undefined bits per writer/count. compare CF/ZF/fixed bit 1 for the BT family under `0x43`, while also validating the complete word. check nonzero shift AF and multi-count OF only for validity at that writer, then require exact preservation wherever specified. verify all flags exactly for ADC/SBB/INC/DEC/NEG/NOT, carry controls, LAHF/SAHF, masked-count-zero operations and BSF/BSR. undefined SHLD/SHRD16 outputs still require intact upper bank bits, all other banks, guards and progress.

### literal distinctions

each packet is a separate exact code image at `0x1000`, budget one, no stop, explicit sufficient limits, RAM of 64 `a5` bytes at `0x4000` and flags `0x8d7`. initialize bank `i` to `0x1122334400000000+i`, then RAX=`0x1122334455667788`, RCX=`0x1122334400000001`, RBX=`0x4010`, RSP=`0xaabbccddeeff0011`; apply each row's overrides. successful packets return budget, retired one/remaining zero, no fault, and advance RIP by the complete packet length. every unlisted bank and RAM byte is unchanged. a flag mask identifies only a completed writer's defined/preserved bits; the complete flag word must remain valid.

| bytes                               | overrides                               | required result                                                                                     |
| ----------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `10 C8`                             | RAX=`0x1122334455667700`, RCX=`0xff`    | RAX=`0x1122334455667700`, flags=`0x57`                                                              |
| `18 C8`                             | the same                                | the same; adding CF to `ff` must not lose borrow                                                    |
| `48 19 C8`                          | RAX=0, RCX=`0xffffffffffffffff`         | RAX=0, flags=`0x57`                                                                                 |
| `10 C8`                             | RAX=`0x112233445566777f`, RCX=0         | RAX=`0x1122334455667780`, flags=`0x892`                                                             |
| `18 C8`                             | RAX=`0x1122334455667780`, RCX=0         | RAX=`0x112233445566777f`, flags=`0x812`                                                             |
| `FE C4`                             | RAX=`0x112233445566ff88`                | RAX=`0x1122334455660088`, flags=`0x57`                                                              |
| `66 FF C8`                          | RAX=`0x1122334455668000`, flags=`0x2`   | RAX=`0x1122334455667fff`, flags=`0x816`                                                             |
| `F6 D4`                             | —                                       | RAX=`0x1122334455668888`, flags preserved                                                           |
| `F6 D8`                             | RAX=`0x1122334455667780`                | RAX unchanged, flags=`0x883`                                                                        |
| `F8` / `F9` / `F5`                  | —                                       | banks unchanged, flags=`0x8d6` / `0x8d7` / `0x8d6`                                                  |
| `4F 9F`                             | —                                       | RAX=`0x112233445566d788`, flags preserved                                                           |
| `4F 9E`                             | RAX=`0x1122334455660088`                | banks unchanged, flags=`0x802`                                                                      |
| `C1 E0 20`                          | —                                       | RAX=`0x55667788`, flags preserved; masked zero still writes EAX                                     |
| `C0 E0 01`                          | RAX=`0x1122334455667780`                | RAX=`0x1122334455667700`, flags under `0x8c7`=`0x847`                                               |
| `C0 E8 01`                          | RAX=`0x1122334455667780`                | RAX=`0x1122334455667740`, flags under `0x8c7`=`0x802`                                               |
| `C0 F8 01`                          | RAX=`0x1122334455667781`                | RAX=`0x11223344556677c0`, flags under `0x8c7`=`0x87`                                                |
| `C0 E0 08`                          | RAX=`0x1122334455667780`                | RAX=`0x1122334455667700`, flags under `0xc6`=`0x46`                                                 |
| `C0 C0 08`                          | RAX=`0x1122334455667780`                | RAX unchanged, flags under `0xd7`=`0xd6`; full rotate still replaces CF                             |
| `C0 D0 09`                          | —                                       | RAX unchanged, flags under `0xd7`=`0xd7`; OF undefined                                              |
| `C0 D0 0A`                          | —                                       | RAX=`0x1122334455667711`, flags under `0xd7`=`0xd7`; effective one does not define OF               |
| `C1 D0 21`                          | —                                       | RAX=`0xaaccef11`, flags=`0x8d6`                                                                     |
| `48 C1 D0 41`                       | —                                       | RAX=`0x22446688aaccef11`, flags=`0xd6`                                                              |
| `66 0F A4 C8 10` / `66 0F AC C8 10` | RAX=`0x1122334455660001`, RCX=`0x1234`  | RAX=`0x1122334455661234`, flags under `0xc7`=`0x3` / `0x2`                                          |
| `0F A5 C9` / `0F AD C9`             | RCX=`0x1122334480000001`                | RCX=`0x3` / `0xc0000000`, flags under `0x8c7`=`0x807` / `0x87`; source, destination and count alias |
| `0F BA E0 20`                       | —                                       | full RAX unchanged, flags under `0x43`=`0x42`; BT EAX is read-only                                  |
| `0F BA E8 03`                       | —                                       | RAX=`0x55667788`, flags under `0x43`=`0x43`; identity BTS EAX still clears upper bits               |
| `66 0F A3 0B`                       | RCX=`0xffff`, word at `0x400e`=`0x8000` | banks unchanged, CF=1 and ZF=1; read word at `0x400e`                                               |
| `66 0F BA 23 10`                    | word at `0x4010`=1                      | banks unchanged, CF=1 and ZF=1; imm8 value 16 selects bit zero in the encoded element               |
| `0F BC C1` / `0F BD C1`             | RCX=0                                   | full RAX unchanged, flags=`0x46`                                                                    |
| `0F BC C1` / `0F BD C1`             | RCX=`0x100`                             | RAX=8, flags=`0x2`; parity counts the source, not the index or low byte                             |
| `0F BC C1` / `0F BD C1`             | RCX=`0x180`                             | RAX=7 / 8, flags=`0x6`                                                                              |
| `0F BC C0`                          | RAX=`0x100000000`                       | full RAX unchanged, flags=`0x46`                                                                    |
| `0F C8` / `48 0F C8`                | —                                       | RAX=`0x88776655` / `0x8877665544332211`, flags preserved                                            |

### failures, aliases and retained entries

- run zero-count memory shifts/rotates/SHLD/SHRD against code, noncanonical/unmapped spans and a word spanning RAM/code. require write-intent diagnostics and unchanged full state/RAM. compare the same zero-count forms on writable RAM with one retirement, unchanged bytes and exact flags. include RCL reduced-zero counts and identity BTS/BTR. use forbidden-read generated imports to reject an ordinary read before a failing write-intent preflight.
- truncate every admitted address tail/immediate/count byte, combine it with unusable operands, and require fetch failure first. separately test `66 FF` versus `66 FF D0`/`66 FF 14`, excluded group selectors without hypothetical tails, BSWAP16, F3 bit-scan prefixes and unchanged branch/stack prefix coverage.
- exercise CL as destination/source/address bank: shifts of CL/CH/ECX/RCX, SHLD/SHRD with source=destination=RCX, and memory addresses using full RCX while its low byte supplies a count. read every term before a write; changing a count/result cannot retroactively change the access address.
- for memory bit strings, test register indices `-1,-w,-w-1,0,w-1,w,w+1` at all widths, values with nonzero upper bank bits, immediate indices `w,255`, high addresses and wrapping address adjustment. map only the selected element, leaving the encoded element unmapped. distinguish element-width faults from selected-byte access and require the adjusted start in the complete tuple. BT needs only read permission; BTS/BTR/BTC preflight writes even for identity results.
- run BSF/BSR from exact-width mappings with zero/nonzero sources, destination/source aliases and an unusable source address. zero success preserves the complete old destination, while source failure preserves both destination and all old flags; these are different flag outcomes. distinguish whole-source parity from low-byte and result parity at every width.
- chain carry producers through INC/DEC/NOT, rotates and status transfers before ADC/SBB, SETcc/CMOVcc/Jcc consumers. include CF=0/1, actual AF/OF=0/1, high-byte merges, all-bank live values and word/32-bit identities. a loop counter must not overwrite a producer before its condition is consumed.
- use `80 03 01 66 D3 26` with byte zero at `0x4010`, RSI=`0x7000`, RCX=0 and budget three. require ADD's counter byte one and flags=`0x2`, then a width-two write/unmapped fault at RSI, RIP=`0x1003`, retired one/remaining two, all banks unchanged. repair only RSI to `0x4014` and resume budget one: require RIP=`0x1006`, unchanged operand/guards, counter still one, flags=`0x2` and no stale fault. budget one or stop at `0x1003` must prevent the shift access. repeat the prefix/failure/repair pattern with ADC, unary and modifying bit operations, including AF=1 and aliasing index/address banks.
- enter retained suffixes with changed CF, CL, bit indices, RAM and full register banks without running their predecessors. establish no new compilation, vary zero/identity/nonzero cases, then force overlapping-owner eviction and reinstallation. retain resource/frontier and fault-metadata lifetime checks from the earlier contracts.

## performance

compare unchanged 32/64-bit scalar, logical/Jcc, addressing, memory, stack/transfer and short-resume workloads before/after using identical guest bytes, inputs, limits, observations and checked outputs. include first-use and code-churn decode/translation costs alongside retained execution.

characterize new forms separately: carry chains through partial flag writers, mixed-width aliases, zero versus nonzero/large counts, carry rotates, signed bit-string indices, bit scans, memory RMW and repaired faults. consume live conditions before later flag writers. check full state/guards and exact exits/counts outside timing; short-resume observation work must match between alternatives. new forms unsupported by the old core have no executable old baseline.

retain balanced repeated samples, matched warmup histories, first completion and early/later reused windows, translation/browser compilation/instantiation costs, generated/cache bytes and native-entry/dispatch counts. preserve raw samples and environment/artifact identities. first completion in a shared browser is not independent cold evidence. resolve repeatable regressions beyond observed variation; for small resume differences include same-core A/A and matched host-factory controls before attributing a cause.

compare any proposed flag/count optimization on the same bytes and permitted outputs. no-op count handling must retain destination-width effects and required accesses. this contract does not require a shift loop in production, eager versus lazy flags, new local caches, or a global memory/publication path for every operation.

## references

- intel SDM revision 093US, volume 2A: ADC pp. 3-9–11; BSF/BSR pp. 3-107–110 and their older-processor footnotes; BSWAP p. 3-111; BT/BTC/BTR/BTS pp. 3-112–119 and section 3.1.1.9/table 3-2; CLC p. 3-140; CMC p. 3-156; DEC pp. 3-262–263; INC pp. 3-457–458; LAHF p. 3-532. volume 1 section 3.4.1.1 for register views. [manual collection](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html).
- [intel SDM volume 2B, 253667-093US](https://cdrdv2.intel.com/v1/dl/getContent/671241): NEG pp. 4-158–159; NOT pp. 4-161–162; rotate pp. 4-533–537; SAHF pp. 4-601–602; shift pp. 4-603–607; SBB pp. 4-613–615; SHLD/SHRD pp. 4-640–645; STC p. 4-672. masked/effective-count distinctions and each entry's flags section govern definedness.
- [AMD APM volume 3, revision 3.37](https://docs.amd.com/v/u/en-US/24594_3.37): corresponding general-purpose instruction entries; BSF/BSR specify unchanged destination on zero and leave non-ZF flags undefined. the precise BSF/BSR outcomes above follow Intel 093US and fit those undefined AMD flag outputs; they do not select a complete vendor profile or hardware exception precedence.
