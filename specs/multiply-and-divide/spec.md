# multiply and divide

extend [scalar data and widths](../scalar-data-and-widths/spec.md) and [integer arithmetic and bits](../integer-arithmetic-and-bits/spec.md) with the classic signed/unsigned multiply and divide families, full-width products, quotient/remainder pairs and precise divide errors. use the inherited imported 64-bit execution context, register views, 64-bit addresses, fixed RX code/RW RAM, concrete flags under `0x8d7`, instruction boundaries and artifact ownership.

the operand widths below do not add 16/32-bit execution modes. mode/context changes, general exception delivery, x87/SIMD arithmetic, optional MULX/ADX/APX forms and other scalar/control families have separate contracts.

## forms and decoding

admit `[66] [REX] opcode`, with each prefix optional and present at most once, in that order. `d` is 64 with REX.W, otherwise 16 with `66`, otherwise 32. byte opcodes remain 8 bits regardless of `66` or REX.W. inherit high-byte versus REX low-byte selection, full incoming address values, all inherited r/m address expressions and complete `next_pc` rules.

| family               | encoding            | operands and result                                                          |
| -------------------- | ------------------- | ---------------------------------------------------------------------------- |
| MUL                  | `F6 /4`; `F7 /4`    | r/m8 or r/m at `d`; implicit accumulator input, double-width result          |
| IMUL, one operand    | `F6 /5`; `F7 /5`    | the corresponding signed multiply                                            |
| IMUL, two operands   | `0F AF /r`          | register destination and r/m source at `d`; low `d` result                   |
| IMUL, three operands | `69 /r`; `6B /r ib` | register destination, r/m source and signed immediate at `d`; low `d` result |
| DIV                  | `F6 /6`; `F7 /6`    | r/m8 or r/m at `d`; double-width implicit dividend, quotient/remainder pair  |
| IDIV                 | `F6 /7`; `F7 /7`    | the corresponding signed divide                                              |

`69` consumes imm16 at width 16, imm32 at width 32 and sign-extended imm32 at width 64. `6B` sign-extends imm8 to `d`. both multiply the r/m source by that signed immediate; the old destination is not another multiplicand. `0F AF`, `69` and `6B` have no byte form. an assembler's two-operand immediate shorthand uses the same three-operand encoding with source equal to destination.

REX.R extends the destination register of `/r` forms, but does not extend the `F6/F7` opcode selector. REX.B extends the explicit r/m register or inherited address term; it never redirects the implicit accumulator or high-result bank. any REX changes encoded byte codes 4..7 to SPL/BPL/SIL/DIL. implicit AL, AH and AX retain their identities, including the AH remainder of a byte divide.

these forms replace the inherited `F6/F7 /4..7` exclusion. retain `/0` TEST, `/2,/3` NOT/NEG and the unsupported `/1` classification after ModR/M without fetching a hypothetical address tail or immediate. all other prefix and coverage rules remain unchanged, including unsupported LOCK/REP, `67`, segment prefixes and repeated/reversed prefixes. unsupported coverage is not an architectural invalid-encoding claim.

decode every required admitted byte before operand access or arithmetic checks: ModR/M, SIB, displacement, then any immediate. a missing immediate wins over an unusable source address. `F6/F7 /4..7` consume no immediate. RIP-relative sources use the completed instruction's `next_pc`, including the `69/6B` immediate. retain the instruction-length and address-domain diagnostics.

## products and register writes

capture every source register view and effective-address term from the incoming instruction state before writing either result. let `w` be the operand width, `M=2^w`, `u_w` the unsigned interpretation of a width-limited value and `s_w` its two's-complement signed interpretation. products below are mathematical integers before truncation.

| width | one-operand multiply input | full product destination | divide dividend | quotient / remainder |
| ----- | -------------------------- | ------------------------ | --------------- | -------------------- |
| 8     | AL and explicit source     | AX                       | AX              | AL / AH              |
| 16    | AX and explicit source     | DX:AX                    | DX:AX           | AX / DX              |
| 32    | EAX and explicit source    | EDX:EAX                  | EDX:EAX         | EAX / EDX            |
| 64    | RAX and explicit source    | RDX:RAX                  | RDX:RAX         | RAX / RDX            |

one-operand MUL computes `u_w(accumulator) * u_w(source)`. one-operand IMUL computes `s_w(accumulator) * s_w(source)`. encode the full product modulo `2^(2w)` in the listed result: low half in the accumulator and high half in the high-result view. a byte multiply replaces AX and preserves the rest of RAX; it does not write RDX. word results preserve the upper 48 bits of both banks. successful 32-bit results clear the upper halves of both RAX and RDX, including zero/identity results.

two-operand IMUL computes `s_w(old destination) * s_w(source)`. three-operand IMUL computes `s_w(source) * signed immediate`. write only the low `w` result to the explicit destination using its view-write rule; do not write an implicit high half. aliases use the captured incoming values.

MUL sets CF and OF together iff the mathematical unsigned product is at least `M`. every IMUL form sets them together iff its signed product is outside `[-2^(w-1), 2^(w-1)-1]`; equivalently the full product is not the sign extension of its low half. a nonzero signed high half alone does not imply overflow. SF/ZF/AF/PF are undefined after successful multiplication. produce a concrete valid flag word with fixed bit 1, without imposing a particular value on those undefined flags. multiplication overflow completes normally; it is not a divide error.

## quotient and remainder

for byte division, read the full incoming AX as a 16-bit dividend. at larger widths, form the `2w`-bit pattern `N = u_w(high) * M + u_w(low)` from the pair above. DIV interprets this pattern and its explicit divisor as unsigned. IDIV interprets the entire pattern as a signed `2w`-bit integer and the divisor as signed `w` bits. neither instruction implicitly performs CWD/CDQ/CQO or discards a nonzero high half.

DIV with divisor `D != 0` computes `q=floor(N/D)` and `r=N-q*D`. success requires `0 <= q < M`; then `0 <= r < D`. IDIV with signed dividend `S` and divisor `D != 0` computes `q=trunc(S/D)` toward zero and `r=S-q*D`. success requires `-2^(w-1) <= q < 2^(w-1)`; a nonzero remainder has the dividend's sign and `abs(r) < abs(D)`.

on success write the quotient and remainder together to the listed views, with the same byte/word/32/64-bit bank rules as multiplication. byte division replaces AL and AH while preserving the rest of RAX and all of RDX. all six arithmetic flags are undefined after successful DIV/IDIV; publish concrete valid flags under `0x8d7`. undefinedness belongs to that completed writer: subsequent preserving operations and failures retain the actual observed bits.

a zero divisor or an out-of-range mathematical quotient produces `#DE`, vector zero, without an error code. distinguish unsigned versus signed quotient ranges, including a quotient that fits an unsigned word but not its signed counterpart. both operands of a signed divide can include their minimum value; taking a signed host absolute value or dividing a host minimum by minus one must not trap before the architectural range decision.

## access, divide error and resumption

all memory operands in this spec are read-only sources. require a complete checked read of exactly `w/8` bytes, with inherited range/canonicality/mapping/permission order and diagnostics. sources may reside in readable code. no write-intent check or store is required, even though the instruction writes result registers. zero multipliers, a zero low dividend or an already-provable quotient overflow do not skip a required source read.

the reached order is inherited budget, stop, required fetch/decode/coverage, translation/resource admission, source-memory read, then divide checks. a source access failure wins over divide error, even if the incoming high half would prove overflow. unavailable code or speculative discovery beyond the reached prefix cannot report a divide error. probing/translating a supported DIV/IDIV does not inspect live arithmetic operands or perform data accesses.

on either a source failure or divide error, preserve every incoming register bank, the entire actual flag word and all RAM. leave RIP at the failing instruction, do not retire it and do not decrement its remaining budget. no attempted quotient, remainder or 32-bit upper-half clearing may escape. earlier completed instructions retain their effects and retirement counts.

extend the controlled public `run` outcomes with `reason: 'divide-error'`. its `state.rip` identifies the faulting instruction and its counts obey `retired = supplied budget - remaining`. `fault` is absent: a divide error has no data address, access width, failing byte or memory cause. vector zero and absence of an error code follow from this reason; no new exception payload or architectural-state field is needed. preserve existing reason meanings and access-fault records.

divide-error leaves the CPU idle and usable for state/memory inspection, mutation, another run or disposal. rerunning unchanged operands reports the same error without progress. repairing only the divisor or dividend and resuming executes the instruction once, without replaying predecessors. later budget/stop/success/resource/unsupported/access/target outcomes contain only their own metadata; an earlier access fault cannot leak into divide-error. unexpected Wasm traps, invalid modules, panics and compilation failures retain their engine-failure behavior.

code/context identity remains fixed. cached middle entries must read the current full dividend, explicit source, address terms and actual flags even when no predecessor ran. changing operands or repairing a divide error does not invalidate immutable code or require a new compilation. no IDT lookup, handler frame, CR2 update, interrupt eligibility or guest event delivery is introduced here.

## verification

`npm run check` is the implementation acceptance command. cover decoder refinement, real generated-Wasm execution and the shared public Node/Chrome path. x86 owns forms and mathematical outcomes; memory owns checked source access; lowering owns captured operands, paired commit and precise exits; the embedding/host expose the controlled reason. use the existing source and test organization without a second execution engine or new dependencies.

author expectations independently of production decoding and arithmetic helpers. use exact integer mathematical products/division for the oracle, including 128-bit operands. compare all sixteen banks, constrained flags, complete guarded RAM/code, exact RIP/reason/retired/remaining and complete access diagnostics. compare multiply flags under `0x803` and successful divide flags under fixed bit `0x2`, while also checking whole-word validity. compare the complete actual flag word on every failure and preserving successor.

### literal distinctions

each row is a separate exact code image at `0x1000`, budget one, no stop and explicit sufficient limits. initialize bank `i` to `0x1122334400000000+i`, then RAX=`0x1122334455667788`, RDX=`0x99aabbccddeeff11`, RCX=`0x1122334400000001`, RBX=`0x4010`, RSP=`0xaabbccddeeff0011` and flags=`0x8d7`. RAM is 64 `a5` bytes at `0x4000`; apply row overrides. unlisted banks and all memory remain unchanged. successful packets return budget, retired one/remaining zero, RIP advanced by their full length and no fault. `CF/OF` below gives both bits; other successful arithmetic flags remain undefined. a `#DE` row returns divide-error, retired zero/remaining one, RIP=`0x1000`, no fault and the complete incoming state/RAM.

| bytes                   | overrides                                                                    | required result                                                           |
| ----------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `F6 E4`                 | RAX=`0x1122334455660305`                                                     | RAX=`0x112233445566000f`, CF/OF=0; explicit AH input                      |
| `40 F6 E4`              | the same                                                                     | RAX=`0x1122334455660055`, CF/OF=0; explicit SPL input, implicit AX output |
| `F6 EC`                 | RAX=`0x112233445566fe80`                                                     | RAX=`0x1122334455660100`, CF/OF=1                                         |
| `66 F7 E1`              | RAX=`0x112233445566ffff`, RCX=2                                              | RAX=`0x112233445566fffe`, RDX=`0x99aabbccddee0001`, CF/OF=1               |
| `F7 E1`                 | RAX=`0x11223344ffffffff`, RCX=2                                              | RAX=`0xfffffffe`, RDX=1, CF/OF=1                                          |
| `48 F7 E0`              | RAX=`0xffffffffffffffff`                                                     | RAX=1, RDX=`0xfffffffffffffffe`, CF/OF=1                                  |
| `48 F7 E9`              | RAX=`0xffffffffffffffff`, RCX=2                                              | RAX=`0xfffffffffffffffe`, RDX=`0xffffffffffffffff`, CF/OF=0               |
| `0F AF C1`              | RAX=`0x1122334480000000`, RCX=2                                              | RAX=0, RDX unchanged, CF/OF=1                                             |
| `66 48 0F AF C1`        | RAX=3, RCX=`0xfffffffffffffffe`                                              | RAX=`0xfffffffffffffffa`, RDX unchanged, CF/OF=0                          |
| `48 6B C1 FF`           | RCX=`0x8000000000000000`                                                     | RAX=`0x8000000000000000`, CF/OF=1; imm8 is minus one                      |
| `48 69 C1 00 00 00 80`  | RCX=2                                                                        | RAX=`0xffffffff00000000`, CF/OF=0; imm32 is sign-extended                 |
| `66 69 C1 FF FF`        | RCX=`0x1122334400008000`                                                     | RAX=`0x1122334455668000`, CF/OF=1                                         |
| `F6 F1`                 | RAX=`0x11223344556600ff`, RCX=2                                              | RAX=`0x112233445566017f`; quotient 127, remainder 1                       |
| `F6 F1`                 | RAX=`0x1122334455660100`, RCX=1                                              | `#DE`; quotient 256 does not fit AL                                       |
| `F6 F9`                 | RAX=`0x112233445566fff9`, RCX=3                                              | RAX=`0x112233445566fffe`; quotient -2, remainder -1                       |
| `F6 FC`                 | RAX=`0x112233445566fffe`                                                     | RAX=`0x1122334455660002`; incoming AH is the divisor -1                   |
| `40 F6 F4`              | RAX=`0x1122334455660208`, RSP=`0xaabbccddeeff0008`                           | RAX=`0x1122334455660041`; RSP unchanged                                   |
| `66 F7 F1`              | RAX=`0x1122334455660000`, RDX=`0x99aabbccddee0001`, RCX=2                    | RAX=`0x1122334455668000`, RDX=`0x99aabbccddee0000`                        |
| `F7 F9`                 | RAX=`0x1122334480000000`, RDX=`0x99aabbcc00000000`, RCX=`0xffffffff`         | RAX=`0x80000000`, RDX=0; the full dividend is positive                    |
| `48 F7 F1`              | RAX=0, RDX=1, RCX=2                                                          | RAX=`0x8000000000000000`, RDX=0                                           |
| `48 F7 F1`              | RAX=`0xffffffffffffffff`, RDX=`0xfffffffffffffffe`, RCX=`0xffffffffffffffff` | RAX=`0xffffffffffffffff`, RDX=`0xfffffffffffffffe`                        |
| `48 F7 F1`              | RAX=0, RDX=2, RCX=2                                                          | `#DE`; nonzero divisor, quotient overflow                                 |
| `48 F7 F9`              | RAX=0, RDX=1, RCX=3                                                          | RAX=`0x5555555555555555`, RDX=1                                           |
| `48 F7 F9`              | RAX=`0x8000000000000000`, RDX=0, RCX=`0xffffffffffffffff`                    | RAX=`0x8000000000000000`, RDX=0; valid negative quotient                  |
| `48 F7 F9`              | RAX=`0x8000000000000000`, RDX=0, RCX=1                                       | `#DE`; positive quotient does not fit signed 64 bits                      |
| `48 F7 F9`              | RAX=`0x8000000000000000`, RDX=`0xffffffffffffffff`, RCX=`0xffffffffffffffff` | `#DE`; signed minimum divided by minus one                                |
| `48 F7 F9`              | RAX=0, RDX=`0x8000000000000000`, RCX=`0xffffffffffffffff`                    | `#DE`; minimum signed 128-bit dividend divided by minus one               |
| `48 F7 F9`              | RAX=`0xffffffffffffffff`, RDX=`0xffffffffffffffff`, RCX=`0x8000000000000000` | RAX=0, RDX=`0xffffffffffffffff`                                           |
| `48 F7 F1` / `48 F7 F9` | RCX=0                                                                        | `#DE`; exact whole-bank and flag preservation                             |
| `48 F7 20`              | RAX=`0x4010`, qword at `0x4010`=3                                            | RAX=`0xc030`, RDX=0, CF/OF=0; read the old RAX address                    |
| `48 F7 32`              | RAX=0, RDX=`0x4010`, qword at `0x4010`=`0x8000000000000000`                  | RAX=`0x8020`, RDX=0; address and high dividend alias                      |

### arithmetic, faults and retained entries

- exhaust byte MUL/one-operand IMUL input pairs. for byte DIV/IDIV cover every divisor and the exact quotient transition into/out of range, zero dividend/divisor, minimum/maximum signed values, all sign combinations and nonzero remainders; sweep all 16-bit dividend patterns for selected divisors `0,1,2,3,127,128,255`. widen the same boundary families to 16/32/64, including arbitrary non-sign-extended high halves, `high < divisor`, `high == divisor` and `high > divisor`, long carries in 128-bit multiplication and division near the maximum valid unsigned quotient.
- cover `69/6B` sign-extension boundaries and ignored old destinations, two-operand self-aliases, every explicit register bank, byte high/REX views, ignored selector extensions and implicit-result/address/source aliases. unsigned DIV using its own high-dividend view as divisor (`AH/DX/EDX/RDX`) always fails: it is zero, or its quotient is at least `2^w`. include successful signed aliases and both signed-minimum cases in the table.
- decode truncated tails/immediates at every required byte, combined with unusable sources. preserve unsupported prefix/selector boundaries, complete RIP-relative immediate length, exact-width reads, high addresses, split spans, noncanonical/unmapped sources and readable-code operands. zero multiplication and provable divide overflow still perform the source read. source failures and divide errors must preserve upper bank bits and all actual flags.
- use `80 03 01 48 F7 F1` with byte zero at `0x4010`, RAX=7, RDX=0, RCX=0 and budget three. require the prefix counter one and flags=`0x2`, then divide-error at `0x1003`, retired one/remaining two. repair only RCX to 3 and resume budget one: RAX=2, RDX=1, RIP=`0x1006`, counter still one, no fault. budget one or stop at `0x1003` prevents the divide. repeat with quotient overflow, IDIV and a memory divisor repaired through idle RAM mutation.
- rerun an unchanged divide error, repair it, then enter retained multiply/divide suffixes directly with changed banks, flags and RAM. assert no new compilation where the artifact remains retained; force owner eviction/reinstallation and run the same cases again. a cached DIV still executes when translation limits would refuse a new artifact. source-memory and divide checks occur only after required admission on an uncached path.
- chain defined CF/OF from each multiply form into SETcc/CMOVcc/Jcc and ADC/SBB before another flag writer. observe undefined flags after success, then check MOV/NOT/LAHF, a subsequent access failure and divide error against those actual bits. alternate divide-error with budget zero, stop, success, unsupported, resource, fetch/data/target failures; verify reason-local diagnostics and idle/resumable lifecycle. keep the existing rejected-promise behavior for genuine engine failures.
- migrate existing unsupported sentinels that use `F6/F7 /4..7` or `0F AF` to a still-excluded form, preserving their required-byte, access-order and retained-frontier assertions. preserve existing transport/lifecycle checks when extending the reason set.

## performance

compare unchanged scalar, logical/conditional, addressing, memory, stack/transfer and short-resume workloads before/after with identical guest bytes, inputs, limits, observation policy and checked outputs. include first completion, translation/code churn and early/later retained execution; record browser compilation/instantiation, generated/cache bytes, helper calls where relevant, native entries and dispatches. a unit without these operations should not acquire unconditional wide-arithmetic helpers or full-state publication costs.

characterize new forms separately: one-operand full products versus truncated IMUL, all widths and memory sources, CF/OF consumers, small and large high halves, unsigned and signed division, quotient boundaries, changing signs and repaired errors. cover valid 128/64 division that cannot be replaced by low-half i64 division. use intervals large enough to distinguish execution cost from timer quantization; retain raw balanced repeats, input/output identities, environment and artifact hashes. check complete state/RAM/guards and exact exits/counts outside timing. newly admitted forms have no executable old baseline.

wide arithmetic must be exact; floating-point conversion is not a substitute for the full product/dividend. guard zero divisors and signed host overflow before any trapping division. a fallback's work must be bounded by operand width rather than the numerical quotient; repeated subtraction proportional to a potentially 64-bit quotient is unsuitable. measure inline versus helper costs before choosing an optimization, without requiring a particular limb algorithm, compiler helper ABI, flags representation or translation geometry. retain the old-path comparison and resolve repeatable regressions beyond observed variation, including same-core and matched-host controls before attributing small resume differences.

## references

- [intel SDM volume 2A, 253666-093US](https://cdrdv2.intel.com/v1/dl/getContent/671199): DIV pp. 3-264–266, IDIV pp. 3-448–450, IMUL pp. 3-451–454. [volume 2B, 253667-093US](https://cdrdv2.intel.com/v1/dl/getContent/671241): MUL pp. 4-140–141. [manual collection](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html).
- [intel SDM volume 3A, 253668-093US](https://cdrdv2.intel.com/v1/dl/getContent/671190), section 7.15, Event 0, p. 7-25: divide error, faulting instruction, no error code and unchanged program state.
- [WebAssembly numeric semantics](https://webassembly.github.io/spec/core/exec/numerics.html#op-idiv) and [numeric instruction execution](https://webassembly.github.io/spec/core/exec/instructions.html#numeric-instructions): word-width multiplication/division and trapping partial operations. these do not supply x86's double-width result, quotient range or restart contract.
