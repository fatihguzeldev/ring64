# architecture

organize source around behavior owners, then separate responsibilities inside each owner. a component has a named responsibility, a small interface and private implementation. source folders group related behavior; specs describe contracts that can cross several components.

let module and directory boundaries follow the responsibilities and consumers that emerge in the code. keep related behavior together; separate responsibilities that need to change independently. a component does not need a fixed number of files or a separate crate or package.

## dependency direction

- architectural state and instruction models do not depend on wasm encoding, browser modules or artifact caches.
- decode consumes a bounded byte source and returns instruction records or diagnostics. the caller supplies access to the code image; the decoder does not acquire a cpu instance or mutate guest memory.
- discovery consumes code, context, decoded forms and translation limits. imported registers, flags, operand data and a run's stop/budget do not become discovery assumptions.
- wasm lowering consumes admitted units, instruction/effect definitions and memory access contracts. it does not independently decode bytes or establish another mapping policy.
- embedding converts representations and delegates to the owning components. it does not implement instruction semantics or cache policy.
- the host coordinates rust and browser capabilities. it does not decode guest instructions, calculate guest flags or reinterpret guest access failures.

cross-component calls use the owner's explicit entry points and owned types. keep internal worklists, opcode tables, cache indexes and buffer pointers private. consumers should not reach through another component to mutate its storage.

## inside a component

split at responsibilities that can be named and changed independently. inside decode, prefix handling, opcode refinement and operand/address parsing are different responsibilities. inside wasm lowering, integer flags, memory operations, control transfers and entry/exit publication have different contracts. inside host execution, run coordination and artifact ownership remain separate even though both participate in one cpu instance.

keep a local type or helper with the behavior it serves. put a shared contract with its meaning's owner: decoded operand types with instructions, access failures with memory access, artifact entry metadata with translation units. importing a small contract should not expose an owner's entire implementation.

architectural meaning and wasm realization are separate responsibilities. keep instruction/effect definitions and the affected lowering aligned.

## architectural state and representation

keep architectural state, generated-code state and transport layout distinct:

- x86 state defines what a register view or flag means.
- wasm lowering chooses locals, temporaries and publication code while preserving that meaning.
- embedding layout defines how canonical values and exits cross the rust/wasm/typescript boundary.

maintain one authoritative transport layout, consumed through descriptors, accessors or generated bindings. do not maintain independent rust and typescript offset lists. a layout change should not redefine register behavior; a browser instance's lifecycle should not become a field in architectural state.

## memory and translation ownership

memory owns the access policy used by runtime helpers and generated paths. generated accesses can call its wasm helpers or lower a checked access description. an inline path must preserve the same span checks, permissions, failure priority and effects; it is not another authority for those rules. source boundaries do not require a host call or a runtime abstraction at every guest instruction.

host-supplied span lookup is not an x86 mmu. architectural paging or protection work must define its guest rules and state explicitly; physical backing and browser storage remain memory responsibilities. do not hide a guest page walker or another permission model in typescript glue.

the rust translator owns discovered units and generated module bytes/metadata. the typescript translation owner owns their browser compilation, installation and lifetime. entry mappings remain attached to their artifact owner, including on eviction and replacement; do not add a second competing browser cache inside decode or emission.

## changes and verification

a change should have a recognizable owner and affected consumers:

- adding an addressing form changes instruction/decode contracts and address lowering, with memory access checks at the existing owner.
- changing flag lowering changes the integer backend and its architectural assertions; host transport does not calculate replacement flags.
- changing discovery limits changes unit admission, not instruction meaning.
- changing eviction changes browser artifact ownership, not x86 state or decode.

keep unit tests beside the behavior they verify. share literal packets where multiple checks use the same case, and test the complete host/core/generated-wasm path across its boundaries. independent expected results must not be calculated by the same decoder or lowering under test.

preserve dependency directions when moving code, and move the relevant tests and consumers with it. separate crates or packages when a concrete dependency or build boundary calls for them.
