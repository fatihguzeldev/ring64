mod bits;
mod boundary;
mod control;
mod counts;
mod data;
mod debug;
mod entry_lookup;
mod exchange;
mod far;
mod float;
mod integer;
mod integer_memory;
mod memory;
mod mmx;
mod multiply_divide;
mod numeric_state;
mod paging;
mod protection;
mod software_events;
mod stack;
mod state;
mod streaming;
mod strings;
mod system_flags;
mod unary;
mod vector;
mod x87;

use std::collections::BTreeMap;
use wasm_encoder::{
    BlockType, CodeSection, EntityType, ExportKind, ExportSection, Function, FunctionSection,
    ImportSection, Instruction as Op, MemoryType, Module, TypeSection, ValType,
};

use super::unit::Unit;
use crate::embedding::layout::DISPATCH;
use crate::x86::context::{ExecutionContext, Segment};
use crate::x86::instruction::{Location, MemoryAluOperands, Operation, Repeat};

const ENTRY_INDEX: u32 = 4;
const GPR: u32 = 5;
const FLAGS: u32 = 21;
const RIP: u32 = 22;
const REMAINING: u32 = 23;
const ENTRY: u32 = 24;
const REASON: u32 = 25;
const LHS: u32 = 26;
const RHS: u32 = 27;
const RESULT: u32 = 28;
const ADDRESS: u32 = 29;
const VALUE: u32 = 30;
const STORE_STATUS: u32 = 31;
const DIRECTION: u32 = 32;
const SYSTEM: u32 = 33;
const SHADOW: u32 = 34;
const REPEAT_REMAINING: u32 = 35;
const ENTRY_FLAGS: u32 = 36;

struct Emitter {
    paged: bool,
    body: Function,
    entries: BTreeMap<u64, u32>,
    current_index: u32,
    entry_lookup: Option<u32>,
    multiply_high: Option<u32>,
    divide: Option<u32>,
    divide_failed: Option<u32>,
    stores: bool,
    has_repeat: bool,
    restore_string_flags: bool,
    context: ExecutionContext,
    segment: Segment,
    access_reason: Option<u32>,
    target_check: Option<u32>,
    vector_registers: [Option<u32>; 16],
    vector_written: u16,
    vector_temporaries: Option<[u32; 3]>,
    vector_load: Option<u32>,
    vector_store: Option<u32>,
    vector_access_reason: Option<u32>,
    float: Option<u32>,
    load_mxcsr: Option<u32>,
    store_mxcsr: Option<u32>,
    x87: Option<u32>,
    mmx: Option<u32>,
    numeric_image: Option<u32>,
    masked_store: Option<u32>,
    clflush: Option<u32>,
    protection: Option<u32>,
    far_control: Option<u32>,
    software_event: Option<u32>,
    system_flags: Option<u32>,
    debug_step: Option<u32>,
    debug_register: Option<u32>,
    paging_control: Option<u32>,
    debug_begin: Option<u32>,
    external_step: Option<u32>,
    halt: Option<u32>,
    observed: bool,
    mutable_controls: bool,
    publish_shadow: bool,
    sampled_tf: Option<u32>,
    incoming_shadow: Option<u32>,
    next_shadow: Option<u32>,
    boundary_result: Option<u32>,
    current_pc: u64,
    current_operation: Operation,
}

impl Emitter {
    fn op(&mut self, instruction: Op<'_>) -> &mut Self {
        self.body.instruction(&instruction);
        self
    }
}

#[cfg(test)]
pub(crate) fn emit(unit: &Unit) -> Vec<u8> {
    emit_observed(unit, false)
}

#[cfg(test)]
pub(crate) fn emit_observed(unit: &Unit, observed: bool) -> Vec<u8> {
    emit_profile(unit, observed, false)
}

pub(crate) fn emit_profile(unit: &Unit, observed: bool, paged: bool) -> Vec<u8> {
    let observed = observed || paged;
    let vector_banks = vector::Banks::for_unit(unit);
    let has_repeat = unit
        .instructions
        .iter()
        .any(|i| matches!(i.operation, Operation::String { repeat, .. } if repeat != Repeat::None));
    let dynamic_targets = unit.instructions.iter().any(|i| {
        matches!(
            i.operation,
            Operation::Return { .. }
                | Operation::JumpRegister { .. }
                | Operation::JumpMemory { .. }
                | Operation::Call {
                    target: crate::x86::instruction::Operand::Register(_)
                        | crate::x86::instruction::Operand::Memory(_),
                    ..
                }
        )
    });
    let segmented = !unit.context.is_long64();
    let target_type = dynamic_targets || segmented;
    let mut types = TypeSection::new();
    types.ty().function(
        if segmented {
            vec![ValType::I64, ValType::I32, ValType::I32]
        } else {
            vec![ValType::I64, ValType::I32]
        },
        [ValType::I64],
    );
    types.ty().function(
        if segmented {
            vec![ValType::I64, ValType::I32, ValType::I64, ValType::I32]
        } else {
            vec![ValType::I64, ValType::I32, ValType::I64]
        },
        [ValType::I32],
    );
    types.ty().function([], [ValType::I32]);
    types.ty().function(
        [
            ValType::I32,
            ValType::I64,
            ValType::I64,
            ValType::I32,
            ValType::I32,
        ],
        [ValType::I32],
    );
    if target_type {
        types.ty().function([ValType::I64], [ValType::I32]);
    }
    let mut next_type = 4 + u32::from(target_type);
    let wide_product = unit.instructions.iter().any(|i| {
        matches!(
            i.operation,
            Operation::Multiply {
                width: crate::x86::instruction::Width::W64,
                ..
            } | Operation::Imul {
                width: crate::x86::instruction::Width::W64,
                ..
            }
        )
    });
    let wide_divide = unit.instructions.iter().any(|i| {
        matches!(
            i.operation,
            Operation::Divide {
                width: crate::x86::instruction::Width::W64,
                ..
            }
        )
    });
    let multiply_type = wide_product.then(|| {
        let index = next_type;
        types
            .ty()
            .function([ValType::I64, ValType::I64, ValType::I32], [ValType::I64]);
        next_type += 1;
        index
    });
    let divide_type = wide_divide.then(|| {
        let index = next_type;
        types.ty().function(
            [ValType::I64, ValType::I64, ValType::I64, ValType::I32],
            [ValType::I64],
        );
        next_type += 1;
        index
    });
    let vector_load_type = vector_banks.loads.then(|| {
        let index = next_type;
        types.ty().function(
            [ValType::I64, ValType::I32, ValType::I32, ValType::I32],
            [ValType::I32],
        );
        next_type += 1;
        index
    });
    let vector_store_type = vector_banks.stores.then(|| {
        let index = next_type;
        types.ty().function(
            [
                ValType::I64,
                ValType::I32,
                ValType::I32,
                ValType::I32,
                ValType::I32,
            ],
            [ValType::I32],
        );
        next_type += 1;
        index
    });
    let has_float = unit
        .instructions
        .iter()
        .any(|i| matches!(i.operation, Operation::Float(_)));
    let load_mxcsr_used = unit
        .instructions
        .iter()
        .any(|i| matches!(i.operation, Operation::Mxcsr { store: false, .. }));
    let store_mxcsr_used = unit
        .instructions
        .iter()
        .any(|i| matches!(i.operation, Operation::Mxcsr { store: true, .. }));
    let has_x87 = unit
        .instructions
        .iter()
        .any(|i| matches!(i.operation, Operation::X87(_)));
    let has_mmx = unit
        .instructions
        .iter()
        .any(|i| matches!(i.operation, Operation::Mmx { op, .. } if !mmx::direct(op)));
    let has_mmx_vector = unit
        .instructions
        .iter()
        .any(|i| matches!(i.operation, Operation::Mmx { op, .. } if mmx::vector_temps(op)));
    let has_numeric_image = unit
        .instructions
        .iter()
        .any(|i| matches!(i.operation, Operation::NumericImage { .. }));
    let has_masked_store = unit
        .instructions
        .iter()
        .any(|i| matches!(i.operation, Operation::MaskedStore { .. }));
    let has_clflush = unit
        .instructions
        .iter()
        .any(|i| matches!(i.operation, Operation::Clflush { .. }));
    let has_protection = unit.instructions.iter().any(|i| {
        matches!(
            i.operation,
            Operation::Protection(_) | Operation::PopSs { .. }
        )
    });
    let has_far = unit
        .instructions
        .iter()
        .any(|i| matches!(i.operation, Operation::Far(_)));
    let has_debug_register = unit
        .instructions
        .iter()
        .any(|i| matches!(i.operation, Operation::DebugRegister { .. }));
    let has_paging = unit
        .instructions
        .iter()
        .any(|i| matches!(i.operation, Operation::Paging(_)));
    let has_system_flags = unit
        .instructions
        .iter()
        .any(|i| matches!(i.operation, Operation::SystemFlags(_)));
    let has_software_events = unit
        .instructions
        .iter()
        .any(|i| matches!(i.operation, Operation::SoftwareEvent(_)));
    let has_halt = unit
        .instructions
        .iter()
        .any(|i| matches!(i.operation, Operation::Halt));
    let has_boundary = observed
        || has_system_flags
        || has_software_events
        || has_halt
        || unit
            .instructions
            .iter()
            .any(|i| boundary::ss_producer(i.operation));
    let float_type = has_float.then(|| {
        let index = next_type;
        types.ty().function(
            [
                ValType::I32,
                ValType::I64,
                ValType::I64,
                ValType::I64,
                ValType::I64,
            ],
            [ValType::I32],
        );
        next_type += 1;
        index
    });
    let mxcsr_type = (load_mxcsr_used || store_mxcsr_used).then(|| {
        let index = next_type;
        types
            .ty()
            .function([ValType::I64, ValType::I32], [ValType::I32]);
        next_type += 1;
        index
    });
    let x87_type = has_x87.then(|| {
        let index = next_type;
        types.ty().function(
            [
                ValType::I32,
                ValType::I64,
                ValType::I32,
                ValType::I64,
                ValType::I64,
                ValType::I64,
            ],
            [ValType::I32],
        );
        next_type += 1;
        index
    });
    let masked_store_type = has_masked_store.then(|| {
        let index = next_type;
        types.ty().function(
            [
                ValType::I64,
                ValType::I32,
                ValType::I32,
                ValType::I32,
                ValType::I32,
            ],
            [ValType::I32],
        );
        next_type += 1;
        index
    });
    let clflush_type = has_clflush.then(|| {
        let index = next_type;
        types
            .ty()
            .function([ValType::I64, ValType::I32], [ValType::I32]);
        next_type += 1;
        index
    });
    let protection_type = has_protection.then(|| {
        let index = next_type;
        types.ty().function(
            [ValType::I32, ValType::I64, ValType::I64, ValType::I32],
            [ValType::I32],
        );
        next_type += 1;
        index
    });
    let far_type = has_far.then(|| {
        let index = next_type;
        types.ty().function(
            [
                ValType::I32,
                ValType::I64,
                ValType::I32,
                ValType::I64,
                ValType::I64,
                ValType::I32,
            ],
            [ValType::I32],
        );
        next_type += 1;
        index
    });
    let software_event_type = has_software_events.then(|| {
        let index = next_type;
        types.ty().function(
            [ValType::I32, ValType::I64, ValType::I64, ValType::I64],
            [ValType::I32],
        );
        next_type += 1;
        index
    });
    let system_flags_type = has_system_flags.then(|| {
        let index = next_type;
        types
            .ty()
            .function([ValType::I32, ValType::I64, ValType::I64], [ValType::I32]);
        next_type += 1;
        index
    });
    let debug_register_type = has_debug_register.then(|| {
        let index = next_type;
        types.ty().function(
            [ValType::I32, ValType::I64, ValType::I64, ValType::I64],
            [ValType::I32],
        );
        next_type += 1;
        index
    });
    let paging_type = has_paging.then(|| {
        let index = next_type;
        types.ty().function(
            [
                ValType::I32,
                ValType::I32,
                ValType::I64,
                ValType::I64,
                ValType::I64,
            ],
            [ValType::I32],
        );
        next_type += 1;
        index
    });
    let debug_begin_type = observed.then(|| {
        let index = next_type;
        types
            .ty()
            .function([ValType::I64, ValType::I64, ValType::I32], [ValType::I32]);
        next_type += 1;
        index
    });
    let debug_type = observed.then(|| {
        let index = next_type;
        types.ty().function(
            [
                ValType::I64,
                ValType::I64,
                ValType::I32,
                ValType::I64,
                ValType::I32,
            ],
            [ValType::I32],
        );
        next_type += 1;
        index
    });
    let external_step_type = has_boundary.then(|| {
        let index = next_type;
        types
            .ty()
            .function([ValType::I64, ValType::I64, ValType::I32], [ValType::I32]);
        next_type += 1;
        index
    });
    let halt_type = has_halt.then(|| {
        let index = next_type;
        types.ty().function([ValType::I64], [ValType::I32]);
        next_type += 1;
        index
    });
    let numeric_state_type = (has_mmx || has_numeric_image).then(|| {
        let index = next_type;
        types
            .ty()
            .function([ValType::I32, ValType::I64, ValType::I32], [ValType::I32]);
        index
    });
    let mut imports = ImportSection::new();
    imports.import(
        "env",
        "memory",
        EntityType::Memory(MemoryType {
            minimum: 1,
            maximum: None,
            memory64: false,
            shared: false,
            page_size_log2: None,
        }),
    );
    imports.import(
        "env",
        if segmented { "segmented_load" } else { "load" },
        EntityType::Function(0),
    );
    imports.import(
        "env",
        if segmented {
            "segmented_store"
        } else {
            "store"
        },
        EntityType::Function(1),
    );
    imports.import(
        "env",
        if segmented {
            "segmented_access_failed"
        } else {
            "access_failed"
        },
        EntityType::Function(2),
    );
    let write_intent = unit.instructions.iter().any(|instruction| {
        matches!(instruction.operation,
            Operation::MemoryAlu { kind, operands: MemoryAluOperands::MemoryFirst(_), .. }
                if kind.writes_result())
            || matches!(instruction.operation,
                Operation::Bit { kind, dst:Location::Memory(_), .. } if kind.writes_result())
            || matches!(
                instruction.operation,
                Operation::Unary {
                    dst: Location::Memory(_),
                    ..
                } | Operation::Shift {
                    dst: Location::Memory(_),
                    ..
                } | Operation::DoubleShift {
                    dst: Location::Memory(_),
                    ..
                } | Operation::Exchange {
                    dst: Location::Memory(_),
                    ..
                } | Operation::Xadd {
                    dst: Location::Memory(_),
                    ..
                } | Operation::CompareExchange {
                    dst: Location::Memory(_),
                    ..
                } | Operation::CompareExchange8b { .. }
            )
    });
    if write_intent {
        imports.import(
            "env",
            if segmented {
                "segmented_load_for_write"
            } else {
                "load_for_write"
            },
            EntityType::Function(0),
        );
    }
    let mut run_index = 3 + u32::from(write_intent);
    let multiply_high = multiply_type.map(|index| {
        imports.import("env", "multiply_high", EntityType::Function(index));
        let function = run_index;
        run_index += 1;
        function
    });
    let divide = divide_type.map(|index| {
        imports.import("env", "divide", EntityType::Function(index));
        let function = run_index;
        run_index += 1;
        function
    });
    let divide_failed = wide_divide.then(|| {
        imports.import("env", "divide_failed", EntityType::Function(2));
        let function = run_index;
        run_index += 1;
        function
    });
    let access_reason = (segmented || paged).then(|| {
        imports.import("env", "access_reason", EntityType::Function(2));
        let function = run_index;
        run_index += 1;
        function
    });
    let target_check = segmented.then(|| {
        imports.import("env", "target_check", EntityType::Function(4));
        let function = run_index;
        run_index += 1;
        function
    });
    let vector_load = vector_load_type.map(|index| {
        imports.import("env", "vector_load", EntityType::Function(index));
        let function = run_index;
        run_index += 1;
        function
    });
    let vector_store = vector_store_type.map(|index| {
        imports.import("env", "vector_store", EntityType::Function(index));
        let function = run_index;
        run_index += 1;
        function
    });
    let float = float_type.map(|index| {
        imports.import("env", "float", EntityType::Function(index));
        let function = run_index;
        run_index += 1;
        function
    });
    let load_mxcsr = load_mxcsr_used.then(|| {
        imports.import(
            "env",
            "load_mxcsr",
            EntityType::Function(mxcsr_type.unwrap()),
        );
        let function = run_index;
        run_index += 1;
        function
    });
    let store_mxcsr = store_mxcsr_used.then(|| {
        imports.import(
            "env",
            "store_mxcsr",
            EntityType::Function(mxcsr_type.unwrap()),
        );
        let function = run_index;
        run_index += 1;
        function
    });
    let x87 = x87_type.map(|index| {
        imports.import("env", "x87", EntityType::Function(index));
        let function = run_index;
        run_index += 1;
        function
    });
    let mmx = has_mmx.then(|| {
        imports.import(
            "env",
            "mmx",
            EntityType::Function(numeric_state_type.unwrap()),
        );
        let function = run_index;
        run_index += 1;
        function
    });
    let numeric_image = has_numeric_image.then(|| {
        imports.import(
            "env",
            "numeric_image",
            EntityType::Function(numeric_state_type.unwrap()),
        );
        let function = run_index;
        run_index += 1;
        function
    });
    let masked_store = masked_store_type.map(|index| {
        imports.import("env", "masked_store", EntityType::Function(index));
        let function = run_index;
        run_index += 1;
        function
    });
    let clflush = clflush_type.map(|index| {
        imports.import("env", "clflush", EntityType::Function(index));
        let function = run_index;
        run_index += 1;
        function
    });
    let protection = protection_type.map(|index| {
        imports.import("env", "protection", EntityType::Function(index));
        let function = run_index;
        run_index += 1;
        function
    });
    let far_control = far_type.map(|index| {
        imports.import("env", "far_control", EntityType::Function(index));
        let function = run_index;
        run_index += 1;
        function
    });
    let software_event = software_event_type.map(|index| {
        imports.import("env", "software_event", EntityType::Function(index));
        let function = run_index;
        run_index += 1;
        function
    });
    let system_flags = system_flags_type.map(|index| {
        imports.import("env", "flags", EntityType::Function(index));
        let function = run_index;
        run_index += 1;
        function
    });
    let debug_register = debug_register_type.map(|index| {
        imports.import("env", "debug_register", EntityType::Function(index));
        let function = run_index;
        run_index += 1;
        function
    });
    let paging_control = paging_type.map(|index| {
        imports.import("env", "paging_control", EntityType::Function(index));
        let function = run_index;
        run_index += 1;
        function
    });
    let debug_begin = debug_begin_type.map(|index| {
        imports.import("env", "debug_begin", EntityType::Function(index));
        let function = run_index;
        run_index += 1;
        function
    });
    let debug_step = debug_type.map(|index| {
        imports.import("env", "debug_finish", EntityType::Function(index));
        let function = run_index;
        run_index += 1;
        function
    });
    let external_step = external_step_type.map(|index| {
        imports.import("env", "external_step", EntityType::Function(index));
        let function = run_index;
        run_index += 1;
        function
    });
    let halt = halt_type.map(|index| {
        imports.import("env", "halt", EntityType::Function(index));
        let function = run_index;
        run_index += 1;
        function
    });
    let vector_access_reason = if vector_banks.loads || vector_banks.stores || store_mxcsr_used {
        Some(access_reason.unwrap_or_else(|| {
            imports.import("env", "access_reason", EntityType::Function(2));
            let function = run_index;
            run_index += 1;
            function
        }))
    } else {
        None
    };
    let mut functions = FunctionSection::new();
    functions.function(3);
    if dynamic_targets {
        functions.function(4);
    }
    let mut exports = ExportSection::new();
    exports.export("run", ExportKind::Func, run_index);
    let mut locals = vec![
        (19, ValType::I64),
        (2, ValType::I32),
        (5, ValType::I64),
        (1, ValType::I32),
        (2, ValType::I64),
        (1, ValType::I32),
    ];
    if has_repeat {
        locals.push((2, ValType::I64));
    }
    let mut vector_registers = [None; 16];
    let mut next_local = 35 + 2 * u32::from(has_repeat);
    let boundary_locals = observed.then(|| {
        let result = [next_local, next_local + 1, next_local + 2, next_local + 3];
        locals.push((4, ValType::I32));
        next_local += 4;
        result
    });
    for (bank, local) in vector_registers.iter_mut().enumerate() {
        if vector_banks.used & (1 << bank) != 0 {
            *local = Some(next_local);
            next_local += 1;
        }
    }
    let vector_temporaries = (vector_banks.used != 0 || has_float || has_mmx_vector).then(|| {
        locals.push((vector_banks.used.count_ones() + 3, ValType::V128));
        [next_local, next_local + 1, next_local + 2]
    });
    let mut emitter = Emitter {
        paged,
        current_index: 0,
        entry_lookup: dynamic_targets.then_some(run_index + 1),
        multiply_high,
        divide,
        divide_failed,
        stores: false,
        has_repeat,
        restore_string_flags: false,
        context: unit.context.clone(),
        segment: Segment::Ds,
        access_reason,
        target_check,
        vector_registers,
        vector_written: vector_banks.written,
        vector_temporaries,
        vector_load,
        vector_store,
        vector_access_reason,
        float,
        load_mxcsr,
        store_mxcsr,
        x87,
        mmx,
        numeric_image,
        masked_store,
        clflush,
        protection,
        far_control,
        software_event,
        system_flags,
        debug_step,
        debug_register,
        paging_control,
        debug_begin,
        external_step,
        halt,
        observed,
        mutable_controls: has_system_flags || has_software_events,
        publish_shadow: observed
            || has_system_flags
            || has_software_events
            || unit
                .instructions
                .iter()
                .any(|i| boundary::ss_producer(i.operation)),
        sampled_tf: boundary_locals.map(|l| l[0]),
        incoming_shadow: boundary_locals.map(|l| l[1]),
        next_shadow: boundary_locals.map(|l| l[2]),
        boundary_result: boundary_locals.map(|l| l[3]),
        current_pc: 0,
        current_operation: Operation::Nop,
        body: Function::new(locals),
        entries: unit
            .instructions
            .iter()
            .enumerate()
            .map(|(index, i)| (i.pc, index as u32))
            .collect(),
    };
    emitter.load_state();
    emitter.op(Op::Block(BlockType::Empty));
    emitter.gates(0);
    emitter.profile_guard(0);
    let count = unit.instructions.len() as u32;
    // The artifact owner supplies the ordinal from Artifact::entries.
    emitter
        .op(Op::LocalGet(ENTRY_INDEX))
        .op(Op::LocalSet(ENTRY));
    emitter
        .op(Op::Loop(BlockType::Empty))
        .op(Op::Block(BlockType::Empty));
    for _ in &unit.instructions {
        emitter.op(Op::Block(BlockType::Empty));
    }
    emitter
        .op(Op::LocalGet(ENTRY))
        .op(Op::BrTable((0..count).collect::<Vec<_>>().into(), count));
    for (index, instruction) in unit.instructions.iter().enumerate() {
        emitter.op(Op::End);
        emitter.current_index = index as u32;
        emitter.current_pc = instruction.pc;
        emitter.current_operation = instruction.operation;
        emitter.stores = false;
        let loop_depth = count - index as u32;
        let exit_depth = loop_depth + 1;
        emitter
            .op(Op::I64Const(instruction.pc as i64))
            .op(Op::LocalSet(RIP));
        emitter.gates(exit_depth);
        emitter.begin(instruction.operation, exit_depth);
        match instruction.operation {
            Operation::Paging(operation) => {
                emitter.paging_control(operation, instruction.next_pc, exit_depth);
                continue;
            }
            Operation::Halt => {
                emitter.halt(instruction.next_pc, exit_depth);
                continue;
            }
            Operation::SoftwareEvent(operation) => {
                if emitter.software_event(operation, instruction.next_pc, exit_depth) {
                    continue;
                }
            }
            Operation::DebugRegister {
                register,
                gpr,
                write,
                width,
            } => {
                emitter.debug_register(
                    register,
                    gpr,
                    write,
                    width,
                    instruction.next_pc,
                    exit_depth,
                );
                continue;
            }
            Operation::SystemFlags(operation) => emitter.system_flags(operation, exit_depth),
            Operation::PopSs { width } => emitter.pop_ss(width, exit_depth),
            Operation::MaskedStore {
                data,
                mask,
                mmx,
                address,
            } => emitter.masked_store(data, mask, mmx, address, instruction.next_pc, exit_depth),
            Operation::Far(far) => {
                emitter.far_control(far, instruction.next_pc, exit_depth);
                continue;
            }
            Operation::Protection(operation) => {
                emitter.protection(operation, instruction.next_pc, exit_depth)
            }
            Operation::Clflush { address } => {
                emitter.clflush(address, instruction.next_pc, exit_depth)
            }
            Operation::Nop => {}
            Operation::Mmx { op, address } => {
                emitter.mmx(op, address, instruction.next_pc, exit_depth)
            }
            Operation::NumericImage { op, address } => {
                emitter.numeric_image(op, address, instruction.next_pc, exit_depth)
            }
            Operation::X87(x87) => {
                emitter.x87(x87, instruction.pc, instruction.next_pc, exit_depth)
            }
            Operation::Float(float) => emitter.float(float, instruction.next_pc, exit_depth),
            Operation::Mxcsr { address, store } => {
                emitter.mxcsr(address, store, instruction.next_pc, exit_depth)
            }
            Operation::Vector(vector) => emitter.vector(vector, instruction.next_pc, exit_depth),
            Operation::Exchange { dst, src, width } => {
                emitter.exchange(dst, src, width, instruction.next_pc, exit_depth)
            }
            Operation::Xadd { dst, src, width } => {
                emitter.xadd(dst, src, width, instruction.next_pc, exit_depth)
            }
            Operation::CompareExchange { dst, src, width } => {
                emitter.compare_exchange(dst, src, width, instruction.next_pc, exit_depth)
            }
            Operation::CompareExchange8b { address } => {
                emitter.compare_exchange8b(address, instruction.next_pc, exit_depth)
            }
            Operation::Direction { set } => emitter.direction(set),
            Operation::String {
                kind,
                width,
                address_width,
                source_segment,
                repeat,
            } => {
                emitter.string(
                    kind,
                    (width, address_width),
                    source_segment,
                    repeat,
                    exit_depth,
                );
            }
            Operation::Mov { dst, src, width } => {
                emitter.data_operand(src, width);
                emitter.write_register(dst, width);
            }
            Operation::Alu {
                kind,
                dst,
                src,
                width,
            } => emitter.integer(kind, dst, src, width),
            Operation::MemoryAlu {
                kind,
                address,
                operands,
                width,
            } => emitter.memory_integer(
                kind,
                address,
                operands,
                width,
                instruction.next_pc,
                exit_depth,
            ),
            Operation::Load {
                dst,
                address,
                width,
            } => emitter.load(dst, address, width, instruction.next_pc, exit_depth),
            Operation::Store {
                src,
                address,
                width,
            } => emitter.store(src, address, width, instruction.next_pc, exit_depth),
            Operation::Lea {
                dst,
                address,
                width,
            } => emitter.lea(dst, address, width, instruction.next_pc),
            Operation::Extend {
                dst,
                src,
                source_width,
                width,
                signed,
            } => emitter.extend(
                dst,
                src,
                (source_width, width),
                signed,
                instruction.next_pc,
                exit_depth,
            ),
            Operation::SignHigh { width } => emitter.sign_high(width),
            Operation::Unary { kind, dst, width } => {
                emitter.unary(kind, dst, width, instruction.next_pc, exit_depth)
            }
            Operation::Multiply { signed, src, width } => {
                emitter.multiply(signed, src, width, instruction.next_pc, exit_depth)
            }
            Operation::Imul {
                dst,
                src,
                immediate,
                width,
            } => emitter.imul(dst, src, immediate, width, instruction.next_pc, exit_depth),
            Operation::Divide { signed, src, width } => {
                emitter.divide(signed, src, width, instruction.next_pc, exit_depth)
            }
            Operation::Shift {
                kind,
                dst,
                count,
                width,
            } => emitter.shift(kind, dst, count, width, instruction.next_pc, exit_depth),
            Operation::DoubleShift {
                kind,
                dst,
                src,
                count,
                width,
            } => emitter.double_shift(
                kind,
                dst,
                (src, count),
                width,
                instruction.next_pc,
                exit_depth,
            ),
            Operation::Carry { kind } => emitter.carry(kind),
            Operation::Lahf => emitter.lahf(),
            Operation::Sahf => emitter.sahf(),
            Operation::Bit {
                kind,
                dst,
                index,
                width,
            } => emitter.bit(kind, dst, index, width, instruction.next_pc, exit_depth),
            Operation::Scan {
                reverse,
                dst,
                src,
                width,
            } => emitter.scan(reverse, dst, src, width, instruction.next_pc, exit_depth),
            Operation::Bswap { dst, width } => emitter.bswap(dst, width),
            Operation::Setcc { dst, condition } => {
                emitter.setcc(dst, condition, instruction.next_pc, exit_depth);
            }
            Operation::Cmov {
                dst,
                src,
                width,
                condition,
            } => emitter.cmov(dst, src, width, condition, instruction.next_pc, exit_depth),
            Operation::Push { src, width } => {
                emitter.push(src, width, instruction.next_pc, exit_depth)
            }
            Operation::Pop { dst, width } => emitter.pop(dst, width, exit_depth),
            Operation::PopMemory { address, width } => {
                emitter.pop_memory(address, width, instruction.next_pc, exit_depth)
            }
            Operation::Leave { width } => emitter.leave(width, exit_depth),
            Operation::Call { target, width } => {
                emitter.call(target, width, instruction.next_pc, loop_depth, exit_depth);
                continue;
            }
            Operation::JumpRegister { target, width } => {
                emitter.jump_register(target, width, exit_depth);
                continue;
            }
            Operation::JumpMemory { address, width } => {
                emitter.jump_memory(address, width, instruction.next_pc, exit_depth);
                continue;
            }
            Operation::Return { cleanup, width } => {
                emitter.return_stack(cleanup, width, exit_depth);
                continue;
            }
            Operation::Jump { target } => {
                emitter.target(target, loop_depth, exit_depth);
                continue;
            }
            Operation::Jcc { condition, target } => {
                emitter.condition(condition);
                emitter.op(Op::If(BlockType::Empty));
                emitter.target(target, loop_depth + 1, exit_depth + 1);
                emitter.op(Op::End);
            }
            Operation::CountBranch {
                condition,
                count_width,
                target,
            } => {
                emitter.count_branch(condition, count_width, target, loop_depth, exit_depth);
            }
        }
        emitter.commit(instruction.next_pc);
        emitter.route(instruction.next_pc, loop_depth, exit_depth);
    }
    emitter.op(Op::End);
    emitter.exit(DISPATCH, 1);
    emitter.op(Op::End).op(Op::End);
    emitter.publish_state();
    emitter.op(Op::LocalGet(REASON)).op(Op::End);
    let mut code = CodeSection::new();
    code.function(&emitter.body);
    if dynamic_targets {
        code.function(&entry_lookup::emit(&emitter.entries));
    }
    let mut module = Module::new();
    module
        .section(&types)
        .section(&imports)
        .section(&functions)
        .section(&exports)
        .section(&code);
    module.finish()
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;
