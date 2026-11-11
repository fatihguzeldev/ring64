# independent port I/O acceptance and mutation audit

The acceptance branch starts at `9920acad30dbf146b9863ed9409ad4196e9aa16f` and adds literal public fixtures through `51cdf3f`. This record covers that source and its actual generated Wasm in Node and Chrome. It does not establish native hardware equivalence, reset integration, application compatibility or throughput.

## acceptance boundaries

Nineteen shared scenarios in [the I/O scenario registry](../../tests/execution/io/index.ts) add these independent observations:

- [Guest repair](../../tests/execution/io/review-repair.ts): three inputs precede a destination #PF; the guest ORs its PTE, executes INVLPG and IRETD, and retries only the unfinished element with a fourth fresh input. A private handler-fetch refusal retains the already entered frame and completed progress across repair.
- [Scalar transfer packets](../../tests/execution/io/review-scalar.ts): fourteen imported code/stack/mode profiles, three widths, both directions and immediate/DX ports give 168 transactions, plus literal REX/66 and incomplete/invalid prefix priority packets. Assertions distinguish AL/AX parent preservation from Long64 EAX zero extension.
- [Permission geometry](../../tests/execution/io/review-permissions.ts): noncanonical TSS access versus widened private overflow, terminal ports, mandatory two-byte permission words, missing second bytes before denial, short maps and privilege bypass. Implicit TSS reads do not create operand watchpoints.
- [String operands](../../tests/execution/io/review-operands.ts): address16/32/64 index and count publication, DF wrapping, complete word spans, segment refusal before input, private destination refusal after input, live FS/GS for OUTS and fixed ES for INS. A late OUTS source #PF emits no failed-source output and resumes only the remaining element.
- [Debug boundaries](../../tests/execution/io/review-debug.ts): inactive I/O comparators, RF suppression, unfinished TF and data traps after committed effects, and durable SS-deferred causes merged with the completed destination write.
- [Provider lifetime](../../tests/execution/io/review-lifecycle.ts): option/method getters captured once before an await, original callable plus live receiver data, an own callable `.call` getter, premature generated-instantiation effects, independent CPU execution inside a callback, and code-changing INS progress before a later compile quota.

The fixtures use public CPU methods and actual Core/generated modules. Expected bytes, frames, counters and fault packets are literal test values, rather than values computed through the production decoder, permission owner or family resolver.

## semantic mutation controls

Each mutation was applied separately to the acceptance source. Rust changes rebuilt the Core module; host changes ran through the same TypeScript/actual-Wasm public scenario. Every row produced its existing named semantic assertion failure with exit status1. Compile failures, unrelated traps and empty scenario filters were excluded.

| changed behavior                                                  | unchanged assertion that failed                            |
| ----------------------------------------------------------------- | ---------------------------------------------------------- |
| preflight INS private destination before input                    | segment admission precedes input; private store follows it |
| omit OUTS source read                                             | late source PF                                             |
| read one permission byte and zero-fill its omitted high byte      | terminal permission decision                               |
| ignore bitmap denying bits                                        | second element denied                                      |
| charge bare I/O a repeat allowance                                | positive repeat allowance is untouched by bare forms       |
| omit completed string index publication                           | index advances once                                        |
| omit host execution-scope guard                                   | premature native effect rejects run                        |
| recapture the provider's current read property                    | live receiver data with original method                    |
| invoke the captured function through its mutable `.call` property | captured callable call property never inspected            |
| ignore the I/O store/source-change classification                 | only new PAUSE compile is refused                          |
| let REX.W override the I/O 66 width                               | ignored REX.W/extensions                                   |
| clear durable SS history in the I/O diagnostic reset              | old read + committed destination write                     |
| omit unsigned dword output normalization                          | unsigned full-width transactions                           |

Result: **13/13 semantic kills**. The first attempt at the one-byte permission mutation used an unsupported vector-read width and trapped; that attempt was discarded. Its replacement uses an admitted scalar byte read with explicit zero fill, so the counted failure observes permission semantics.

The campaign restored every patched source byte and the exact initial Core artifact after each mutation. A complete positive gate then rebuilt the restored source and passed again with the same Core SHA256:

`bed12930ef05b63519cfaa8f272b1c2702db8ed8333d844a0d1de840617def64`

Local raw logs are `/tmp/ring64-io-audit-mutation-evidence/report.json`, one log per mutation in that directory, and `/tmp/ring64-io-audit-restored-check.log`. The temporary campaign and runner are `/tmp/ring64-io-audit-mutations.py` and `/tmp/ring64-io-audit-mutation-runner.mjs`; they are session evidence rather than shipped test infrastructure.

## restored-source gate and limits

`npm run check` passed formatting, lint, both clippy targets, **837 native tests**, the release Core/TypeScript build, **234 Node tests**, and **908 shared Chrome scenarios** under Chrome157.0.8103.79. The last shared scenario batch runs the literal I/O fixtures in both Node and Chrome. README was unchanged, and this audit branch was not pushed.

No wall-time benchmark ran during concurrent compilation. Quiet paired performance, reset/provider preservation, physical PG0 I/O integration and the final combined five-spec gate belong to the integration record; these results do not claim those later checks.
