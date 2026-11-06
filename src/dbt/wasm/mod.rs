mod bits;
mod control;
mod counts;
mod data;
mod entry_lookup;
mod integer;
mod integer_memory;
mod memory;
mod stack;
mod state;
mod unary;

use std::collections::BTreeMap;
use wasm_encoder::{
    BlockType, CodeSection, EntityType, ExportKind, ExportSection, Function, FunctionSection,
    ImportSection, Instruction as Op, MemoryType, Module, TypeSection, ValType,
};

use super::unit::Unit;
use crate::embedding::layout::DISPATCH;
use crate::x86::instruction::{Location, MemoryAluOperands, Operation};

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

struct Emitter {
    body: Function,
    entries: BTreeMap<u64, u32>,
    current_index: u32,
    entry_lookup: Option<u32>,
}

impl Emitter {
    fn op(&mut self, instruction: Op<'_>) -> &mut Self {
        self.body.instruction(&instruction);
        self
    }
}

pub(crate) fn emit(unit: &Unit) -> Vec<u8> {
    let dynamic_targets = unit.instructions.iter().any(|i| {
        matches!(
            i.operation,
            Operation::Return { .. }
                | Operation::JumpRegister { .. }
                | Operation::Call {
                    target: crate::x86::instruction::Operand::Register(_)
                }
        )
    });
    let mut types = TypeSection::new();
    types
        .ty()
        .function([ValType::I64, ValType::I32], [ValType::I64]);
    types
        .ty()
        .function([ValType::I64, ValType::I32, ValType::I64], [ValType::I32]);
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
    if dynamic_targets {
        types.ty().function([ValType::I64], [ValType::I32]);
    }
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
    imports.import("env", "load", EntityType::Function(0));
    imports.import("env", "store", EntityType::Function(1));
    imports.import("env", "access_failed", EntityType::Function(2));
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
                }
            )
    });
    if write_intent {
        imports.import("env", "load_for_write", EntityType::Function(0));
    }
    let mut functions = FunctionSection::new();
    functions.function(3);
    if dynamic_targets {
        functions.function(4);
    }
    let mut exports = ExportSection::new();
    exports.export("run", ExportKind::Func, 3 + u32::from(write_intent));
    let mut emitter = Emitter {
        current_index: 0,
        entry_lookup: dynamic_targets.then_some(4 + u32::from(write_intent)),
        body: Function::new([(19, ValType::I64), (2, ValType::I32), (5, ValType::I64)]),
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
        let loop_depth = count - index as u32;
        let exit_depth = loop_depth + 1;
        emitter
            .op(Op::I64Const(instruction.pc as i64))
            .op(Op::LocalSet(RIP));
        emitter.gates(exit_depth);
        match instruction.operation {
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
            Operation::Push { src } => emitter.push(src, exit_depth),
            Operation::Pop { dst } => emitter.pop(dst, exit_depth),
            Operation::Call { target } => {
                emitter.call(target, instruction.next_pc, loop_depth, exit_depth);
                continue;
            }
            Operation::JumpRegister { target } => {
                emitter.jump_register(target, exit_depth);
                continue;
            }
            Operation::Return { cleanup } => {
                emitter.return_stack(cleanup, exit_depth);
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
