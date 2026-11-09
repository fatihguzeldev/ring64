use super::{Emitter, FLAGS, GPR, REASON, STORE_STATUS};
use crate::embedding::layout::RunState;
use crate::x86::context::Segment;
use crate::x86::instruction::X87Instruction;
use std::mem::offset_of;
use wasm_encoder::{Instruction as Wasm, MemArg};

impl Emitter {
    pub(super) fn x87(
        &mut self,
        instruction: X87Instruction,
        pc: u64,
        next_pc: u64,
        exit_depth: u32,
    ) {
        let operation = instruction.op;
        let helper = self.x87.expect("x87 import");
        self.op(Wasm::I32Const(operation.encode() as i32));
        let segment = if let Some(address) = instruction.address {
            self.address(address, next_pc);
            address.segment
        } else {
            self.op(Wasm::I64Const(0));
            Segment::Ds
        };
        self.op(Wasm::I32Const(segment as i32))
            .op(Wasm::I64Const(pc as i64));
        if operation.writes_flags() {
            self.full_flags();
        } else {
            self.op(Wasm::LocalGet(FLAGS));
        }
        self.op(Wasm::LocalGet(GPR))
            .op(Wasm::Call(helper))
            .op(Wasm::LocalTee(REASON))
            .op(Wasm::I32Eqz)
            .op(Wasm::LocalGet(REASON))
            .op(Wasm::I32Const(2))
            .op(Wasm::I32Eq)
            .op(Wasm::I32Or)
            .op(Wasm::I32Eqz)
            .op(Wasm::BrIf(exit_depth));
        if operation.writes_flags() {
            self.op(Wasm::LocalGet(0))
                .op(Wasm::I64Load(MemArg {
                    offset: offset_of!(RunState, flags) as u64,
                    align: 3,
                    memory_index: 0,
                }))
                .op(Wasm::I64Const(0x8d7))
                .op(Wasm::I64And)
                .op(Wasm::LocalSet(FLAGS));
        }
        if operation.writes_ax() {
            self.op(Wasm::LocalGet(0))
                .op(Wasm::I64Load(MemArg {
                    offset: offset_of!(RunState, registers) as u64,
                    align: 3,
                    memory_index: 0,
                }))
                .op(Wasm::LocalSet(GPR));
        }
        if operation.is_store() {
            self.op(Wasm::LocalGet(REASON))
                .op(Wasm::LocalSet(STORE_STATUS));
            self.stores = true;
        }
    }
}
