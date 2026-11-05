# long-mode addressing

extend the [initial execution contract](../initial-execution/spec.md) with SIB and RIP-relative addressing for the existing MOV memory forms, and add LEA. its execution context, memory policy, retirement, exits and artifact ownership continue to apply.

## admitted forms

- `89 /r` and `8B /r`: retain register/register forms; admit all memory addressing forms described below for 32- and 64-bit data.
- `8D /r`: compute an effective address into a 32-bit destination, or a 64-bit destination with `REX.W`. `REX.R` extends the destination register. `mod=11` is `invalid-encoding` immediately after ModR/M, without fetching a SIB or displacement.
- address size remains 64 bits, independently of data or destination width. retain the existing optional single REX prefix. address-size override `67`, operand-size override `66`, segment overrides and other prefix combinations remain outside this coverage.

## effective address

compute the full 64-bit effective address before any destination-width conversion:

```text
ea = (base + index * scale + signed displacement) mod 2^64
```

register terms read the current 64-bit banks. an absent base, index or displacement contributes zero; scale is 1, 2, 4 or 8. disp8 and disp32 are sign-extended to 64 bits. arithmetic wraps without a guest overflow fault. memory accesses validate the resulting span, not the individual register terms. aliased address terms, store sources and destinations all use the pre-instruction register values.

encoding rules:

- `mod=00` has no displacement except the required disp32 cases below; `mod=01` takes disp8 and `mod=10` takes disp32.
- memory forms with ModR/M low `r/m=100` consume a SIB byte, regardless of `REX.B`.
- SIB base and index normally select registers using `REX.B` and `REX.X`, respectively.
- SIB `index=100` means no index with `REX.X=0`, and selects `r12` with `REX.X=1`. all scale encodings are accepted when the index is absent; they contribute no index term.
- SIB `base=101, mod=00` means no base and requires disp32, regardless of `REX.B`. this form is not RIP-relative, including when both base and index are absent.
- with `mod=01/10`, base `101` selects `rbp` or `r13` normally and consumes disp8/disp32. base-only `rbp/r13` uses an encoded zero displacement.
- non-SIB `mod=00, r/m=101` uses the complete instruction's `next_pc` as base and requires disp32, regardless of `REX.B`. include the opcode, prefix, ModR/M and displacement bytes in `next_pc`; its sequential u64 wrap is preserved.
- `REX.X` remains ignored without SIB. unused REX fields do not turn an admitted form into unsupported coverage.

the decoder reads every required SIB/displacement byte through the existing bounded instruction source. truncation reports the required-byte fetch failure. discovery does not turn an unreached truncation or data address into an early exit.

## effects and access

MOV passes the full effective address and its 4- or 8-byte width to the existing memory owner. a 32-bit data operation still uses a 64-bit address. stores write the source's low 32 or 64 bits and preserve all sixteen register banks and flags. full-span overflow, canonicality, mapping and permission checks retain their existing order. a failed access preserves this instruction's destination, flags and memory; earlier completed effects remain committed.

LEA writes the effective address without a data-memory access. unmapped and noncanonical results are valid values; there is no data-access canonicality, mapping or permission check. a 32-bit destination takes the low 32 bits and clears the bank's upper half; a 64-bit destination takes the entire result. flags are unchanged. instruction fetch and encoding checks still apply.

each successful MOV or LEA retires once and advances to the decoded `next_pc`. budget and stop are checked at the same instruction boundaries as before, including entry into the middle of a cached unit.

## representation and lowering

decoded addresses distinguish a register base, next-instruction base and absent base, together with an optional index, scale and signed displacement. this is an architectural expression, independent of backing-memory offsets and Wasm encoding.

lower address expressions to generated Wasm arithmetic using current guest-register locals. MOV uses the checked memory helpers; LEA consumes the computed value directly. immutable instruction addresses and encoding constants may be folded. imported register values and RAM contents are not translation constants. reuse and middle-entry execution must observe fresh base/index values without assuming an unexecuted predecessor ran.

## verification

cover all scales, displacement signs and widths, base/index absence, extended registers, and destination/base/index/store-source aliasing. distinguish SIB no-base from RIP-relative and no-index from R12-index. test RSP/R12 bases and RBP/R13 zero-displacement encodings. verify the same expressions with LEA and MOV, including 32-bit data with high bits independently present in the base and index.

the following packets use separate code images containing exactly the listed bytes, pc `0x1000`, budget one and flags `0x8d7`, except where overridden. RAM is one byte `00` at `0x4000` unless the row supplies a replacement span. initialize bank `i` to `0x1122334400000000+i`, then apply the listed inputs. supply all limits explicitly, large enough to admit and retain the case, with no requested stop. assert all banks, flags, RIP, counts and RAM, including unchanged guard bytes; only the listed stores change memory. success returns `budget`, retires one and advances by the packet length. failure retires zero, retains the original RIP and leaves one budget unit.

| bytes                         | inputs                                                                                             | expected distinction                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `4f 8d 44 8c f0`              | r12=`0x1000`, r9=5                                                                                 | r8=`0x1004`; REX.R/X/B select destination, index and base independently.                                       |
| `48 8d 04 e4` / `4a 8d 04 e4` | rsp=`0x1000`, r12=`0x10`                                                                           | rax=`0x1000` / `0x1080`; absent index ignores scale, while REX.X enables r12.                                  |
| `49 8d 04 25 fc ff ff ff`     | r13=`0x4000`                                                                                       | rax=`0xfffffffffffffffc`; no base despite REX.B, signed disp32.                                                |
| `49 8d 05 f9 ff ff ff`        | first pc=`0x1000`, then a separate image at pc=`0x100001000`                                       | rax equals the corresponding instruction start; base is full next RIP, not r13 or a truncated pc.              |
| `48 8b 04 24` / `49 8b 04 24` | rsp=`0x100004000`, r12=`0x100004008`; RAM at `0x100004000` is `88776655443322110807060504030201`   | rax=`0x1122334455667788` / `0x0102030405060708`.                                                               |
| `8b 04 8b`                    | rbx=`0x100004000`, rcx=2; RAM `78563412` at `0x100004008`                                          | rax=`0x12345678`; 32-bit data does not truncate the address.                                                   |
| `42 8b 04 0d fc ff ff ff`     | r9=`0x100004004`; RAM `78563412` at `0x100004000`                                                  | rax=`0x12345678`; absent base retains the full extended index and signed disp32.                               |
| `47 89 44 8c f0`              | r12=`0x100004000`, r9=5, r8=`0x11223344aabbccdd`; RAM at r12 is `101112131415161718191a1b1c1d1e1f` | RAM becomes `10111213ddccbbaa18191a1b1c1d1e1f`; extended source, 32-bit store, 64-bit address.                 |
| `89 0c 8b`                    | rbx=`0x4000`, rcx=`0x100000002`; RAM at `0x400004008` is `a0a1a2a3`                                | RAM becomes `02000000`; the index/source bank retains `0x100000002`.                                           |
| `48 8d 04 cb` / `48 8b 04 cb` | rbx=`0xfffffffffffffff8`, rcx=`0x2000000100000002`; RAM `8877665544332211` at `0x800000008`        | rax=`0x800000008` / `0x1122334455667788`; multiply and addition wrap, noncanonical register terms are valid.   |
| `48 8d 44 80 08`              | rax=1                                                                                              | rax=`0xd`; destination, base and index all read the old bank.                                                  |
| `48 8d 43 01` / `8d 43 01`    | rbx=`0x7fffffffffff`                                                                               | rax=`0x800000000000` / zero; LEA accepts the noncanonical effective address and preserves flags.               |
| `48 8b 43 01`                 | rbx=`0x7fffffffffff`                                                                               | `data-fault`: noncanonical 8-byte read at `0x800000000000`, first failing byte at that address; rax unchanged. |
| `48 8d 05 00 00 00 00`        | pc=`0xfffffffffffffff9`; code ends at the final u64 byte                                           | rax=zero, rip=zero; next RIP wraps only after the complete instruction.                                        |
| `48 8d c0` / `48 8d c4`       | pc=`0xfffffffffffffffd`; code ends at the final u64 byte                                           | `invalid-encoding`; no hypothetical SIB fetch at `2^64`.                                                       |

repeat new MOV and LEA forms through reused artifacts with flags `0x2`, `0x3`, `0x6`, `0x12`, `0x42`, `0x82`, `0x802` and `0x8d7`; each preserves the exact input. at the lowering boundary, run LEA with data-access imports that fail if called, including a result inside mapped RAM. successful exits carry no fault metadata.

use this unit at `0x1000`: `bb00400000 488d348b 488d1500000000` (`mov ebx,0x4000; lea rsi,[rbx+rcx*4]; lea rdx,[rip+0]`). admit all three entries, execute with budget one, then import fresh banks with rbx=`0x100005000`, rcx=2 and rip=`0x1005`. budget two must reuse the same artifact without compilation and return rsi=`0x100005008`, rdx=`0x1010`, rip=`0x1010`, retired two and remaining zero. all other banks, flags and RAM retain their freshly imported values. this distinguishes unexecuted predecessor facts and each instruction's own next RIP from the unit's entry pc.

for reached diagnostic priority, start with `b801000000` at `0x1000`, followed in separate images by the tails below. each starts with an empty cache; code ends at the tail's final byte, RAM is one byte `00` at `0x4000`, and there is no requested stop. use `maxInstructions=1`, `maxTranslationsPerRun=1`, budget three, rbx=`0x800000000000` and rcx=0. supply the other limits explicitly and large enough to admit and retain either single-instruction artifact. each exits at rip=`0x1005` with rax=1, retired one and remaining two:

| tail          | expected exit                                                                      |
| ------------- | ---------------------------------------------------------------------------------- |
| `48 8d c4`    | `invalid-encoding`, without a SIB fetch.                                           |
| `48 8d 04`    | `fetch-fault`, execute access to the missing SIB byte at `0x1008`, cause unmapped. |
| `48 8b 04 8b` | `resource-limit`, before checking the operand address.                             |

resume the last case with budget one. the new run admits the load and returns `data-fault`: instruction pc `0x1005`, operand and first failing address `0x800000000000`, width eight, access read, cause noncanonical; retired zero, remaining one, and the completed prefix state unchanged.

also verify failed full-span SIB stores with guard bytes and exact failure tuples for overflow, canonicality, mapping and permissions; truncation before SIB and at each displacement byte; budget zero/one, stop at entry/next pc and fault repair/resume. reuse the same artifact after changing base/index registers and RAM; exercise overlapping-owner eviction. run decoder checks and complete generated-path cases in Node and Chrome with independently calculated expectations.

## performance

run unchanged base-plus-displacement loops before and after the extension with the same guest bytes, state, RAM, limits and exits. include several simultaneously live register banks. separately characterize output-checked SIB read/write loops and a register-dependent LEA recurrence with destination/base aliasing and changing imported indices. report RIP-constant specialization separately. record complete state and guards alongside translation, browser compilation/instantiation, first completion, reused execution, emitted bytes and native-entry/dispatch counts. inspect emitted function/call/local growth when comparing lowerings; native entries count host-to-generated invocations, not internal helper calls.

use normal browser settings, balanced repeated runs and workloads long enough to distinguish reused execution from timer resolution and host setup. retain raw samples and separate early from later execution windows. isolate repeatable old-form slowdowns outside run-to-run variation and resolve their cause before accepting the extension.

new encodings have no executable baseline in the old coverage; characterize them separately. alternative lowerings must execute identical guest bytes with identical initial inputs, full final state, RAM, budgets, stops, exits and retired counts. comparisons between different guest instruction sequences are separate workload comparisons.

## references

- [intel SDM volume 2A](https://cdrdv2.intel.com/v1/dl/getContent/671199), 253666-093us: sections 2.1.5 and 2.2.1.1–2.2.1.6, tables 2-5 and 2-7; LEA, pages 3-547–3-549.
