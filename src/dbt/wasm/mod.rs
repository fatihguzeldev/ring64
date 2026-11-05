mod control;
mod integer;
mod memory;
mod state;

use std::collections::BTreeMap;
use wasm_encoder::{
    BlockType, CodeSection, EntityType, ExportKind, ExportSection, Function, FunctionSection,
    ImportSection, Instruction as Op, MemoryType, Module, TypeSection, ValType,
};

use super::unit::Unit;
use crate::embedding::layout::DISPATCH;
use crate::x86::instruction::Operation;

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
}

impl Emitter {
    fn op(&mut self, instruction: Op<'_>) -> &mut Self {
        self.body.instruction(&instruction);
        self
    }
}

pub(crate) fn emit(unit: &Unit) -> Vec<u8> {
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
    let mut functions = FunctionSection::new();
    functions.function(3);
    let mut exports = ExportSection::new();
    exports.export("run", ExportKind::Func, 3);
    let mut emitter = Emitter {
        current_index: 0,
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
                emitter.operand(src, width);
                emitter.op(Op::LocalSet(GPR + u32::from(dst)));
            }
            Operation::Alu {
                kind,
                dst,
                src,
                width,
            } => emitter.integer(kind, dst, src, width),
            Operation::Load {
                dst,
                address,
                width,
            } => emitter.load(dst, address, width, exit_depth),
            Operation::Store {
                src,
                address,
                width,
            } => emitter.store(src, address, width, exit_depth),
            Operation::Jump { target } => {
                emitter.target(target, loop_depth, exit_depth);
                continue;
            }
            Operation::Jnz { target } => {
                emitter
                    .op(Op::LocalGet(FLAGS))
                    .op(Op::I64Const(0x40))
                    .op(Op::I64And)
                    .op(Op::I64Eqz)
                    .op(Op::If(BlockType::Empty));
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
