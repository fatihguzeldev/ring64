# architectural access fault oracles

These scenarios use literal instructions and expected vectors/frames through the public Cpu and generated Wasm. They run in the shared Node/Chrome suite. Existing per-family suites continue to check private admission, detailed diagnostics, numeric priority and partial publication.

## decode inventory

`DecodeError::Invalid` means a recognized illegal form; unknown opcodes, unimplemented forms and retained prefix frontiers use `Unsupported`. `InstructionLength` is separate because its vector/error slot differ. The literal rows in `decode.ts` cover the current production sites:

| owner                                   | selected illegal condition                                                                                           |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `opcode.rs`                             | nonlockable operation; LOCK string/direction flag; long64 PUSHA/POPA; register LEA; real/VM ARPL; register CMPXCHG8B |
| `streaming.rs`                          | memory MASKMOV; register MOVNT; register LDMXCSR/STMXCSR                                                             |
| `mmx.rs`                                | memory operand for register-only PEXTRW/PMOVMSKB/MMX-XMM conversions                                                 |
| `software_events.rs`, `system_flags.rs` | long64 INTO/POP SS                                                                                                   |
| `protection.rs`                         | reserved segment index/MOV CS; register far-pointer load; real/VM descriptor operations                              |
| `vector.rs`                             | memory operand for register-only operations; register operand for memory-only half stores                            |
| `far.rs`                                | long64 immediate far transfer; register far indirect transfer                                                        |
| `numeric_image.rs`                      | register operand for memory-only state image                                                                         |
| `cursor.rs`                             | byte16 demand selects length #GP before acquiring byte16; earlier required-byte failure stays private                |

Instruction-reference basis: the corresponding instruction entries in Intel SDM volumes2A/2B/2C (linked by the spec), including LOCK/#UD and mode/form exceptions. The oracle is the literal row, not `architectural_fault()` or a decoded instruction returned by the implementation.

## access consumer inventory

All consumers retain their existing access order and commit rules. The new x86 protection classifier only selects already detected failures; embedding staging and automatic entry consume that decision.

| consumer / transport                                       | selected evidence and preserved frontier                                                                                                                                                 | public oracle owners                                                                          |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| instruction probe and `core_probe`                         | CS limit/canonical failure; private required-byte backing; reached decode provenance only                                                                                                | `decode.ts`, `runtime.ts`, inherited mode/cache/frontier suites                               |
| scalar load/store/for-write and generated `memory_failure` | generated effective segment is published before staging; private permissions/domain overflow stay private                                                                                | `runtime.ts`, inherited memory/exchange suites                                                |
| near stack/target/LEAVE and far control                    | SS pointer/stack access differs from CS target; no guessed target after an earlier private refusal                                                                                       | `runtime.ts`, inherited near/far control suites                                               |
| repeated strings                                           | same segment helper, per-element checkpoints and comparison-entry flags                                                                                                                  | `recovery.ts`, inherited strings/system-flags suites                                          |
| vector/MMX/x87                                             | checked logical access, instruction-specific pending/status priority; mandatory alignment selects GP0                                                                                    | `runtime.ts`, inherited SIMD/floating/x87/streaming suites                                    |
| legacy/FX images                                           | logical-span check precedes selected fields; mandatory alignment GP0; preserved fields are not additional guest accesses                                                                 | `runtime.ts`, inherited numeric-state suites                                                  |
| MASKMOV, CLFLUSH and hints                                 | nominal geometry even at zero mask; selected writes only; PREFETCH/LEA no access                                                                                                         | `runtime.ts`, inherited streaming suites                                                      |
| explicit descriptor operands / GDT / LDT                   | operand segment vs system-table provenance; canonical system read GP0; widened overflow/backing private                                                                                  | `entry.ts`, inherited protection suites                                                       |
| software entry / IRET                                      | existing typed selector codes and early effects retained; hard-zero stack/target codes stay zero with EXT; switched legacy stack limits retain NewSS/EXT alongside the report diagnostic | `recovery.ts`, `stack-switch-review.ts`, inherited software-event suites and Rust event tests |
| automatic entry / IDT / TSS / frames                       | selected failures feed secondary/DF/shutdown; TSS selector-coded rules retained; private refusal preserves accepted source                                                               | `entry.ts`, inherited exception/external suites                                               |

Long64 ignores legacy segment type/null/limit metadata and ignored CS/DS/ES/SS overrides. Protected/compatibility null-data selection requires an actual unusable failure plus null index/TI; a usable imported cache with selector0 gets no new check. Artificial unusable/type SS caches have no blanket architectural mapping. Host validation rejection stays a host error.

`recovery.ts` checks guest repair of an executable alias, alignment register, loaded null DS and an IST-saved source stack, plus partial REP resumption. Frames use independently authored values, including saved RF1 and literal hard-zero slots. Mandatory alignment, canonicality, private widened ranges and system-table geometry have separate expectations.
