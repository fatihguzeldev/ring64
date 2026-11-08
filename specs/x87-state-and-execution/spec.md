# x87 state and execution

add core x87 execution to the existing imported contexts: raw80 data, the physical register stack and tags, control/status, data movement, conversions, arithmetic, comparisons and deferred numeric exceptions. execute the selected forms through the public host and generated-Wasm path, including checked memory, retained entries and restart.

use all fourteen existing imported profiles with x87 enabled: CR0.EM and TS are clear, CR0.NE is set, and FCOMI/FCMOV are available. retain the existing enabled SSE/SSE2 view. these are execution assumptions, not guest control-register writes or a complete CPU identity. select deprecated FCS/FDS selectors, with zero selector values; FDP deprecation is disabled. guest descriptors, paging, #NM, legacy external error interrupts, handler delivery, reset and legal mode transitions remain separate contracts.

FPREM/FPREM1, FSCALE/FXTRACT, transcendentals and packed-decimal conversions belong to `x87-special-functions`. MMX/EMMS and guest environment/state images belong to their own contracts. FISTTP requires SSE3 and is outside this selection. the core below includes all defined precision and rounding controls, masked and unmasked behavior; it is not limited to default-control arithmetic.

## architectural state and host API

add a separate idle projection and export its `X87State` and `X87Exception` types from the host module:

```ts
interface X87State {
  registers: bigint[];
  controlWord: number;
  statusWord: number;
  tagWord: number;
  instructionPointer: bigint;
  dataPointer: bigint;
  opcode: number;
}

readX87State(): X87State;
setX87State(state: X87State): void;
```

`registers` contains exactly eight physical banks R0–R7, each a primitive unsigned80-bit bigint. bits0–63 hold the explicit significand, bits64–78 the biased exponent and bit79 the sign. preserve every payload, including empty slots, unsupported encodings and noncanonical values. the full unsigned16-bit tag word has two bits per physical bank: valid=`00`, zero=`01`, special=`10`, empty=`11`. host import preserves the supplied tags independently of payload classification. future guest restore instructions must apply their own tag-reconstruction rules instead of calling this raw import as an architectural shortcut.

TOP exists only in status bits11–13. ST(i) addresses physical `(TOP+i)&7`; payloads and tags do not rotate when TOP changes. a pop marks the old top empty and advances TOP without zeroing its payload. overwriting ST(i) updates its tag; targeting a nonempty destination is not itself a stack overflow except where the selected instruction pushes into an occupied slot.

CW, SW and the tag word are primitive finite integer numbers in `0..0xffff`; FOP is a number in `0..0x7ff`; both pointers are primitive unsigned64-bit bigints. no coercion, sparse/typed substitute register array, truncated payload or boxed primitive is accepted. normalize numeric negative zero to zero. require SW.ES and SW.B to equal the presence of a pending condition, `(SW & ~CW & 0x3f) != 0`; reject inconsistent checkpoints rather than repairing them. no extra pending boolean or duplicate TOP is exposed.

capture every input field and element once into owned temporary data, validate before publication and enforce the lifecycle both before and after capture. getter reentry may perform another idle operation; the outer valid import replaces the x87 projection last and preserves other committed projections. a rejected outer import must not publish partial x87 fields or clear diagnostics/pending state. follow the existing running, pending-compilation, failed and disposed rules. reads return a fresh record and array.

construction sets eight zero payloads, CW=`037f`, SW=`0000`, tags=`ffff`, pointers/FOP zero. this is a construction default, not an implementation of architectural reset. `setState`, `setXmmState`, `setMxcsr`, `setContext`, diagnostics clearing, run setup, non-x87 execution, compilation and eviction preserve x87 state. successful `setX87State` clears transient guest diagnostics while preserving GPRs, flags, RIP, XMM, MXCSR, context and memory. ordinary `State` and the run result's `state` remain scalar projections; do not materialize an x87 snapshot for every run.

append descriptor-owned x87 storage after the existing456-byte RunState transport. preserve current field offsets, the176-byte scalar,256-byte XMM and4-byte MXCSR imports and the five-argument generated entry ABI. use a separate little-endian x87 import containing the eight raw80 values and defined fields, independent of Rust struct padding. validate required exports before initialization, then validate the initialized descriptor and complete extents before publishing the CPU; rejection cleans up the owned instance. include disjointness, unsigned wasm32 pointers above2GiB and an extent ending exactly at private memory end. keep one transport layout authority.

## selected encodings

all numbers in opcode tables are hexadecimal. `+i` is the low three-bit ST index, never an extended XMM/GPR bank. arithmetic register directions below are architectural, not assembler spelling aliases.

| memory opcode           | `/0`  | `/1`  | `/2`  | `/3`   | `/4`  | `/5`   | `/6`  | `/7`   |
| ----------------------- | ----- | ----- | ----- | ------ | ----- | ------ | ----- | ------ |
| `D8` m32 floating       | FADD  | FMUL  | FCOM  | FCOMP  | FSUB  | FSUBR  | FDIV  | FDIVR  |
| `DC` m64 floating       | FADD  | FMUL  | FCOM  | FCOMP  | FSUB  | FSUBR  | FDIV  | FDIVR  |
| `DA` m32 signed integer | FIADD | FIMUL | FICOM | FICOMP | FISUB | FISUBR | FIDIV | FIDIVR |
| `DE` m16 signed integer | FIADD | FIMUL | FICOM | FICOMP | FISUB | FISUBR | FIDIV | FIDIVR |

| register forms                            | encodings and effects                                                                   |
| ----------------------------------------- | --------------------------------------------------------------------------------------- |
| destination ST(0), source ST(i)           | `D8 C0+i` FADD, `C8+i` FMUL, `E0+i` FSUB, `E8+i` FSUBR, `F0+i` FDIV, `F8+i` FDIVR       |
| destination ST(i), source ST(0)           | `DC C0+i` FADD, `C8+i` FMUL, `E0+i` FSUBR, `E8+i` FSUB, `F0+i` FDIVR, `F8+i` FDIV       |
| destination ST(i), source ST(0), then pop | `DE C0+i` FADDP, `C8+i` FMULP, `E0+i` FSUBRP, `E8+i` FSUBP, `F0+i` FDIVRP, `F8+i` FDIVP |
| ordered comparisons                       | `D8 D0+i` FCOM; `D8 D8+i` FCOMP; `DE D9` FCOMPP                                         |
| unordered comparisons                     | `DD E0+i` FUCOM; `DD E8+i` FUCOMP; `DA E9` FUCOMPP                                      |
| flags comparisons                         | `DB F0+i` FCOMI, `DB E8+i` FUCOMI; `DF F0+i` FCOMIP, `DF E8+i` FUCOMIP                  |
| conditional moves                         | `DA C0/C8/D0/D8+i`: FCMOVB/E/BE/U; `DB C0/C8/D0/D8+i`: FCMOVNB/NE/NBE/NU                |

reverse subtract/divide exchange the mathematical operand order, not the physical destination. capture sources before destination updates or popping, including ST(0) aliases and destination ST(0) in pop forms. FCOMPP/FUCOMPP compare ST(0) against ST(1) and pop twice when their response permits it.

| data, stack and numeric forms | encoding                                                       |
| ----------------------------- | -------------------------------------------------------------- |
| FLD                           | `D9 /0` m32, `DD /0` m64, `DB /5` m80; `D9 C0+i` ST(i)         |
| FST                           | `D9 /2` m32, `DD /2` m64; `DD D0+i` ST(i)                      |
| FSTP                          | `D9 /3` m32, `DD /3` m64, `DB /7` m80; `DD D8+i` ST(i)         |
| FILD                          | `DF /0` m16, `DB /0` m32, `DF /5` m64 signed integers          |
| FIST / FISTP                  | `DF /2` and `/3` m16; `DB /2` and `/3` m32; `DF /7` FISTP m64  |
| FXCH / FFREE                  | `D9 C8+i`; `DD C0+i`                                           |
| FDECSTP / FINCSTP / FNOP      | `D9 F6`; `D9 F7`; `D9 D0`                                      |
| FCHS / FABS / FTST / FXAM     | `D9 E0`; `D9 E1`; `D9 E4`; `D9 E5`                             |
| constants                     | `D9 E8..EE`: FLD1, FLDL2T, FLDL2E, FLDPI, FLDLG2, FLDLN2, FLDZ |
| FSQRT / FRNDINT               | `D9 FA`; `D9 FC`                                               |

| control forms   | encoding                  |
| --------------- | ------------------------- |
| FLDCW / FNSTCW  | `D9 /5` m16; `D9 /7` m16  |
| FNSTSW          | `DD /7` m16 or `DF E0` AX |
| FNCLEX / FNINIT | `DB E2`; `DB E3`          |
| WAIT/FWAIT      | standalone `9B`           |

only these forms are admitted; unselected documented x87 forms remain unsupported. architecturally invalid encodings, including LOCK on the selected forms, retain the existing invalid-encoding outcome. do not admit undocumented opcode aliases. parse the required ModRM/address tails for admitted forms before execution, retaining required-byte fault priority and the15-byte limit. F2/F3 are ignored legacy prefixes here, not SSE selectors;66 does not change opcode-defined numeric/control widths.67 and segment overrides select inherited address rules. effective long64 REX.B/X extend memory addressing, but REX.R/B do not extend an ST index and REX.W does not widen an x87 format. preserve existing prefix ordering and REX cancellation.

`9B` is an instruction, not a prefix on the following x87 opcode. assembler waiting mnemonics such as FINIT, FCLEX, FSTCW and FSTSW denote WAIT followed by the corresponding FN instruction. give both independent PCs, retirement, stop and budget boundaries. a mapped final-byte WAIT must execute without requiring the next instruction's bytes.

## values, precision and status

numeric interpretation uses the complete ext80 payload: explicit integer bit,15-bit exponent and64-bit significand. distinguish zeros, normal/subnormal values, pseudo-denormals, infinities, both NaN classes and unsupported encodings. a generic IEEE binary128 or f64 interpretation is not this format. numeric instructions apply their documented treatment of noncanonical operands; raw m80/register moves, FCHS/FABS and FXAM retain their own non-arithmetic rules. FLD m80 and FLD ST(i) preserve SNaNs/subnormals without IE/DE merely for loading them; do not normalize their raw payloads as a side effect.

CW bits0–5 mask IE/DE/ZE/OE/UE/PE; a set mask bit masks its condition. RC bits10–11 select nearest-even, toward negative infinity, toward positive infinity and toward zero. PC bits8–9 select significand precision24/53/64 for encodings00/10/11. only FADD/FIADD, FSUB/FSUBR and integer/pop variants, FMUL/FIMUL, FDIV/FDIVR and integer/pop variants, and FSQRT apply PC. reduced precision retains the ext80 exponent range and operates on full-precision inputs; round the exact result directly at the selected precision. pre-rounding operands, narrowing through IEEE f32/f64 or rounding first to64 significand bits can produce different values/status.

loads, integer-to-ext80 conversion and register copies do not apply PC. FST to m32/m64 rounds directly from ext80 at the destination precision using RC; FIST rounds by RC before signed range checking; FRNDINT uses RC at ext80 precision. use format-specific integer and floating indefinite values for masked invalid responses. implement x87 NaN selection/quieting, signed zeros, denormal reporting, overflow/underflow/precision priority, tininess and C1 behavior, rather than treating five generic IEEE flags as the complete status contract. there is no x87 DAZ/FTZ control and MXCSR must not influence these results.

retain all16 CW bits through host import, FLDCW and FNSTCW; other ignored/reserved fields have no execution effect. PC=`01` uses64-bit precision as this profile's deterministic choice for a reserved encoding, not an Intel guarantee. the legacy infinity-control bit has no effect. constants use the x87 internal66-bit constants and RC without PE; clear C1 on a successful push and set it for stack overflow, not for upward constant rounding. generate neither constants nor conversion expectations through host Number arithmetic. preserve documented defined outputs and compare undefined condition bits separately.

SW has sticky IE/DE/ZE/OE/UE/PE in bits0–5, SF in bit6, ES in bit7, C0/C1/C2 in bits8–10, TOP in bits11–13, C3 in bit14 and B in bit15. refresh ES/B from pending status after controls/status change. SF is sticky until explicitly cleared; a later non-stack invalid operation does not clear it. stack overflow/underflow sets IE/SF, with C1 distinguishing overflow=1 from underflow=0. masked stack errors use instruction-specific indefinite destinations and stack changes; unmasked stack errors suppress those changes and leave pending status. FXAM uses both tags and raw sign/class, including an empty slot with a nonzero payload; it does not signal stack underflow just for examining emptiness. within stack state, FFREE changes only the selected tag; FDECSTP/FINCSTP change TOP modulo8 and clear C1 without classifying or rewriting payloads/tags.

FCOM/FICOM/FTST raise invalid for either NaN class; FUCOM raises invalid for SNaN or unsupported operands, but allows QNaN unordered results. comparisons write C3/C2/C0 and clear C1; unmasked invalid suppresses the comparison-result bits and pop effects. FCOMI/FUCOMI instead write ZF/PF/CF and always clear OF/SF/AF, even when invalid is unmasked; unmasked invalid preserves ZF/PF/CF and suppresses the pop, not those three clears. FCOMI/FUCOMI clear x87 C1 and preserve C0/C2/C3. preserve other admitted EFLAGS including DF. FNSTSW AX writes only AX, preserving the upper48 bits of the canonical GPR, including in32-bit contexts. these operations must interoperate with live generated GPR/FLAGS values within a unit.

FCMOV reads current CF/ZF/PF and checks both ST(0) and ST(i) before testing its condition; it has no GPR/EFLAGS destination. with both operands nonempty, copy ST(i) to ST(0) if true, otherwise preserve ST(0), with no numeric invalid exception from NaN payloads. if either is empty, set IE/SF and clear C1 regardless of the predicate. when IM is set, replace ST(0) with indefinite `ffff:c000000000000000` and a special tag; when IM is clear, preserve the complete destination and tags and post pending invalid. TOP never changes. the source remains unchanged except when i=0 names the same physical destination. test all four empty/nonempty operand combinations under both predicate outcomes and mask settings; masked stack underflow does not turn into a conditional no-op.

## deferred exceptions and retirement

pending x87 state is architectural CW/SW state, not a transient diagnostic. an instruction that newly encounters an unmasked numeric condition publishes its instruction-specific effects, posts pending status, advances RIP and retires once. no immediate `simd-exception` or rollback-to-producer outcome is introduced. integer, SSE and permitted no-wait control instructions may execute afterward.

before executing a selected waiting x87 instruction or WAIT, check existing pending state after instruction fetch/decode/legality and before its data access or instruction effects. all selected forms wait except FNSTCW, FNSTSW, FNCLEX and FNINIT; FNOP waits despite its spelling. the existing stop/budget gates apply first. do not move the pending check to a unit entry ahead of preceding instructions or speculatively execute a later waiting instruction.

export a resumable reason `x87-exception`, with optional `x87Exception?: X87Exception` on `RunResult`, present only for that reason and exclusive with other guest fault records:

```ts
interface X87Exception {
  instructionPc: bigint;
  vector: 16;
  pending: number;
  controlWord: number;
  statusWord: number;
  instructionPointer: bigint;
  dataPointer: bigint;
  opcode: number;
}
```

`instructionPc` is the logical PC of the checking instruction; saved pointers/FOP describe the prior x87 state and need not name that PC. `pending = statusWord & ~controlWord & 0x3f` is nonzero; it includes already-sticky unmasked conditions and is not a set of newly raised flags. the checking instruction retires zero, consumes no repeat allowance, preserves its RIP and every architectural destination, and performs no data access. retain completed predecessor effects and both budget pairs. other fault records are absent. clearing this diagnostic, changing other state projections or starting another run does not clear pending status; resumption at the same waiting instruction reports it again until repaired.

FLDCW first waits for old pending state, then performs a checked m16 load and replaces CW. it can unmask previously sticky flags, making the next waiting instruction detect them; it does not exit immediately for those newly unmasked flags. FNCLEX clears exception flags, SF, ES and B, preserving TOP and other state. this profile also preserves C0–C3 across FNCLEX; these bits are architecturally undefined for that instruction and must be excluded from hardware-conformance comparisons. FNINIT sets CW/SW/tags and pointers/FOP to construction values but preserves all eight physical payloads, GPRs, XMM, MXCSR and memory. its waiting spelling can fault at its separate WAIT before the reset occurs.

the following distinctions are mandatory, with exact rules supplied by each selected instruction and Intel's exception-priority tables:

| condition                                                                           | required publication                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unmasked stack-invalid, arithmetic-invalid or divide-by-zero                        | record status/pending; suppress the affected result and pop/push effects, with the stated FCOMI/FUCOMI exception for OF/SF/AF clears                                                                 |
| unmasked denormal operand on another form that reports DE                           | record DE/pending and suppress its result and stack changes before later overflow/underflow/precision work; the FLD exception below does not generalize to arithmetic                                |
| FLD m32/m64 of a denormal with DM clear                                             | record DE/pending but still convert and push the value                                                                                                                                               |
| unmasked register overflow/underflow                                                | round at the instruction's precision, adjust the exponent by -24,576/+24,576 respectively, and publish the wrapped register result and permitted stack effects; report PE if that result was inexact |
| unmasked m32/m64 floating-store overflow/underflow                                  | suppress destination bytes and pop, set OE/UE, do not report PE, and clear C1                                                                                                                        |
| unmasked precision without an unmasked pre-operation condition or store OE/UE abort | publish the rounded result, permitted store and pop, and PE/pending                                                                                                                                  |
| masked conditions                                                                   | commit the instruction-specific default/rounded result, status, tags and permitted stack effects; masked sticky flags alone do not prevent later instructions                                        |

do not transplant SSE's destination suppression or packed pre/post-phase algorithm into this state machine. combined conditions, old sticky status, NaN priority, signed integer invalid boundaries and multiple stack operands require independent expectations.

## environment metadata

keep the enabled profile explicit until guest identity and state images are implemented. selected instructions that execute after access checks update FIP at the prefix-start PC, including FNOP and producers that post pending status while suppressing their numeric result. the exceptions are FLDCW/FNSTCW/FNSTSW/FNCLEX and WAIT, which preserve it, and FNINIT, which clears the environment. update FDP for a memory operand on the FIP-updating instructions, including stores; preserve it on register-only operations where the operand pointer is undefined. update FOP only when an instruction produces an unmasked x87 condition, using `((opcodeByte & 7) << 8) | modrmByte`. no-wait controls and a pending detector do not overwrite producer metadata.

canonical pointers retain32 bits outside long64, without truncating merely because CS.D=0. protected/compatibility FIP is the logical CS offset; FDP is the effective data offset after address-size wrapping and before segment-base addition. real/virtual-8086 FIP/FDP are the corresponding linear addresses modulo2^32. in long64 FIP is the logical instruction PC and FDP is the effective offset after address-size rules, before FS/GS base addition. actual memory access and fault records still use the inherited translated linear address. selectors are zero under the selected deprecated-selector profile; do not invent selectors from loaded segment caches. the20-bit versus32-bit packing of future real-mode environment images is an image-format rule, not a new truncation on producers.

host imports retain all pointer bits until an instruction replaces the relevant field. imported context changes preserve saved metadata. a complete idle checkpoint includes x87 state alongside scalar/XMM/MXCSR projections, context and memory.

## checked memory and code validity

use exact widths2/4/8/10 as selected by the opcode, no added SIMD alignment, and inherited segment/address rules. m80 is ten little-endian bytes, not an m128 read. loads require read permission; stores require write permission without a destination read. preflight a store's entire span through the existing memory owner before changing bytes, tags or TOP. under current private RAM mappings, choose no partial write on a failed m80 store; this does not assert shared-vCPU atomicity or a future device/image policy.

after a pending check succeeds, complete access checks before numeric effects, including before stack faults, status or metadata updates. an access failure preserves incoming x87 state and instruction retirement; prior instructions remain committed. an existing pending condition wins over the waiting instruction's operand failure. a no-wait memory control can instead report its own memory failure while preserving pending x87 state.

do not implement m80 as separate8-byte and2-byte guest operations. retain the owner’s checked-span order, backing-alias identity and complete store/code invalidation rules. identical-byte writes through executable aliases still invalidate affected owners. x87 stores that modify their own successor code must publish their permitted numeric effects and then use the existing restart behavior, without replaying the store or pop.

## verification and performance

`npm run check` is acceptance. x86 owns raw representation, instruction meaning, numeric controls and pending effects; memory owns span policy/code validity; generated execution owns live operands and retirement; embedding owns canonical transport and diagnostics; host owns import/lifecycle and artifact lifetime. use an exact ext80 implementation with the selected precision/exponent rules, or proven guards with an exact fallback. no library choice or source tree is prescribed. the current SSE backend alone does not establish x87 PC24/53, extended-exponent or deferred-exception correctness.

verify every selected encoding/direction across all fourteen imported profiles and applicable address sizes through public Node and Chrome execution. cover i=0..7, every TOP, empty/nonempty tag patterns, repeated pushes/pops, reverse/pop aliases, all defined PC/RC combinations, full signed integer widths, source/destination format boundaries, constants, all FCMOV predicates and false-condition stack faults. compare complete raw payloads/tags/TOP/CW, defined/preserved SW and EFLAGS, GPR/XMM/MXCSR projections, memory/guards, PCs, exclusive diagnostics and both budget pairs. undefined outputs require explicit masks, not copied backend expectations.

numeric cases include ±0, finite ext80 values outside f64 range, minimum/maximum subnormal and normal values, infinities, distinct signed/payload QNaNs/SNaNs, pseudo-denormals/unsupported encodings, cancellation, ties on both sides, exact/inexact tiny results and binade carry. vary each mask independently, old sticky and newly re-raised conditions, combined priorities, unmasked wrapped exponents, suppressed versus committed stores/pops and mask changes within one unit. expose operand pre-rounding and double-rounding bugs separately. preserve input/output seeds and audit oracle discrepancies before changing expected values.

memory tests include every m80 split1..9, exact-length mappings, late missing/permission bytes, write-only destinations, high addresses/u64 end, segment failures, alias overlap, identity stores and self-modifying successors. pending tests include GP/SSE work before detection, FN controls under pending state, budget0, stop at a waiting PC, standalone last-byte WAIT, waiting aliases split by budget/stop, resource limits, eviction and changed imports at retained middle entries without recompilation. a unit with a future x87 instruction cannot impose x87 effects on a skipped path. verify metadata under nonzero segment bases and distinguish origin from detector PC.

host tests cover malformed fields/arrays, getter reentry, rejected atomic imports, projection preservation, pending state across diagnostic clearing, all lifecycle states and private layout/export/high-pointer failures. non-x87 execution must preserve empty payloads and pending state, including new runs and helper calls. new helper imports require factory validation before initialization.

freeze the pre-change Core/host build and compare existing scalar, checked-memory/RMW, stack/control, multiply/divide, REP, exchange/LOCK, integer/raw/FP SIMD, budget-one and churn cohorts with matched inputs/outputs. inspect unchanged artifacts where decode frontiers permit; x87 state must not become an unconditional snapshot or per-entry bank copy in non-x87 units. record added construction validation and transport size separately.

characterize x87 loads/stores4/8/10, exact signed conversions, dependent arithmetic under PC24/53/64 and RC0..3, FRNDINT/FSQRT/comparisons, eight live physical slots, TOP churn, raw/integer/FP mixtures, FLDCW in a loop, sticky status, masked conditions and unmasked producer→integer→detector sequences. include budget-one entries, retained middle entries, fault repair and executable aliases. record checked raw outputs, translation, browser compilation/instantiation, construction/first completion, early/later reuse, native entries/dispatches and generated/cache/transport bytes. distinguish explicit host state materialization from execution time. first completion is not an independent cold-start distribution; newly executable x87 forms need characterization rather than a speedup claim against unsupported baseline code.

## independent packets

hexadecimal raw80 below uses `sign/exponent:significand`; these are complete physical payloads, not host floats. use distinct untouched banks and memory guards. initial TOP=0/CW=`037f`/SW=0 unless stated. nonempty source tags must match the specified setup; other slots are empty. apply defined-status masks: for arithmetic examples C0/C2/C3 are undefined and excluded; TOP, flags, C1, SF, ES and B remain checked. successful producers retire once even if they post pending status.

| packet                                                                                 | required result                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CW=`007f`, empty stack, `DF 2B` FILD m64 `[RBX]` containing `0020000000000001`         | exact `4034:8000000000000400` at physical7; TOP7, tags=`3fff`, SW=`3800`. PC24 does not round this integer load.                                                                                                                                                                                                     |
| PC24, empty stack with old C1 set (SW=`0200`), `D9 EB` FLDPI; CW=`007f/047f/087f/0c7f` | full64-bit results `4000:c90fdaa22168c235/c234/c235/c234` respectively, TOP7, tags=`3fff`, SW=`3800` on defined bits; no PE and C1 clear. PC does not shorten a constant.                                                                                                                                            |
| `D8 C1` FADD with ST0=`3fff:8000000000000000`, ST1=`3fc3:8000000000000000`             | PC64: `3fff:8000000000000008`, no PE; PC53/24 nearest-even:1 with PE. PC53 upward CW=`0a7f`: `3fff:8000000000000800`, PE/C1.                                                                                                                                                                                         |
| PC53, add `43fe:8000000000000000` to itself                                            | `43ff:8000000000000000`, exact finite2^1024 without OE/PE. reduced precision does not narrow the exponent to f64.                                                                                                                                                                                                    |
| PC24, exact operands1 and `-1+2^-63`                                                   | exact2^-63 without PE, not zero from prematurely rounding the second operand. additionally `(1+2^-24)+2^-65` rounds directly to `1+2^-23` in nearest-even PC24; the PC53 analogue rounds to `1+2^-52`.                                                                                                               |
| ST0=`3fff:8000008000000001`, `D9 1B` FSTP m32 `[RBX]`                                  | store `3f800001`, TOP1, old top empty, PE/C1; direct ext80 rounding differs from passing through f64.                                                                                                                                                                                                                |
| all tags valid, all payloads1; `D9 E8` FLD1                                            | masked stack overflow: TOP7, physical7=`ffff:c000000000000000`, tags=`8000`, SW=`3a41` on defined bits.                                                                                                                                                                                                              |
| empty ST0 with raw negative zero `8000:0000000000000000`; `D9 E5` FXAM                 | SW condition bits=`4300`, no IE/SF, unchanged payload/tags/TOP. classify emptiness from the tag and sign from payload.                                                                                                                                                                                               |
| PC53/PM clear CW=`025f`, FADD1+2^-60; then GP work and WAIT                            | producer writes1 and SW=`80a0` on defined bits, advances/retires; GP work executes; WAIT reports vector16 at its own PC with pending PE and the producer's saved metadata.                                                                                                                                           |
| ST0=1.5, `DB 1B` FISTP m32 `[RBX]`; PM clear CW=`035f`                                 | store integer2 and pop; SW=`8aa0` on defined bits, with pending PE. IM clear with +infinity instead suppresses store/pop and sets IE/pending.                                                                                                                                                                        |
| OM clear CW=`0377`; `D8 C9` FMUL max finite `7ffe:ffffffffffffffff` by2                | wrapped register `1fff:ffffffffffffffff`, SW=`8088` on defined bits; no PE for this exact wrapped result.                                                                                                                                                                                                            |
| UM clear CW=`036f`; FMUL minimum normal `0001:8000000000000000` by0.5                  | wrapped `6000:8000000000000000`, SW=`8090` on defined bits; no PE. floating stores of2^128 to m32 with OM clear, or2^-150 with UM clear, instead preserve destination/TOP and do not report PE.                                                                                                                      |
| DM clear CW=`037d`, empty stack; `D9 03` FLD m32 `[RBX]` with `00000001`               | push `3f6a:8000000000000000`, TOP7/tags=`3fff`, SW=`b882`. raw m80 smallest subnormal via `DB 2B` instead stays raw, gets special tag and does not raise DE.                                                                                                                                                         |
| QNaN `7fff:c000000000000011` against1; FCOM versus FUCOM                               | ordered compare produces unordered with IE; FUCOM produces unordered without IE. FCOMIP/FUCOMIP produce EFLAGS=`447` from`cd7` and pop as permitted; IM clear FCOMIP preserves ZF/PF/CF and TOP but clears OF/SF/AF: incoming flags`c92` become`402`, with IE/pending. incoming`cd7` become`447` even without a pop. |
| imported CW=`037b`, SW=`a884`; `DF E0`, then `9B DB E3`                                | FNSTSW writes only AX=`a884`; WAIT reports pending ZE before FNINIT. `DB E3` alone instead resets CW/SW/tags/environment while preserving every raw payload. without pending state, budget1 on `9B DB E3` retires only WAIT and leaves FNINIT for resumption.                                                        |
| `DA C1` FCMOVB with CF clear, nonempty ST0=1 and empty ST1; old C1 set                 | masked invalid replaces ST0 with indefinite, tag special, IE/SF set and C1 clear despite the false condition. IM clear preserves ST0/tags and posts pending IE. repeat with the condition true and all four operand-tag combinations.                                                                                |

an independent bit-level/high-precision oracle must implement ext80 exponent and direct PC rounding, plus instruction-specific x87 status and stack responses. reference agreement using the same arithmetic implementation lineage is insufficient. record the model, controls, raw operands and source lineage for native/reference observations; Rosetta or mathematical precision alone does not prove complete x87 behavior. review any numeric dependency for source/license, wasm32 compatibility and per-vCPU control/status isolation before adoption.

## increments and references

land executable increments: raw state/imports and FN controls; checked data/conversion/stack forms; direct-PC arithmetic and deferred effects; comparisons/classification/conditional moves; then complete mode, memory, restart, independent numeric and performance coverage. each increment has tests through the relevant public boundary; final acceptance covers every selected form, not only a state container or default masked arithmetic.

- [Intel SDM collection](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html), revision093: volume1 §§4.8–4.9,8.1–8.7 and AppendixD; volume2 selected instruction entries; volume3A event16 and exception priority, plus §11.1.1 for multi-byte accesses.
- [AMD APM volume1](https://docs.amd.com/api/khub/documents/sfvvekC9mDflu6vd3R0NXA/content),24592 revision3.24 §§6.2.5.1–6.2.5.3: pointer representations by mode. canonical pointer storage and future image packing are distinct.
- [Intel AP-526](https://kib.kiev.ua/x86docs/Intel/Intel-OptimGuide/242816-001.pdf),242816-001 §4.2.2.1.2: unconditional FCMOV stack-operand checks. use the current SDM for numeric defaults and defined flags.
- [Intel XED patterns](https://github.com/intelxed/xed/blob/main/datafiles/xed-isa.txt): selected documented forms and prefix/register-field legality; instruction semantics remain governed by the manuals.
