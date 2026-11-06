# scalar data and widths

extend [initial execution](../initial-execution/spec.md), [long-mode addressing](../long-mode-addressing/spec.md), [integer conditions](../integer-conditions/spec.md), [integer memory](../integer-memory/spec.md) and [stack and near control flow](../stack-and-near-control-flow/spec.md) with byte/word register views, the ordinary scalar forms below, extensions and conditional data movement. retain the imported 64-bit execution context, 64-bit addresses, fixed RX code/RW RAM, arithmetic flag mask, instruction boundaries, resource limits and artifact ownership.

the tables replace earlier coverage exclusions for these forms, including register forms of `03/2B/3B`. other execution modes, address-size override, segment/control state, new arithmetic families and architectural exception delivery are separate contracts. executing a 32-bit operand in this context does not establish 32-bit execution-mode support.

## widths, registers and prefixes

for the data families in this spec admit `[66] [REX] opcode`, with each bracket optional and at most one of each prefix, in that order. `d` below means 64 bits with `REX.W`, otherwise 16 with `66`, otherwise 32. `REX.W` takes precedence over `66`. a byte opcode always selects 8-bit data; `66` and `REX.W` do not widen it. address size remains 64 bits regardless of data width.

byte data-register codes `0..3` select AL/CL/DL/BL. without REX, codes `4..7` select AH/CH/DH/BH, bits `15:8` of the corresponding first four banks. with any REX, they select SPL/BPL/SIL/DIL instead; extended codes select R8B..R15B. even a REX with all fields zero changes this selection. these rules apply to opcode and ModR/M data-register operands, not opcode selectors or address-register terms.

read all register views, address terms and condition inputs from the incoming instruction state. an 8-bit low write replaces bits `7:0`; a high-byte write replaces bits `15:8`; a 16-bit write replaces bits `15:0`. preserve every other bit in that bank. a 32-bit write replaces bits `31:0` and clears bits `63:32`; a 64-bit write replaces the entire bank. overlapping views use the original source values. read-only operands never cause destination-width clearing.

REX.R/B extend the data-register fields that an encoding actually uses; REX.X/B retain the inherited address rules. a `/digit` selector uses only the three encoded reg bits, ignoring REX.R. accumulator-special forms always select the accumulator; REX.B does not select R8. unused REX fields remain ignored.

`67`, segment/LOCK/REP prefixes, repeated prefixes and REX followed by `66` remain unsupported. an unsupported prefix or ordering returns unsupported when identified without requesting a following opcode or operand. a truncated admitted prefix chain requires the next opcode byte and returns its fetch failure. existing branch and stack prefix admission is unchanged: `66` does not become admitted for those families through this data contract.

## ordinary data movement

`r/m` admits a register or every inherited memory address expression. `r` is a data register and `moffs` is an absolute address encoded in exactly eight little-endian bytes. it is not RIP-relative, sign-extended disp32 or an address narrowed to the data width.

| operation                               | encodings                          | data and immediate                                                          |
| --------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------- |
| MOV register to r/m, r/m to register    | `88 /r`, `8A /r`; `89 /r`, `8B /r` | first pair: 8 bits; second: `d`                                             |
| MOV immediate to register               | `B0+rb ib`; `B8+rd`                | byte/imm8; `d` with imm16/imm32/imm64 respectively                          |
| MOV immediate to r/m                    | `C6 /0 ib`; `C7 /0`                | byte/imm8; `d` with imm16 for 16, imm32 for 32, sign-extended imm32 for 64  |
| MOV accumulator from/to absolute memory | `A0`, `A2`; `A1`, `A3`             | AL byte; AX/EAX/RAX at `d`. every form consumes the full eight-byte address |
| LEA                                     | `8D /r`, memory ModR/M only        | compute the full effective address, then write its low `d` bits             |

MOV copies the selected source bits and applies the destination view rule. a memory store changes exactly the data width and no register. MOV and LEA preserve the complete admitted flag word. LEA performs no data access or address canonicality/mapping check, even for a noncanonical computed result; a 16-bit destination preserves its bank's upper 48 bits. `8D` with `mod=11` remains invalid immediately after ModR/M, without a hypothetical SIB/displacement fetch.

`C6/C7` selectors other than `/0` remain unsupported after ModR/M without reading an address tail or immediate. this does not classify other instructions sharing those opcode bytes as architecturally invalid.

## existing integer families at all data widths

each slash-separated pair below lists byte then `d` opcodes. r/m-first and register-first entries require `/r`, admitting register and memory r/m operands. the two directions remain distinct for SUB and CMP. no memory-to-memory form is added.

| operation | r/m first | register first | accumulator immediate | group selector |
| --------- | --------- | -------------- | --------------------- | -------------- |
| ADD       | `00 / 01` | `02 / 03`      | `04 / 05`             | `/0`           |
| OR        | `08 / 09` | `0A / 0B`      | `0C / 0D`             | `/1`           |
| AND       | `20 / 21` | `22 / 23`      | `24 / 25`             | `/4`           |
| SUB       | `28 / 29` | `2A / 2B`      | `2C / 2D`             | `/5`           |
| XOR       | `30 / 31` | `32 / 33`      | `34 / 35`             | `/6`           |
| CMP       | `38 / 39` | `3A / 3B`      | `3C / 3D`             | `/7`           |

the table's group-immediate forms are `80 /digit ib` for 8-bit data, `81 /digit` for `d`, and `83 /digit ib` for `d`. `83` sign-extends imm8 to `d`. `81` consumes imm16 for 16-bit data, imm32 for 32-bit data and sign-extended imm32 for 64-bit data. accumulator-immediate forms consume imm8 for byte data and the same width-dependent immediate as `81` for `d`.

TEST admits `84 /r` for r/m8 with r8, `85 /r` for r/m with register at `d`, `A8 ib` for AL, `A9` for the accumulator at `d`, `F6 /0 ib` for r/m8 and `F7 /0` for r/m at `d`. `A9/F7` use the same imm16/imm32/sign-extended-imm32 rule. TEST has no sign-extended imm8-to-wide form.

apply the inherited arithmetic and logical semantics at the selected width, including carry/borrow, signed overflow, auxiliary carry, low-byte parity, zero and sign. ADD/SUB/CMP define all six arithmetic flags. AND/OR/XOR/TEST set CF/OF to zero and define PF/ZF/SF; AF remains undefined only after successful completion. publish a concrete valid flag word under `0x8d7`, with bit 1 set. CMP and TEST preserve all operands and complete register banks. a successful modifying register form applies the view-write rule even for an identity result.

`80/81/83 /2,/3` and `F6/F7 /1..7` remain unsupported after ModR/M without reading a memory address tail or immediate. opcode `82` returns unsupported at the opcode without requesting ModR/M. ADC/SBB, unary arithmetic, shifts/rotates, bit operations and multiply/divide remain outside this contract; their absence does not change the meaning of admitted forms.

## extension and conditional movement

| family            | encoding               | source to destination widths                                        |
| ----------------- | ---------------------- | ------------------------------------------------------------------- |
| MOVSX             | `0F BE /r`; `0F BF /r` | 8 to 16/32/64; 16 to 32/64                                          |
| MOVZX             | `0F B6 /r`; `0F B7 /r` | 8 to 16/32/64; 16 to 32/64                                          |
| MOVSXD            | `63 /r`                | with `d=16`: 16 to 16; `d=32`: 32 to 32; `d=64`: 32 to 64           |
| CBW / CWDE / CDQE | `98`                   | at `d=16`: AL to AX; `d=32`: AX to EAX; `d=64`: EAX to RAX          |
| CWD / CDQ / CQO   | `99`                   | fill DX/EDX/RDX at `d` with the sign bit of AX/EAX/RAX respectively |
| SETcc             | `0F 90+cc /r`          | write 0 or 1 to r/m8                                                |
| CMOVcc            | `0F 40+cc /r`          | read r/m and conditionally move to a register at equal width `d`    |

MOVSX/MOVSXD sign-extend and MOVZX zero-extends to the destination operand width, then applies the register-view write. sign-extending a byte to EAX therefore clears RAX's upper half rather than sign-extending to 64 bits. same-width `63` forms are admitted copies with the corresponding view write, despite their discouraged use. `0F BF/B7` with `d=16` remain outside admission; return unsupported after the second opcode without requesting ModR/M. do not invent an invalid-encoding result for those excluded forms.

`98` sign-extends into its accumulator destination. `99` writes only its selected high-result register view; it preserves the entire accumulator. REX.R/X/B are ignored for both. all extension operations preserve every admitted flag.

SETcc and CMOVcc use exactly the sixteen conditions defined by [integer conditions](../integer-conditions/spec.md#conditions-and-transfers), including all aliases. they preserve the complete flag word and do not transfer control. SETcc's ModR/M reg field, including REX.R, is ignored rather than required to be `/0`; REX.B still selects a register operand or address base. SETcc is always byte-sized, including with `66` or REX.W. both true and false forms write their destination byte.

CMOVcc always reads its source, including a memory source when the condition is false. perform the full source read before any destination commit. on a true condition write the source using the destination view. on a false condition a 16- or 64-bit destination bank is unchanged; a 32-bit destination retains its old low 32 bits and clears its upper 32 bits. if the source read fails, preserve the entire original destination bank, including those upper bits. source/address/destination aliases read the incoming state.

the `0F` opcode map is selected before applying family-specific prefix coverage. for example, `48 0F` requires a second opcode byte and can fetch-fault; `48 0F 44` then requires ModR/M. a REX-prefixed Jcc remains unsupported after its second opcode, without fetching displacement. exclude unsupported map entries at the byte where admission can be decided; do not reject every REX-prefixed `0F` sequence before selecting its family.

## memory, commit and observation

use the inherited 64-bit address expressions and complete `next_pc`, including all prefixes and trailing immediate bytes. memory widths follow the operand actually accessed: byte/word MOV and ALU use one/two bytes; extension reads use the source width, not the destination width; CMOV reads its full data width; SETcc writes exactly one byte without an operand read.

ordinary loads, extension/CMOV sources, CMP and TEST require read permission. MOV stores and SETcc require write permission. modifying memory ALU operands retain the inherited write-intent preflight before reading backing storage; failures are classified as write. identity results, false CMOV and false SETcc do not skip their required access. preserve the memory owner's full-span range, canonicality, mapping/permission order and complete diagnostic tuple. byte accesses ending at the final u64 address are valid when mapped; a wider operand itself cannot wrap.

complete the admitted encoding before checking a data operand. read ModR/M, SIB, displacement/address and immediate bytes in encoding order through the bounded instruction source. a missing required byte wins over an unusable data address or a false condition. instruction length and domain-end behavior retain the initial contract. LEA's invalid register form and unsupported group selectors retain their early classification rules.

on a failed data access preserve every incoming bank, the entire actual flag word and all RAM; leave RIP at the instruction and retire zero for it. earlier completed effects remain committed. a successful instruction retires once and advances to complete `next_pc`. inherited budget/stop/decode/resource priorities, fault metadata lifetime, cached middle entries and repair/resume apply. read-only register aliases must not gain writes from generic width-normalization code.

instruction and register-view meaning belongs to x86; access validation belongs to memory; generated lowering preserves both. retain one authoritative embedding layout and the current artifact ownership. this contract does not choose a new state ABI, flags representation, inline memory sequence or final translation geometry.

## verification

run decoder checks, generated-Wasm cases and the shared public Node/Chrome path; `npm run check` is the implementation acceptance command. expectations come from independently authored literals/arithmetic and the referenced instruction definitions, not the decoder/lowering under test. cover every admitted opcode and legal width, register directions, memory/register/immediate variants, all sixteen banks, byte high/low views, ignored REX fields and address aliases. assembler mnemonic defaults are not an encoding oracle.

### literal distinctions

each row is a separate exact code image at `0x1000`, budget one, no stop and explicit limits sufficient to admit and retain it. initialize bank `i` to `0x1122334400000000+i`, then set RAX=`0x1122334455667788`, RSP=`0xaabbccddeeff0011`, RBX=`0x4010` and flags=`0x8d7`. RAM is 64 bytes of `a5` at `0x4000`; apply the row's overrides. success returns budget, retired one/remaining zero, RIP advanced by the packet length, no fault metadata and exact unchanged state/RAM except the stated result. flags are preserved unless a result is stated.

| bytes                                      | overrides                                                                                | required result                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `B4 80`                                    | —                                                                                        | RAX=`0x1122334455668088`                                                      |
| `40 B4 80` / `48 B4 80`                    | —                                                                                        | RSP=`0xaabbccddeeff0080`; RAX unchanged                                       |
| `88 E0`                                    | —                                                                                        | RAX=`0x1122334455667777`; AL reads old AH                                     |
| `66 B8 00 80`                              | —                                                                                        | RAX=`0x1122334455668000`                                                      |
| `66 48 B8 88 77 66 55 44 33 22 11`         | RAX=0                                                                                    | RAX=`0x1122334455667788`; consume all eight immediate bytes                   |
| `48 C7 C0 00 00 00 80`                     | —                                                                                        | RAX=`0xffffffff80000000`                                                      |
| `66 44 8B 03`                              | word at `0x4010`=`0x8000`                                                                | R8=`0x1122334400008000`; RAM unchanged                                        |
| `0F BE C4` / `66 0F BE C4`                 | RAX=`0x11223344556680ff`                                                                 | RAX=`0xffffff80` / `0x112233445566ff80`                                       |
| `48 0F BE 03`                              | RAM is exactly one byte `80` at `0x4010`                                                 | RAX=`0xffffffffffffff80`; read one byte                                       |
| `0F BF 03` / `48 0F BF 03`                 | word at `0x4010`=`0x8000`                                                                | RAX=`0xffff8000` / `0xffffffffffff8000`                                       |
| `66 63 C0` / `63 C0` / `48 63 C0`          | RAX=`0x1122334480008001`                                                                 | RAX=`0x1122334480008001` / `0x80008001` / `0xffffffff80008001`                |
| `66 98`                                    | RAX=`0x1122334455667780`                                                                 | RAX=`0x112233445566ff80`                                                      |
| `98`                                       | RAX=`0x1122334455668000`                                                                 | RAX=`0xffff8000`                                                              |
| `66 99` / `99` / `48 99`                   | RAX=`0x8000000080008000`                                                                 | RDX=`0x112233440000ffff` / `0xffffffff` / `0xffffffffffffffff`; RAX unchanged |
| `66 8D 40 01`                              | RAX=`0x112233445566ffff`                                                                 | RAX=`0x1122334455660000`; no data access despite noncanonical address         |
| `0F 94 FC` / `40 0F 94 FC`                 | —                                                                                        | RAX=`0x1122334455660188` / RSP=`0xaabbccddeeff0001`; reg-field bits ignored   |
| `0F 44 C1` / `66 0F 44 C1` / `48 0F 44 C1` | flags=`0x2`                                                                              | RAX=`0x55667788` / unchanged / unchanged                                      |
| `0F 44 00`                                 | RAX=`0x100004000`, flags=`0x2`, RAM is exactly four bytes `78 56 34 12` at `0x100004000` | RAX=`0x4000`; false condition still reads old full RAX address                |
| `66 A1 00 40 00 00 01 00 00 00`            | RAM is exactly two bytes `34 12` at `0x100004000`                                        | RAX=`0x1122334455661234`; consume eight address bytes, read two               |
| `41 A0 00 40 00 00 01 00 00 00`            | RAM is exactly one byte `80` at `0x100004000`                                            | RAX=`0x1122334455667780`; R8 unchanged                                        |
| `66 05 01 00`                              | RAX=`0x112233445566ffff`                                                                 | RAX=`0x1122334455660000`, exact flags=`0x57`                                  |
| `66 83 C0 01`                              | RAX=`0x1122334455667fff`                                                                 | RAX=`0x1122334455668000`, exact flags=`0x896`                                 |
| `00 E0`                                    | RAX=`0x112233445566ff01`                                                                 | RAX=`0x112233445566ff00`, exact flags=`0x57`                                  |
| `F6 C4 80`                                 | RAX=`0x11223344556680ff`                                                                 | banks/RAM unchanged; defined flags under `0x8c7`=`0x82`                       |
| `66 C7 05 00 00 00 00 34 12`               | RAM is exactly two bytes `a5 a5` at `0x1009`                                             | RAM=`34 12`; RIP=`0x1009`                                                     |
| `88 03`                                    | RBX=`0xffffffffffffffff`, RAM is exactly one byte `a5` there                             | RAM=`88`; full register banks preserved                                       |

all hexadecimal register values name complete 64-bit banks, including leading zero bits. logical checks mask only AF for the completed writer and still validate the full word. later preserving instructions, faults and resumes preserve the actual AF value exactly.

### failures, entries and falsifiers

- repeat the false `0F 44 00` case with its high address unmapped. require data-fault/read/unmapped at `0x100004000`, width four, unchanged full RAX/flags/RAM and original RIP, retired zero/remaining one. repeat at 16/64-bit widths and with a true condition. this rejects skipped false reads, address truncation and clearing upper bits before fault checks.
- compare `48 0F BE 03` with a one-byte mapping against `48 0F BF 03` with only one of its two required bytes mapped. the first succeeds; the second faults with source width two and no destination change. verify zero extension with negative-looking source patterns separately.
- SETcc requires a write for either condition and never requires an operand read. check generated execution with a forbidden read import. require one-byte writes and exact guards, high-byte destination preservation and write failures on code. for both SETcc and CMOVcc, check all sixteen conditions against an independent truth table over all 32 combinations of CF/PF/ZF/SF/OF, with AF separately set and clear and exactly preserved. merely obtaining one true and one false result per condition cannot distinguish incorrect composite predicates.
- modifying byte/word ALU destinations preflight the whole write span, even for OR-zero or AND-minus-one. a word crossing writable RAM into code fails at the first disallowed byte without a partial store. word access starting at the final u64 address reports range failure, width two and first-outside-domain `2^64`; byte access there can succeed.
- truncate every admitted immediate, moffs address, SIB and displacement at each required byte, including `66 REX.W` forms. combine truncation with an unmapped/noncanonical data address. verify `66`, `66 48`, `48 0F`, and `48 0F 44` required-byte failures. separately check repeated/reversed/unsupported prefixes, excluded `66 0F BF/B7`, unsupported group selectors and unchanged prefixed Jcc/stack coverage without speculative operand access.
- use a sequence that modifies AH, reads AX/EAX/RAX, overwrites AL and consumes an arithmetic condition; separately use SPL/R12B, high-byte source/destination overlap and a destination aliasing its full-width address. inspect every complete bank and every guard byte at observation boundaries. require live flags to reach SETcc/CMOVcc/Jcc before a later loop counter overwrites them.
- execute an earlier memory update before a later faulting extension, CMOV, SETcc or narrow ALU access. budget/stop before that instruction must win; repair only its operand and resume without replaying the prefix. include a non-idempotent update so replay changes observable memory. preserve exact flags, including AF=1, on failed instructions and preserving successors.
- enter admitted suffixes without running predecessors, then reuse the same retained artifact after changing registers, flags, addresses and RAM. establish reuse without new compilation. vary true/false conditions and high-byte source values across invocations; cover overlapping-owner eviction, translation frontiers, zero/short/exact budgets and successful exits after earlier faults without stale metadata.

for an exact replay discriminator, use `80 03 01 0F 44 06` at `0x1000`, the literal bank/flag initialization, byte zero at `0x4010`, RSI=`0x7000` and budget three. ADD increments that byte to one and sets flags=`0x2`; false CMOVZ then faults on a four-byte read at `0x7000`. require RIP=`0x1003`, retired one/remaining two, full RAX unchanged and every other byte guarded. change only RSI to `0x4014` while idle and resume with budget one. require RIP=`0x1006`, RAX=`0x55667788`, flags=`0x2` and the counter byte still one, with no stale fault metadata. replaying ADD would increment it a second time. separately stop at `0x1003` or exhaust budget one there and require the committed prefix without a CMOV access.

## performance

compare unchanged 32/64-bit arithmetic, logical/Jcc, addressing and stack/transfer workloads before/after with identical guest bytes, inputs, limits, observation work and checked outputs. include first-use and code-churn decode costs as well as retained execution; a warm loop alone cannot expose larger decoder or compilation costs.

characterize new byte/word operations, alternating partial writes/full-bank reads, sign/zero extension, high-byte versus REX low-byte views and conditional data movement separately. include true/false register and memory sources, changing imported conditions/operands, aliases, live-register pressure, fault/repair paths and short resumed runs. check full state, guards, flags and exits/counts outside timed work. a false CMOV memory read cannot be removed to improve its measurement.

retain matched warmup histories, balanced repeated samples, early/later reused windows, translation/browser compilation/instantiation costs, first completion, generated/cache bytes and native-entry/dispatch counts. preserve raw samples and environment/artifact identity. shared-process first completion is not independent cold evidence; new forms unsupported by the old core have no old executable baseline. resolve repeatable regressions outside observed variation before acceptance; do not invent a percentage threshold from noisy short samples.

mask/merge, width-specialized locals, selective publication and flag-demand analysis are candidates under these semantics. compare alternative lowerings on the same bytes and observations before selecting them. broadening register coverage does not require all register views to have independent caches or every future architectural state field to be live in each generated function.

## references

- intel SDM revision 093US, volume 1 section 3.4.1.1: register views and write rules.
- [intel SDM volume 2A](https://cdrdv2.intel.com/v1/dl/getContent/671199), 253666-093US: sections 2.1.1 and 2.2.1.1–2.2.1.6; ADD/AND/CMP; CBW/CWDE/CDQE pages 3-138–3-139; CMOVcc pages 3-157–3-160; CWD/CDQ/CQO pages 3-257–3-258; LEA pages 3-547–3-549.
- intel SDM revision 093US, volume 2B: MOV pages 4-28–4-31; MOVSX/MOVSXD pages 4-120–4-121; MOVZX pages 4-130–4-131; OR, SETcc pages 4-623–4-625, SUB and TEST. volume 2D: XOR and opcode tables. [manual collection](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html).
