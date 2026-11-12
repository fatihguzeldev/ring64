# legacy paging and permissions

Status: implemented; see [verification](verification.md) and the [integrated audit](../five-spec-integration/verification.md). Source audit baseline: `4df41a0814beaceb0681dc013f5eac094cdc6660`. Third of five; depends on [numeric execution controls](../numeric-execution-controls/spec.md). Historical source-audit and executable measurement cohorts are distinguished in the verification records.

## objective and admitted families

Execute imported protected16/protected32 and virtual8086 guests through Intel non-PAE and PAE paging, including actual root/PTE changes, A/D effects, #PF, legacy handler repair and IRET retry. Both formats, all currently implemented operand/system consumers and generated-source validity belong to this increment. Importing another CR3 into the existing IA32e walker is insufficient.

This increment starts with PE=PG=1 and LME=LMA=0. PG0/real execution, guest PE/PG/PAE/LME family transitions and reset belong to the following [reset/mode-transition spec](../reset-and-mode-transitions/spec.md). No TLB, PCID, global-translation retention, SMEP/SMAP, protection keys, five-level walks, cache simulation, task switching or device platform is added. Accept selected PAT/PWT/PCD format bits without modeling memory types; G is ignored with PGE0.

The source baseline has physical backing, prepared stores, four-level walks, typed #PF/events and artifact ownership. It hard-fixes IA32e controls and permits paged decode only in Long64/compatibility. Preserve the existing private-linear and `ia32e-paged` APIs/semantics while adding the explicit physical plane below. The inherited [paging](../long-mode-paging-and-permissions/spec.md), [access ordering](../architectural-access-and-legality-faults/spec.md), [events](../software-events-and-iret/spec.md) and [code ownership](../context-and-code-reuse/spec.md) remain contracts.

## public physical plane and complete checkpoints

Add `memoryModel: 'physical'`, an immutable backing-address plane whose active translation family follows controls. Require explicit `memory: { backings, mappings }`, `entry`, `memoryLimits`, a complete non-undefined `context` and complete `paging`. Context must be protected16/32 or virtual8086, consistent with controls and existing loaded-cache validation. Reject `code`/`ram` shortcuts, mixed constructor forms, missing/undefined required fields and invalid profile combinations before allocating/publishing the CPU. Do not introduce separate permanent legacy32/PAE backing models.

Reuse `readPhysicalMemory`/`writePhysicalMemory`, backing administration and paging-state methods on this plane. `readMemory`/`writeMemory` stay private-linear-only. Physical host administration bypasses guest segmentation/walk/A-D/operand-debug but retains backing/alias/source invalidation. Legacy physical CPUs reject the `fastSystem` constructor field even if explicitly undefined, and reject its methods until spec4 adds a consumer-compatible physical lifecycle; do not silently store an unused second bank. Existing `ia32e-paged` inputs retain their meanings.

Use a complete paging projection with the existing five raw unsigned64 words and `pdpte: [bigint,bigint,bigint,bigint]` exactly when **active legacy PAE** (PE1/PG1/PAE1/LMA0). Capture four own indexed array values once into an owned tuple; require exact length4 and primitive unsigned64 values, with no holes/coercion/user iterator. Omit/reject the property, including explicit undefined, outside that family. A readback is detached. Host constructor/idle bank import installs the captured quartet directly, validates all present entries and does not fetch PDPT RAM. A checkpoint therefore survives edited/unmapped/unreadable old PDPT storage.

Capture all candidate fields before the normal lifecycle/generation recheck, then publish atomically. A failed outer capture cannot undo a nested successful run/setter/disposal. Scalar changes preserve paging; compatible context imports retain the quartet and their existing event/shadow cancellation. Control/numeric/memory repair preserves historical fault/debug sources. Context and paging setters individually require a state compatible with the live other authority; a cross-family constructor restore is atomic, and no aggregate all-CPU setter is required. Guest family changes remain deferred here.

## raw controls versus effective roots

Retain spec2's variable MP/EM/TS and OSFXSR/OSXMMEXCPT. For this physical profile CR0 has PE/PG/ET/NE1, variable numeric bits and WP, with CD/NW/AM0. CR4 has DE1, variable PSE/PAE and numeric bits; PGE/SMEP/SMAP/PCIDE/LA570. PAE selects the imported family. EFER has LME/LMA0, variable NXE/SCE, other unsupported/reserved rules unchanged. SCE storage does not enable legacy fast-system instruction coverage; that remains outside this selected profile, including legacy SYSENTER and AMD-compatible SYSCALL. Unknown MSRs retain the private frontier.

Raw CR2 remains unsigned64 without canonical filtering; mode changes/imports do not truncate it. A legacy guest MOV from CR2 reads the low32 and writes the canonical GPR under the existing legacy32 merge rule (preserving its raw upper GPR bits). MOV to CR2 outside Long64 zeroes the control register's upper32; a new legacy #PF also writes zero-extended linear32. Never confuse the GPR merge policy with the control-register write policy or a frozen old page-fault address.

For the new physical plane retain raw CR3 bits51:3, requiring bits63:52 and2:0=0 on host import. Upper32 and low bits that become ignored in another family may contain retained data; no mode/family change silently normalizes them. Effective non-PAE root is `cr3 & 0xfffff000`; effective PAE PDPT root is `cr3 & 0xffffffe0`, always below4GiB. This is separate from the current `ia32e-paged` convenience input normalization. Future IA32e exits can therefore preserve a raw bank without a new mode-history flag.

Actual legacy MOV CR3 consumes its32-bit source and zeroes upper32. Select normalized guest write images: non-PAE retains bits31:12 and PWT/PCD bits4:3; PAE retains31:5 with low5 zero. CR3 readback returns stored bits through the form's register-width rule. The PAE root need only be32-byte aligned, not4KiB; `0xffffffe0` is a valid final32-byte root below4GiB. Host bank restore is not a guest MOV CR3 and never implicitly reloads the quartet.

Admit MOV CR0/2/3/4, selected EFER RDMSR/WRMSR, CLTS and INVLPG in the physical legacy decoder; MOV CR transfers32 bits regardless of66/code16. Illegal register/LOCK encoding and CPL0 admission retain their own order. VM86/CPL3 control or INVLPG denial occurs before PDPT/data access. INVLPG forms only its effective linear address; no target data/PTE read is required. Family-changing PAE/PG/PE writes may remain private unsupported **after** architectural invalid-value checks. Setting EFER.LME while PG1 selects #GP(0), not Unsupported; LMA input is read-only/ignored and remains0. NXE/SCE can change without LME. Reject unknown/reserved bits before publication.

## PAE capture, writer effects and physical refusals

Every guest MOV CR3 in active PAE, including a same-value write, loads all four little-endian64 PDPTE registers from the effective candidate root. After privilege/value/facility admission, select this explicit private-RAM preparation policy: read four slots in ascending physical-address order, completing all32 read bytes before validating present entries in slot order0–3. A missing/denied byte at a later slot wins over an earlier captured reserved value; after repairing that private refusal the earlier reserved value selects writer #GP(0). This ordering is a Ring64 private-backing choice, not a claim about hardware bus timing.

Present PDPTE bits2:1,8:5 and63:52 are reserved. NX63 is reserved here even with NXE1; bits3/4 PWT/PCD and11:9 software bits are accepted. Select the documented P0-ignores-reserved variant and retain its raw bits. Validate every quadrant, even if the next linear address uses only one. PDPTEs contribute presence/address, not R/W/U/S/XD aggregation or A/D writes. An absent captured entry selects a later access #PF, not a load-time #GP.

A successful load publishes candidate CR3/quartet and its destructive invalidation together, then retires the writer once before successor fetch. Failed capture/validation preserves old controls, quartet and control-publication generation and retires0. Required source fetch may already have set A or invalidated source; do not incorrectly assert that every earlier memory/cache effect rolls back with a failed writer.

Intel's additional load triggers apply when a MOV CR0/CR4 changes CD/NW/PG or PAE/PGE/PSE/SMEP and the resulting family is legacy PAE. Of the currently admitted bits, a PSE toggle reloads all four entries, even though PSE does not select PAE leaf size. Unchanged PSE, numeric bits, WP and INVLPG do not reload. Later admitted triggers inherit this same preparation/publication boundary. A host complete-bank restore supplies its quartet directly rather than emulating a trigger.

PDPT RAM changes alone do not change captured roots. A walk, source dependency recheck, INVLPG or absence of a modeled TLB cannot reread them. Live PDE/PTE bytes still change subsequent accesses immediately under the no-TLB model. IA32e continues its own live in-memory PDPTE behavior; legacy PAE latches must not leak into it.

Reuse reason `physical-memory-fault` and add an explicit discriminated `PhysicalMemoryFault` branch:

```ts
interface PdpteLoadFault {
  instructionPc: bigint;
  phase: 'pdpte-load';
  control: 'cr0' | 'cr3' | 'cr4';
  slot: 0 | 1 | 2 | 3;
  physicalAddress: bigint;
  width: 8;
  failingPhysicalAddress: bigint;
  physicalAccess: 'read';
  cause: 'unmapped' | 'permission' | 'address-range';
}
```

Here `physicalAddress` starts the requested slot and `failingPhysicalAddress` names the failing byte. There is no linear `address/access`, segment, table selector or synthetic operand. Current walk/A/D/final branches retain their existing required linear provenance. The union/parser/layout has one authority and old reason IDs stay unchanged. Control-load refusal updates neither CR2 nor architectural event selection and is not a #PF. The record is transient like other direct diagnostics; an unrelated later failure cannot inherit it.

## complete format and access contract

Legacy address formation retains the inherited segment preflight, then `(base+offset) mod2^32` start address. A complete operand span crossing2^32 keeps the existing private linear address-range refusal at2^32; it does not wrap its tail to0 or become a canonical48 check. Physical addresses use `[0,2^52)` span checks independently; high PAE/PSE-36 addresses need not be canonical. Sparse backing remains valid under a large page, with ordinary private refusal at a missing final byte.

| family         | walk geometry                                                                              | selected leaf/address/reserved rules                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| non-PAE        | 1024 aligned32-bit PDE/PTE entries; indices31:22 and21:12, offset11:0                      | 4KiB leaf uses PTE31:12; PS1 selects4MiB only with PSE1. With PSE0 the PDE.PS bit is ignored and it is a table pointer.                                              |
| non-PAE PSE-36 | 4MiB PDE leaf                                                                              | PDE31:22→PA31:22, PDE20:13→PA39:32, linear21:0 offset; bit21 reserved, PAT12 allowed. MAXPHYADDR52 does not invent more than eight high address bits in this format. |
| legacy PAE     | linear31:30 selects captured PDPTE, then9-bit indices29:21 and20:12, aligned64-bit PDE/PTE | 4KiB or2MiB; PDE.PS selects2MiB regardless of PSE. No1GiB leaf. Address51:12; present62:52 reserved. A2MiB leaf reserves20:13 and allows PAT12; PTE7 is PAT.         |

For PAE, XD63 is reserved at PDE/PTE when NXE0; otherwise OR XD across those two levels. Captured PDPTE NX is always reserved. P0 is tested before reserved fields at each actually selected entry. Aggregate R/W and U/S across PDE/PTE, with WP allowing supervisor writes to read-only pages only when WP0; VM86 ordinary requests are user. System metadata uses supervisor provenance, while frame accesses use their instruction owner's actual privilege.

Select the predecessor's deterministic reached walk/effect order: visit each required present/reserved-valid level and publish its A if absent, descend to the selected leaf, then apply aggregated permissions. A lower nonpresent/reserved entry can therefore win over an upper U/S/R/W denial. A bad present reserved entry gets no A update of its own; prior visited A effects remain. No early upper-permission shortcut may manufacture a different lower fault. This is the selected modeled ordering, not a universal microarchitectural promise.

Entry width is part of the translation/dependency/prepared-update result: four bytes for non-PAE and eight for PAE. Extend [prepared physical updates](../../src/memory/access/prepared.rs), [discovery dependency spans](../../src/dbt/discovery/mod.rs), walk reads, A writes and leaf D reservation/publication together. A four-byte PTE beside unmapped/read-only adjacent bytes must remain usable, and an A/D update must not read/write or register those adjacent four bytes accidentally. Do not pad the semantic access to eight merely because an internal scalar is u64.

A/D updates preserve contemporary ignored/software/address bits by ORing the **current** admitted-width word at publication. D is prepared only for actual permitted payload writes, not speculative discovery, PREFETCH/LEA, failed/fully suppressed stores or mere permission checking. Retain the original prepared destinations if a payload aliases its own PTE; do not rewalk after the alias update or overwrite that update with a stale captured PTE. No-op A/D writes are avoided. Captured PDPTE registers and their RAM storage receive no A/D update.

## #PF, implicit consumers and event entry

New legacy #PF writes zero-extended linear32 to CR2. Error bits are P0/W1/U2/RSVD3/I-D4. Non-PAE I-D is always0, even with EFER.NXE1. PAE sets I-D for fetch only when NXE1. Reserved present PDE/PTE is P1/RSVD1; nonpresent entries ignore garbage and use P0. A private walk/A/D/final refusal leaves CR2 unchanged and preserves the exact physical phase. Reserved captured PDPTE fails its loading writer with #GP, not a reached #PF.

A frozen pending source retains its original canonical48 unsigned64 `pageFaultAddress`, error code and boundary independently of current family, CR2 and repaired tables. Do not narrow an old high-canonical IA32e fault when restoring a physical legacy checkpoint. Source validation and current bank validation are separate; bank repair does not replay or reclassify a selected fault. Secondary architectural faults use existing class/escalation rules and drop replaced vector-specific metadata; private failures preserve the selected source.

Route fetch, scalar/LOCK/bit-string operands, stack/far/IRET, strings, SIMD/MMX/x87/images, MASKMOV/non-temporal operations, descriptor accessed/busy writes and all GDT/LDT/IDT/TSS/event-frame accesses through the one family-selected guest-memory authority. Do not add independent walkers to every helper. Host physical administration and PDPT loads bypass guest paging; architectural system reads remain paged supervisor requests. Entry stacks use destination privilege and returns their inherited source privilege. Nominal span versus selected payload/debug/D behavior stays instruction-specific.

PAE is not IA32e event delivery. Protected sources use existing8-byte legacy IDT gates and16/32-bit entry/error frames; VM86 processor entry retains its selected32-bit gate→CPL0 path and ten-dword error-frame layout. A valid16-bit gate for a VM86 source remains the inherited private Unsupported frontier after gate type/presence admission, not a new fabricated #GP. Do not select16-byte IA32e gates or qword frames from CR4.PAE alone. Handler removes the error slot before IRET and resumes the interrupted instruction/remaining REP work without replaying committed predecessor or element effects.

## executable ownership and completion

Source identity includes active family, relevant raw control projections and the captured quartet as needed. Discovery uses only captured PAE roots and observational live PDE/PTE reads; it never loads PDPT, writes A/D, or prevalidates a future control writer. Dependencies register actual-width live PDE/PTE physical bytes and backing incarnations. PDPT RAM is not a legacy PAE walk dependency; if it independently aliases code, ordinary source invalidation still applies.

Every guest CR3 reload and existing INVLPG fence retains the predecessor's destructive ownership policy. PSE/root/quartet changes revoke relevant pending/native/dormant/middle proofs, including same CR3/context with changed quartet and epochMAX. Host bank import of a changed quartet is a real mapping change. Numeric-only eligibility retains spec2's distinct admission policy; do not accidentally destroy every artifact on an unrelated numeric repair.

Actual source-fetch/admission A effects, operand A/D and payload aliases may invalidate current code. Use existing paged instruction-begin/finish and restart bounds to complete the reached instruction before refetching a changed successor; no separate new observer is implied. After a successful control writer, missing/NX/unbacked successor fetch observes committed controls/quartet and retirement; repair does not reload/replay the writer. Next-instruction budget/stop gates still precede successor fetch, so a last-budget writer exposes that later fetch fault only on a work-admitted resume. Failed loads publish no control generation, while previously permitted fetch/A effects remain. Preserve TF/RF, operand debug, SS-deferred history, IRQ/NMI and budget/stop ordering at the completed boundary.

## literal acceptance packets and falsifiers

Addresses, entry words and error codes below are hexadecimal. Inputs include guarded sparse backings; every other projection is seeded distinctly and checked. Table-only unit outputs must be followed by shared public generated-Wasm consumers.

| packet                                                                                                                           | independently calculated result                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| non-PAE linear12345678, CR3raw1018, PDE[1120]=2007, PTE[2d14]=9a007                                                              | PA9a678; reached read updates entries2027/9a027; actual write leaf9a067. Only four PTE bytes need physical R/W; adjacent guards remain unchanged.                                                  |
| same path, leaf9a005                                                                                                             | user write #PF07; supervisor WP1 #PF03; supervisor WP0 writes and sets D. No denied payload/D update.                                                                                              |
| upper PDE2003, lower PTEfffffffe(P0)                                                                                             | user read #PF04 rather than upper protection05/RSVD0d; upperA remains2023, absent leaf unchanged.                                                                                                  |
| PSE-36 linear81234567, PDE[1810]=00557087                                                                                        | PSE1 gives PAab00634567 including PAT; bit21 change00757087 gives user-read reserved #PF0d.                                                                                                        |
| same ordinary PDE2087 under PSE0/1                                                                                               | PSE0 uses table2000 despite PS1; PSE1 interprets the PSE-36 large leaf and gives PA100345678 for linear12345678.                                                                                   |
| PAE linearc1234567, captured q3=0001000000003001, PDE[0001000000003048]=0002000000004007, PTE[00020000000041a0]=000300000009a007 | PA000300000009a567; only live PDE/PTE get A/D. Captured R/W/U/S zero does not deny user access; PDPT RAM may be read-only or absent after import.                                                  |
| PAE linear41234567, q1=3001, PDE[3048]=000a000000201087                                                                          | 2MiB leaf gives PA000a000000234567 with PSE0 too. Setbit13→user-read #PF0d. NX63/NXE1 denies user fetch with #PF15 but allows data read; NXE0 gives reserved #PF0d and I-D0.                       |
| PDPTE values3003,3021,0010000000003001,8000000000003001                                                                          | each present load selects writer #GP0, preserving old bank/quartet;3001/3019/3e01 are valid. P0 fffffffffffffefe imports/loads under selected policy and later selected quadrant read gives #PF04. |
| guest CR3 raw1fff in non-PAE;101f/103f/ffffffff in PAE                                                                           | stored normalized1018;1000/1020/ffffffe0 respectively. Restore retained high/low ignored raw host bits without changing effective root or reading PDPT.                                            |
| invalid present slot0 plus private slot3 hole                                                                                    | first attempt is pdpte-load private refusal atslot3/width8 with old bank/quartet/generation; after backing repair, writer #GP0 atvalidation. No CR2/#PF or partial new latch.                      |

Further mandatory stories:

1. Edit PDPT through a writable alias after latching A: ordinary access/INVLPG still uses A; same-value MOV CR3 loads B. A PSE toggle also loads B, whereas unchanged PSE, WP, numeric-only bits and INVLPG do not. Poison only an unused fourth quadrant to catch lazy one-slot validation. Restore a detached quartet after removing PDPT RAM.
2. Primed and pending owners across quartet A→B→A, same root/context, source/backing incarnation changes, permission-only PDE/PTE edits and epochMAX. PDPT-only edits are not false live dependencies, while a separate code alias there still invalidates normally.
3. Protected32 CPL3 data #PF with error04, CS1b/SS23/ESP8000 and TSS kernelSS10/ESP9000: the six-dword frame begins8fe8 with error04, savedIP1000 at8fec, CS1b at8ff0, savedFLAGS10002 at8ff4, oldESP8000 at8ff8 and SS23 at8ffc. Guest repair, error-slot removal and IRETD retry one source. Include protected16 gates and the existing VM86 ten-dword path separately.
4. Independent upper/lower permission, reserved/nonpresent, NXE/WP/user/supervisor/fetch combinations, first failing split byte, A-refusal versus D-refusal, prepared alias/RMW/frame effects, exact legacy2^32 span refusal, high noncanonical physical backing and sparse large-page holes. Include suppressed x87 stores and selected numeric-disable priority before operands.
5. Constructor/method wrong-model and field-presence failures, tuple getter/reentry/disposal, historical high-canonical #PF restore with legacy current bank, control-load diagnostic exclusivity and no fabricated linear address. A future PG0 constructor restore inherits these raw/source distinctions in spec4.
6. Cold source required-fetch faults and valid control-load instructions at exhausted compilation quota retain the existing probe-versus-execution boundary: a probe may identify reached fetch/legality failure but cannot execute an unretired MOV CR3 or load its quartet to avoid compilation. Resource/stop/budget refusal performs no PDPT load. Control-writer completion survives later target-fetch failure.

One executable protected32 repair packet uses source1000=`890b` (MOV[EBX],ECX), EBX6000/ECX11223344/CPL3/CS1b/SS23/ESPc000/FLAGS202. With root PDE2007 and data PTE[2018]=a005, the user write selects #PF07/CR26000 and A produces a025. The32-bit IDT14 gate enters kernelCS8/SS10/ESP9000; frame words at8fe8 are `[7,1000,1b,10202,c000,23]`. Map linearA000 to physical table2000 with supervisor PTE[2028]=2003. Handler bytes `0f20d0 830d18a0000002 0f013d00600000 83c404 cf` read CR2, OR the aliased data PTE's RW bit, INVLPG6000, remove error4 bytes and IRETD. The retried store writes11223344 to PAa000 and produces PTEa067, RIP1002/ESPc000/FLAGS202/CPL3, six total retired instructions and one delivery attempt. GDT/IDT/TSS and kernel stack are supervisor mappings despite the original user source. Split private frame/handler-fetch failures without replaying the accepted frame.

Mutations must kill width8-for-all entries/dependencies, PS-always-large, missing PSE-36 high bits/PAT distinction, PDPTE live reread/A/RW aggregation, missing unused-slot validation, partial capture publication, stale quartet proof, wrong root32-byte alignment, lost raw CR3/CR2 retention, I-D set for non-PAE/NXE0, early upper-permission exit, stale-word D OR, fabricated linear control-load fault and replayed completed writer. Use unchanged semantic assertions at the intended native/public consumer; a compile crash or empty filter is not a kill. Restore exact source/build artifacts and clean controls.

## implementation and performance gates

Implement logical slices: (1) physical envelope/raw bank/tuple import and diagnostic union; (2) width-aware memory/prepared/dependency authority; (3) PDPT load triggers and atomic writer publication; (4) both walk formats and complete implicit/event consumers; (5) currentness, handler/repair and async-boundary packets. Keep x86 meaning with control/walk/event owners; host adapts and manages lifecycle. Preserve old layout offsets/reason IDs and generated entry ABI; the bounded quartet adds no unbounded registry or per-run serialized bank.

```sh
cargo test --locked
npm run build
npm test
npm run test:browser
npm run check
```

Run native format/control/prepared/owner tests plus shared actual-Wasm public scenarios in Node and Chrome. Freeze predecessor source/core/host/environment and pair inherited linear/IA32e/numeric/debug/warm-context workloads with identical bytes/work/observations, balanced/reversed and A/A controls. Keep default body/import/helper/native-entry work; no new legacy table reads/latches or generic per-byte mode observer belongs on inactive paths. Existing paged boundary checks may already supply required currentness and must not be counted as a newly proven bug fix.

Characterize new4KiB/large-page walks, reached A and actual D phases, all-four latches, same-root reload/PSE toggles, private refusals, fault/handler repair, code/table aliases and short resumes separately. Measure requested/read/updated dependency bytes and physical access counts. Semantic4KiB walks visit legacy2×4-byte or PAE2×8-byte live entries after capture; large leaves visit1×4 or1×8. Report actual A/D current-word rereads, fetch-coherence peeks and source-fetch walks separately; a triggered quartet load captures4×8 bytes. Include warm A/D1 tables backed read-only to catch needless write probes. Record compilation/cache/proof/transport sizes, first/warm costs and invalidation fanout. Use per access/writer/run or completed repair denominators; faults have zero retirement and no old executable baseline. Record actual measurements/limits in this directory's verification document, without application/boot claims. README is outside scope.

## primary source decisions

- [Intel SDM093 volume3A](https://cdrdv2-public.intel.com/929359/253668-093-sdm-vol-3a.pdf), §2.5; §§5.1,5.3–5.8,5.10; tables5-3–5-11; especially §5.4.1: raw control retention, formats, PSE-36, quartet loading, reserved/present checks, A/D and fault behavior.
- [Intel volume2B](https://cdrdv2-public.intel.com/929354/253667-093-sdm-vol-2b.pdf), MOV control-register pp4-32–34; [instruction-reference collection](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html), INVLPG volume2A pp3-485–486 and WRMSR volume2D; [mode/address contract](../mode-context-and-decoding/spec.md) retains legacy segment/start/span policy.
- [Software/processor events](../software-events-and-iret/spec.md), [delivery](../event-delivery-and-returns/spec.md), [debug](../hardware-breakpoints-and-debug/spec.md), numeric spec2 and the implementation anchors above supply existing instruction-specific boundaries.

P0 PDPTE garbage acceptance, complete private32-byte capture before validation, guest ignored-bit normalization, raw physical checkpoint bits and deterministic walk/A ordering are explicit selected policies. These are implementation requirements and source-review conclusions, not completed runtime/mutation/performance evidence.
