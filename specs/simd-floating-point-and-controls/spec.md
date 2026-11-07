# simd floating point and controls

extend [simd integer and data](../simd-integer-and-data/spec.md) with legacy SSE/SSE2 single- and double-precision execution, MXCSR control/status, numeric fault outcomes and the remaining raw operations listed below. include scalar and packed forms, checked memory, imported state, retained entries and instruction-specific exception publication.

use every existing imported mode profile under the enabled SSE/SSE2 view: CR0.EM and TS are clear, CR4.OSFXSR and CR4.OSXMMEXCPT are set. this profile supports DAZ and all sixteen defined MXCSR bits. these are execution assumptions, not guest control-register implementations or a complete CPUID claim. guest feature-enable writes, disabled-state #NM/#UD, handler delivery, x87/MMX, state images, non-temporal/masked stores, fences, SSE3+, VEX/EVEX and wider registers remain separate work.

## MXCSR state and public API

add synchronous idle methods:

```ts
readMxcsr(): number;
setMxcsr(mxcsr: number): void;
```

construction initializes MXCSR to `0x1f80`. the supported mask is `0x0000ffff`: exception status IE/DE/ZE/OE/UE/PE occupy bits0-5, DAZ bit6, exception masks bits7-12, rounding control bits13-14 and FTZ bit15. a set mask bit masks its exception. RC encodings0/1/2/3 select nearest-even, toward negative infinity, toward positive infinity and toward zero. DAZ support is an explicit property of this execution profile.

`readMxcsr` returns the architectural unsigned value, including accrued status. `setMxcsr` accepts only a primitive finite integer number in `0..0xffff`, without coercion; normalize negative zero to zero. reject other values with `TypeError` before publication. follow the existing idle/running/pending-compilation/failed/disposed lifecycle. successful import replaces the complete value, clears guest diagnostics and preserves GPRs, flags, RIP, XMM banks, context, memory and budgets. rejection changes nothing. no getter-bearing input object or numeric coercion hook is introduced.

keep the existing three-field `State`, run-result GPR projection and sixteen-bank XMM API. `setState`, `setXmmState` and `setContext` preserve MXCSR, including status. diagnostic clearing, successful raw/integer instructions, compilation and eviction also preserve it. a complete idle checkpoint now includes MXCSR alongside both register projections, context and memory. neither `RunResult` nor scalar imports must materialize XMM or MXCSR snapshots implicitly.

MXCSR is invocation data. changing it through either API or a guest instruction does not change context version or invalidate translations. every admitted entry observes current controls and accrued status. unmasking a previously set status bit does not itself cause an exception; only a reportable condition in the current instruction can do so.

append private MXCSR storage after the existing448-byte RunState transport without changing any current field offset, the176-byte scalar import, the256-byte XMM import or the five-argument generated entry ABI. expose a validated MXCSR offset and four-byte extent in the layout descriptor, with a separate four-byte little-endian import. require its full extent to be within declared transport/private memory and disjoint from existing state/scratch. validate required exports and layout before publishing a CPU; construction rejection cleans up the owned instance. retain unsigned wasm32 pointer handling, including pointers above2GiB and extents ending exactly at private memory end.

## selected encodings

only the legacy forms in these tables are admitted. NP means no mandatory66/F2/F3 selector. inherited prefix scanning still determines effective REX, address/segment overrides, repeated-size-prefix presence and required-byte fetches. F2/F3 retain precedence over66 regardless of physical order; a later legacy prefix cancels an earlier REX. an unimplemented selector remains unsupported without falling back to another row.

| family                          | mandatory selector and opcode after0F   | admitted forms                                                                                                                           |
| ------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| add, subtract, multiply, divide | `58`, `5c`, `59`, `5e`                  | NP: `ADDPS/SUBPS/MULPS/DIVPS`;66: `ADDPD/SUBPD/MULPD/DIVPD`;F3: `ADDSS/SUBSS/MULSS/DIVSS`;F2: `ADDSD/SUBSD/MULSD/DIVSD`                  |
| square root                     | `51`                                    | NP/66/F3/F2: `SQRTPS/SQRTPD/SQRTSS/SQRTSD`                                                                                               |
| minimum and maximum             | `5d`, `5f`                              | NP/66/F3/F2: `MINPS/MINPD/MINSS/MINSD` and `MAXPS/MAXPD/MAXSS/MAXSD`                                                                     |
| vector-mask comparisons         | `c2 /r ib`                              | NP/66/F3/F2: `CMPPS/CMPPD/CMPSS/CMPSD`                                                                                                   |
| flags comparisons               | NP/66 `2f`; NP/66 `2e`                  | `COMISS/COMISD`; `UCOMISS/UCOMISD`                                                                                                       |
| reciprocal approximations       | NP/F3 `53`; NP/F3 `52`                  | `RCPPS/RCPSS`; `RSQRTPS/RSQRTSS`; no double-precision analogue                                                                           |
| raw logic                       | NP/66 `54`, `55`, `56`, `57`            | `ANDPS/ANDPD`, `ANDNPS/ANDNPD`, `ORPS/ORPD`, `XORPS/XORPD`                                                                               |
| raw interleave                  | NP/66 `14`, `15`                        | `UNPCKLPS/UNPCKLPD`, `UNPCKHPS/UNPCKHPD`                                                                                                 |
| raw half moves                  | NP `12/13`, `16/17`;66 `12/13`, `16/17` | memory `MOVLPS`, `MOVHPS`, `MOVLPD`, `MOVHPD` in both directions; NP `12` register form is `MOVHLPS`, NP `16` register form is `MOVLHPS` |
| MXCSR memory                    | NP `ae /2`, NP `ae /3`                  | `LDMXCSR m32`, `STMXCSR m32`; actual width4 regardless of CS.D or REX.W                                                                  |

| conversion               | mandatory selector and opcode after0F | source and destination                                                                                                   |
| ------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `CVTPS2PD`               | NP `5a`                               | low two f32 from XMM/m64 to two f64                                                                                      |
| `CVTPD2PS`               | 66 `5a`                               | two f64 from XMM/m128 to low two f32, clear destination bits127:64                                                       |
| `CVTSS2SD`, `CVTSD2SS`   | F3/F2 `5a`                            | scalar f32/f64 from XMM/m32-or-m64, replace low64/32 and preserve the remaining old destination bits                     |
| `CVTDQ2PS`               | NP `5b`                               | four signed i32 from XMM/m128 to four f32                                                                                |
| `CVTPS2DQ`, `CVTTPS2DQ`  | 66/F3 `5b`                            | four f32 from XMM/m128 to four signed i32                                                                                |
| `CVTDQ2PD`               | F3 `e6`                               | low two signed i32 from XMM/m64 to two f64                                                                               |
| `CVTPD2DQ`, `CVTTPD2DQ`  | F2/66 `e6`                            | two f64 from XMM/m128 to low two signed i32, clear destination bits127:64                                                |
| `CVTSI2SS`, `CVTSI2SD`   | F3/F2 `2a`                            | signed GPR/m32, or GPR/m64 with effective long64 REX.W; replace low32/64 of XMM, preserve the remaining destination bits |
| `CVTSS2SI`, `CVTSD2SI`   | F3/F2 `2d`                            | scalar XMM/m32-or-m64 to signed GPR32, or GPR64 with effective long64 REX.W                                              |
| `CVTTSS2SI`, `CVTTSD2SI` | F3/F2 `2c`                            | same views, with integer conversion toward zero independently of RC                                                      |

arithmetic, SQRT, MIN/MAX, CMP and approximation forms have an XMM destination and an XMM or memory source. packed PS/PD sources are m128; scalar SS/SD sources are m32/m64. COMI/UCOMI read an XMM first operand and an XMM/m32-or-m64 second operand, writing only EFLAGS. raw logic/interleave uses XMM destinations and XMM/m128 sources. the conversion table specifies its different views and low-half spans. REX.W does not change other selected floating-point/raw widths.

scalar numeric operations with an XMM destination preserve its bits above the low32/64 result, including with memory sources. they do not inherit the upper-zeroing rule of memory MOVSS/MOVSD. packed instructions replace all128 bits except the explicitly cleared upper64 conversions. source lanes not participating in scalar or low-half conversions neither affect results nor raise numeric conditions. capture all participating source/old-destination bits before any destination write, including same-bank aliases.

packed sizes and scalar floating-point sizes are fixed by the selected form; CS.D and mandatory66 do not select16-bit numeric/GPR conversions. GPR conversions use existing32-bit write policy: zero upper32 in long64, preserve raw upper32 in other modes. only effective long64 REX.W selects signed64 integer views. REX.R/B extend actual XMM/GPR operands; REX.R does not extend an `/digit` selector.

raw logic/interleave/half moves never inspect floating-point encodings or change MXCSR. ANDN is `~oldDestination & source`. interleave selects the low/high halves of the captured operands at32/64-bit lane widths. memory MOVLPS/LPD loads replace low64; MOVHPS/HPD loads replace high64; preserve the other destination half. stores copy only the selected half. MOVHLPS copies source high64 to destination low64; MOVLHPS copies source low64 to destination high64. preserve the other half even for aliases.

only memory classes are admitted for MXCSR and the memory-only half-move encodings. reject a known illegal ModR/M class at ModR/M before unrelated SIB/displacement/immediate bytes. unimplemented `0f ae` selectors, including state images/fences, remain unsupported at their deciding selector.66/F2/F3 MXCSR variants are outside this selected encoding set. known forms consume their complete required tail before a single LOCK produces invalid-encoding; mixed/repeated LOCK follows the inherited deciding-prefix unsupported rule. distinguish selected CMPSD `F2 0F C2 /r ib` from the existing string CMPSD opcode.

## numeric results

interpret lanes as IEEE binary32 or binary64, with x86 instruction-specific rules. evaluate arithmetic at destination precision using the guest rounding mode, not host ambient rounding. preserve signed zero, infinities and finite edge results; distinguish exact from inexact results before discarding precision. ADD/SUB cancellation and zero signs follow RC, MUL/DIV use operand signs and SQRT preserves negative zero. do not replace separate guest arithmetic instructions with fused operations.

NaN classification, selection and payload bits are observable through raw XMM/memory state. for ordinary arithmetic, select the sole NaN operand; when both operands are NaNs select the first source, which is the old destination for a legacy binary instruction. quiet a selected SNaN by setting its quiet bit, preserving sign and remaining payload. any participating SNaN still raises invalid even if a different NaN supplies the result. SQRT uses its selected source. invalid operations without a NaN operand produce x86 indefinite `ffc00000` or `fff8000000000000`. cross-precision conversions preserve sign and the most significant payload bits, shifting f32 payload left29 for f64 or discarding the low29 f64 payload bits for f32; quiet SNaNs and raise invalid, without adding precision merely for payload truncation.

MIN/MAX use their own rule: after DAZ input treatment, if either operand is NaN, or both compare equal as positive/negative zero, return the effective second source element. DAZ can replace a subnormal second source with signed zero; otherwise this selection preserves its raw bits, including an unchanged second-source SNaN when invalid is masked. either QNaN or SNaN raises invalid for these instructions. do not use a host minimum/maximum or apply the arithmetic quieting rule to this raw selected result.

DAZ converts participating subnormal floating-point inputs to signed zero before numeric evaluation, suppressing DE for that input. with DAZ clear, apply each instruction's denormal reporting rules; conversion to/from signed integers does not signal DE. precision conversions and comparisons retain their own documented conditions. raw data operations do not apply DAZ. a NaN/invalid/divide-by-zero short-circuit within one lane can suppress lower-priority conditions; do not independently flag every special input.

use x86 overflow/underflow/precision rules, including the mask-dependent distinction between rounding at destination precision with an unbounded exponent and the bounded destination format. masked overflow produces the RC/sign-dependent infinity or maximum-finite result and sets OE/PE. unmasked overflow can set OE without PE when that unbounded-exponent rounding was exact. with UM clear, an exact tiny nonzero result can report UE without PE. with UM set and FTZ clear, an exact representable subnormal result does not report UE/PE; a tiny inexact result reports both. with UM set and FTZ set, a tiny nonzero result becomes signed zero and reports UE/PE, including an otherwise exact subnormal result. with UM clear, FTZ is ignored. determine tininess at the rounded destination precision with unbounded exponent as described by Intel volume1 §11.5.2.5 and AppendixD; a result that rounds into the normal range is not tiny.

float-to-integer CVT rounds by RC before testing signed destination range; CVTT rounds toward zero. valid integer minimum and the masked invalid indefinite can have identical result bits but different status. masked invalid returns `80000000` or `8000000000000000` at the selected integer width. an invalid lane does not also acquire precision merely because it produces indefinite. integer-to-float conversion uses the complete signed32/64 source, not an intermediate host Number that has already lost integer bits.

CMP uses `imm8 & 7`; higher bits do not select AVX predicates. predicates0-7 are equal, less-than, less-or-equal, unordered, not-equal, not-less-than, not-less-or-equal and ordered. unordered inputs make predicates3/4/5/6 true and0/1/2/7 false. every SNaN raises invalid; QNaN additionally raises invalid for predicates1/2/5/6. each packed result element is all ones or zero; scalar CMP preserves the inactive upper bits.

COMI raises invalid for any NaN; UCOMI raises it only for SNaN. a successful/masked comparison writes ZF/PF/CF as equal=`100`, less=`001`, greater=`000`, unordered=`111`, with that bit order. clear OF/SF/AF and preserve all other admitted flags including DF. an unmasked numeric exception preserves the complete incoming flags, including these would-be changes.

RCP/RSQRT never report FP exceptions or change MXCSR. they ignore RC/DAZ/FTZ controls: subnormal inputs are signed zero, zeros yield signed infinity, positive infinity yields positive zero, RCP of negative infinity yields negative zero, and RSQRT of negative nonzero values yields indefinite. quiet source SNaNs and preserve NaN sign/payload without raising IE. scalar forms preserve upper destination bits. use a deterministic permitted result: for ordinary finite inputs, RCP is nearest-even binary32 rounding of exact `1/x`, then flush any subnormal result to signed zero; for positive finite RSQRT, compute nearest-even binary32 SQRT followed by nearest-even binary32 reciprocal, suppressing all intermediate status. retain the Intel relative-error bound `1.5 * 2^-12` on applicable finite results and instruction-specific tiny-result allowances. this selects a reproducible allowed implementation, not the approximation table of a particular hardware CPU.

## numeric exceptions and publication

add resumable reason `simd-exception`, representing detected #XM under the enabled exception view, with an exclusive diagnostic:

```ts
interface SimdException {
  instructionPc: bigint;
  vector: 19;
  stage: 'pre-computation' | 'post-computation';
  raised: number;
  unmasked: number;
  mxcsrBefore: number;
  mxcsrAfter: number;
}
```

`raised` uses bits0-5 and contains the conditions reportable for this instruction through its abort stage, including conditions already sticky before entry. it is neither all accrued status nor only zero-to-one bit transitions. `unmasked = raised & ~(mxcsrBefore >>> 7) & 0x3f` is nonzero on this exit. `mxcsrAfter` preserves controls and ORs the reportable status into the incoming value.

complete decode and source access checks before numeric effects. then apply the instruction-specific per-lane pre-computation rules and OR reportable IE/DE/ZE across all active lanes. SNaN/NaN handling precedes other invalid/divide-by-zero conditions and denormal reporting within one lane, according to Intel volume3A table7-8; one lane's early condition does not prevent observing pre-computation conditions in other lanes. if any of these instruction conditions is unmasked, publish this pre-computation status and stop; do not compute or publish OE/UE/PE from other lanes.

otherwise retain masked pre-computation status and calculate candidate results/post-computation conditions across all active lanes. OR the reportable OE/UE/PE under their mask-sensitive rules and publish the accrued status. if any reportable post-computation condition is unmasked, stop before any result publication. otherwise commit the entire destination and any comparison flags. do not evaluate post-computation conditions for a lane already resolved by an invalid/NaN/divide-by-zero response. no lane may commit early.

a `simd-exception` preserves all incoming GPRs, XMM banks, EFLAGS, memory and logical RIP for the faulting instruction, retires zero and consumes no repeat allowance. its permitted architectural change is MXCSR status; completed predecessor effects remain committed. no `fault`, `segmentFault`, `alignmentFault` or general-protection diagnostic accompanies it. stale diagnostics are cleared without clearing MXCSR. repairing operands, masks or controls and resuming re-executes the instruction at the same RIP; already-set unmasked flags alone do not retrigger it. this is fault detection/export, not IDT lookup, a handler frame or exception return.

## MXCSR memory and general protection

LDMXCSR reads exactly four bytes with read permission and no added SIMD alignment. it replaces all MXCSR bits only after the complete source access and reserved-bit validation succeed. STMXCSR captures the current value and writes exactly four little-endian bytes, with write permission only and complete preflight. neither instruction reports a numeric condition. LDMXCSR can clear status or unmask sticky flags without immediately causing #XM. later instructions in the same artifact observe the new value.

a fetched LDMXCSR payload with any bit16-31 set produces resumable reason `general-protection` and an exclusive `generalProtectionFault` record:

```ts
interface GeneralProtectionFault {
  instructionPc: bigint;
  vector: 13;
  errorCode: 0;
  cause: 'mxcsr-reserved-bits';
  loadedValue: number;
}
```

`loadedValue` is the complete unsigned m32 value, including bit31. preserve all architectural state including old MXCSR, RIP and retirement. a missing/unreadable source byte wins before this payload check. host `setMxcsr` rejects the same invalid bits as input error, not a guest exception. this new record covers the selected LDMXCSR condition; existing alignment/segment/mapping exits retain their contracts. append new reason values without renumbering existing ones. full general-protection detection and handler delivery are not implied.

## checked memory, exits and reuse

use existing effective-address, segment, canonical/domain and mapping authorities. packed m128 forms check all16 bytes and require translated linear16-byte alignment. scalar m32/m64, low-half m64 conversions, half moves and MXCSR access only their actual4/8-byte spans with no added alignment. retain context/full-span address checks before alignment, and alignment before mapping. numeric evaluation must wait for complete source preflight, so an unreadable later lane cannot publish status from an earlier lane. no destination memory read is required for STMXCSR or a raw half store.

all stores retain complete preflight, captured sources, ascending-linear write order for backing aliases and cumulative executable invalidation. a successful code write commits its bytes, next RIP and one retirement before budget/stop/invalidation gates. failed stores change no architectural state. memory failures and invalid encodings change no MXCSR bits for the faulting instruction. every successful instruction consumes one instruction budget and no repeat budget; preserve preceding REP progress.

keep canonical control/status in CPU-owned state. generated register operands may still live in selected v128 locals: a numeric helper must receive current captured values rather than read stale canonical XMM after an un-published predecessor. choose one owner for MXCSR publication so a helper update cannot be overwritten by stale epilogue locals. current controls must be visible after LDMXCSR, at every retained middle entry, after imports and across dispatch/fault/repair. no additional context key or data-dependent recompilation is required solely for controls or status.

GP-only and integer/raw-SIMD-only artifacts add no MXCSR locals, loads, stores or publication. retain selected-bank XMM behavior and scalar snapshot/import costs. standard fixed Wasm SIMD remains the runtime minimum; no relaxed SIMD is required. native Wasm/JavaScript FP arithmetic alone is not a numeric authority: its rounding, NaNs and lack of guest flags/traps cannot establish these contracts. use an exact x86-aware numeric implementation or proven guarded fast paths with exact fallback. a library's five IEEE flags do not by themselves implement DE, mask-sensitive OE/UE/PE, packed exception phases or instruction-specific NaNs. keep guest numerical semantics out of TypeScript and avoid ambient host rounding state.

## verification

`npm run check` is acceptance. x86 owns decode, operand and numeric meaning; generated execution owns live operands and retirement; checked memory owns accesses/code validity; the embedding owns canonical MXCSR and guest diagnostics; host code owns lifecycle/import validation. source inspection is not execution evidence. verify through public Node and Chrome paths with independent bit-pattern expectations, complete GPR/XMM banks, MXCSR, flags, bytes/guards, diagnostic exclusivity and both budget pairs.

cover every selected opcode/direction, all14 imported mode profiles and applicable address-size cross-products, CS.D-independent GPR32 views, long64 GPR64/extended banks, same-bank aliases, inactive source lanes, every legacy CMP predicate/high-bit alias, REX cancellation, full required tails, illegal known classes, unsupported selectors and15-byte boundaries. retain regression tests for previous SIMD/integer/string decode frontiers.

numeric cases include ±0, minimum/maximum subnormal, minimum/maximum normal, infinity, both NaN classes with distinct signs/payloads, halfway cases and cancellation. cover all four RC modes, all DAZ/FTZ combinations, each exception separately masked/unmasked, masked/unmasked combinations across lanes and both computation phases, sticky re-raising and pre-existing unmasked status. test exact tiny results, rounding into the normal range, mask-sensitive overflow precision, conversion boundaries and payload narrowing. verify approximation special cases and deterministic outputs; separately bound approximation error with an independent high-precision reference.

public cases must include exact narrow m32/m64 spans, full m128 later-byte failures, read-only sources/write-only stores, high guest addresses, adjusted segment alignment, backing aliases, identity code stores, resource refusal, eviction, prior REP work, failed narrow upper-zeroing conversions, retained middle entries with skipped writers and changed controls. test both state projections preserving MXCSR, status surviving diagnostic clearing, invalid host imports, pending/failed/disposed lifecycle and malformed private exports/layout/high pointers. LDMXCSR control changes must affect the next FP operation within one invocation with no recompile; repaired faults and changed imports at cached entries must retain ownership when code/context/mappings permit.

these independent packets use long64, logical RIP=`1000`, flags=`cd7`, budget1/repeatBudget0, distinct raw banks and nonzero inactive destination bits unless stated otherwise. raw bit patterns and MXCSR values below are hexadecimal; mathematical expressions, exponents, lane indices, widths and budgets use decimal. successful XMM-result operations preserve inactive bits as specified above and leave EFLAGS unchanged; unmasked numeric exceptions preserve all destination bits and RIP. no packet relies on host floating-point formatting as its oracle.

| packet                                                                                                               | required result                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `F3 0F 58 C1` ADDSS; low inputs `3f800000` and `33800000`; MXCSR `1f80/3f80/5f80/7f80`                               | low result `3f800000/3f800000/3f800001/3f800000`; PE set in each case. with PM clear, both `0f80` and already-sticky `0fa0` produce a post-computation exception with raised/unmasked PE=`20` and MXCSR after=`0fa0`.                                                                      |
| `F3 0F 59 C1` MULSS; inputs `00800000` and `3f000000`                                                                | MXCSR `1f80`: result `00400000`, MXCSR unchanged. `9f80`: result positive zero, MXCSR `9fb0`. `1780/9780`: post-computation exception, raised/unmasked UE=`10`, after `1790/9790`; FTZ ignored. `8f80`: post-computation exception with raised UE/PE=`30`, unmasked PE=`20`, after `8fb0`. |
| same MULSS; inputs `7f7fffff` and `40000000`                                                                         | MXCSR `1f80`: result `7f800000`, after `1fa8`. `1b80`: post-computation exception, raised OE=`08` without PE, after `1b88`.                                                                                                                                                                |
| `0F 5E C1` DIVPS; destination lanes `[0,3f800000,7f7fffff,3f800000]`, source `[0,0,3f000000,40400000]`; MXCSR `1f00` | pre-computation exception, raised IE/ZE=`05`, unmasked IE=`01`, after `1f05`. all lanes unchanged; no OE/PE from later computations. with masks restored and the same inputs, result lanes `[ffc00000,7f800000,7f800000,3eaaaaab]`, MXCSR becomes `1fad` with accrued IE/ZE/OE/PE=`2d`.    |
| `F3 0F 5D C1` MINSS; `(a,b)=(7fc00011,3f800000)`, `(3f800000,7f800022)`, `(0,80000000)`                              | the low result is raw `b` in each case; first two set IE, including QNaN in `a` and unchanged SNaN in `b`; signed-zero tie returns `80000000` without IE. with IM clear, the NaN cases fault without destination changes; the zero tie still completes.                                    |
| same MINSS; a=`3f800000`, b=`00000001`; MXCSR `1f80`, then `1fc0`                                                    | DAZ clear returns `00000001`, MXCSR `1f82`; DAZ set returns positive zero, MXCSR `1fc0`. second-source selection uses the DAZ-adjusted value, not the original subnormal bits.                                                                                                             |
| `F3 0F C2 C1 ib`; a QNaN versus `3f800000`; predicates `00/01/02/03/04/05/06/07` and their high-bit aliases          | masks `[0,0,0,ffffffff,ffffffff,ffffffff,ffffffff,0]`; IE only for predicates1/2/5/6. repeat with SNaN: IE for every predicate. preserve inactive destination bits.                                                                                                                        |
| `0F 2F C1` COMISS and `0F 2E C1` UCOMISS; QNaN versus `3f800000`, MXCSR `1f80`, incoming flags `cd7`                 | both yield unordered flags `447`; COMISS sets IE, UCOMISS does not. with IM clear, COMISS leaves flags `cd7` and all destinations unchanged; UCOMISS still completes.                                                                                                                      |
| `F3 0F 2C C1` CVTTSS2SI; source `cf000000`, then `4f000000`                                                          | both produce long64 RAX=`0000000080000000`; negative integer minimum is exact with no IE/PE, positive out-of-range input sets IE. with IM clear, the second preserves the complete old RAX.                                                                                                |
| `F2 0F 2D C1` CVTSD2SI; binary64 source `41dfffffffe00000` (exact2147483647.5)                                       | nearest-even rounds out of signed32 range and returns masked indefinite with IE; toward-zero returns `7fffffff` with PE. check range after rounding, not before.                                                                                                                           |
| `F3 0F 5A C1`; source SNaN `7f800001`; separately `F2 0F 5A C1`, source SNaN `7ff0000000000001`                      | widened result `7ff8000020000000`, narrowed result `7fc00000`; each sets IE without PE. only the selected destination width changes.                                                                                                                                                       |
| `F3 0F 58 00` ADDSS; source smallest subnormal at an exact four-byte mapping; destination low bits `3f800000`        | DAZ clear: result `3f800000` with DE/PE. DAZ set: result `3f800000` without DE/PE from that operand. missing fourth byte instead gives width4 data-fault with complete old MXCSR and XMM bank.                                                                                             |
| `0F AE 10` LDMXCSR `[RAX]`; payload `00010000`, or `80000000`                                                        | after a complete m32 read: general-protection, vector13/error0, exact unsigned loadedValue; old MXCSR and all other state unchanged. a missing later source byte returns the memory failure instead.                                                                                       |
| `0F AE 18` STMXCSR `[RAX]`; MXCSR `ffff`; destination write-only and unaligned                                       | writes exactly `ff ff 00 00`; no destination read, no numeric status change; preserve neighboring bytes and apply code-alias invalidation if executable.                                                                                                                                   |
| LDMXCSR imports PE set/PM clear; then exact ADDSS `1+0`, then inexact `1+2^-24` in one cached artifact               | load and exact ADDSS retire normally; inexact ADDSS faults at its own RIP, re-raises already-set PE and preserves its incoming destination. retain preceding retirements and repeat accounting.                                                                                            |
| RCP/RSQRT scalar inputs ±0, minimum subnormal, ±infinity, negative normal, SNaN; all controls/status patterns        | exact special results and preserved upper bits; MXCSR unchanged. ordinary finite results follow the deterministic rule and relative-error bound; no hidden host FP exception state.                                                                                                        |

an independently maintained bit-level or high-precision oracle must account for x86-specific behavior beyond generic IEEE results. candidate libraries/reference programs require source/license and wasm32 compatibility review before use. reference agreement from shared implementation lineage or Rosetta alone is insufficient. retain reproducible input/output seeds and audit failures before updating expected values.

## performance and increments

preserve a pre-change Core/host baseline. compare matched scalar, memory/RMW, control/stack, multiply/divide, REP, exchange/LOCK, short-resume and churn cohorts, plus already executable integer/raw-SIMD register/memory/pressure cases. compare unchanged artifacts byte-for-byte where decode frontiers permit and inspect generated code for unwanted MXCSR traffic. account separately for added construction validation and private transport size; do not charge numeric state snapshots to scalar runs.

characterize packed/scalar f32/f64 arithmetic, SQRT, MIN/MAX, comparisons, narrowing/widening and signed32/64 conversions, approximations and MXCSR memory operations. include default controls with clear versus already-sticky status, nondefault RC, DAZ/FTZ, live-bank pressure, raw/integer/FP mixtures, LDMXCSR in the loop, masked conditions, unmasked fault/repair, changed imports, retained budget-one entries and code-alias stores. fast-path tests must include inexact normal results with PE clear or unmasked; normal finite inputs alone do not justify native arithmetic.

record exact output/control/status guards, translation, browser compile/instantiation, creation/first completion, early/later reuse, native entries/dispatch, source dependencies, generated/cache/transport sizes and explicit MXCSR API costs. keep scalar/FP execution and host state materialization timings distinct. avoid claims about games, native register allocation or general SIMD speedup from synthetic kernels.

land executable increments: MXCSR transport/API and LDMXCSR/STMXCSR with GP outcomes; exact scalar arithmetic plus #XM phases; packed arithmetic and lane aggregation; comparison/conversion/raw forms; deterministic approximations; then complete mode/alias/fault/reuse/performance and independent review. the final acceptance covers all selected forms and controls, not only default masked nearest-even execution.

## references

- [Intel SDM collection](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html), revision093: volume1 §§4.8.3-4.8.4,10.2.3,11.5 and AppendixD for NaNs, MXCSR, exception phases and mask-sensitive numeric responses; volume2 selected instruction entries; volume3A §7/table7-8 for #XM and condition priority, and §25 for instruction exception classes.
- [Intel XED ISA patterns](https://github.com/intelxed/xed/blob/main/datafiles/xed-isa.txt) and [state-bit selectors](https://github.com/intelxed/xed/blob/main/datafiles/xed-state-bits.txt): legacy mandatory selectors, operand classes and no-refining-prefix MXCSR forms.
- [WebAssembly numeric semantics](https://webassembly.github.io/spec/core/exec/numerics.html): host floating-point/NaN rules; native operations require proof or repairs for the guest contract above.
