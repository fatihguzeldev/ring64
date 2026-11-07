use super::{Emitter, FLAGS, REASON, STORE_STATUS};
use crate::embedding::layout::RunState;
use crate::x86::instruction::{Address, FloatInstruction, Location, RegisterView, Width};
use std::mem::offset_of;
use wasm_encoder::{BlockType, Instruction as Op};

impl Emitter {
    pub(super) fn float(&mut self, instruction: FloatInstruction, next_pc: u64, exit_depth: u32) {
        let [left, right, result] = self.vector_temps();
        let helper = self.float.expect("numeric import");
        if instruction.destination_is_gpr() {
            self.op(Op::V128Const(0));
        } else {
            self.op(Op::LocalGet(self.xmm(instruction.dst)));
        }
        self.op(Op::LocalSet(left));
        match instruction.src {
            Location::Register(src) if instruction.source_is_gpr() => {
                self.data_register(
                    src,
                    if instruction.op.integer64 {
                        Width::W64
                    } else {
                        Width::W32
                    },
                );
                self.op(Op::LocalSet(super::VALUE))
                    .op(Op::V128Const(0))
                    .op(Op::LocalGet(super::VALUE))
                    .op(Op::I64x2ReplaceLane(0));
            }
            Location::Register(src) => {
                self.op(Op::LocalGet(self.xmm(src.bank)));
            }
            Location::Memory(address) => {
                let bytes = instruction.source_bytes();
                self.vector_load_value(address, bytes, bytes == 16, next_pc, exit_depth);
            }
        }
        self.op(Op::LocalSet(right))
            .op(Op::I32Const(instruction.op.encode() as i32))
            .op(Op::LocalGet(left))
            .op(Op::I64x2ExtractLane(0))
            .op(Op::LocalGet(left))
            .op(Op::I64x2ExtractLane(1))
            .op(Op::LocalGet(right))
            .op(Op::I64x2ExtractLane(0))
            .op(Op::LocalGet(right))
            .op(Op::I64x2ExtractLane(1))
            .op(Op::Call(helper))
            .op(Op::LocalTee(REASON))
            .op(Op::I32Eqz)
            .op(Op::I32Eqz)
            .op(Op::BrIf(exit_depth));
        self.op(Op::LocalGet(0))
            .op(Op::V128Load(super::vector::memory(offset_of!(
                RunState,
                vector_scratch
            ))))
            .op(Op::LocalSet(result));
        if instruction.writes_flags() {
            self.op(Op::LocalGet(FLAGS))
                .op(Op::I64Const(!0x8d5i64))
                .op(Op::I64And)
                .op(Op::LocalGet(result))
                .op(Op::I64x2ExtractLane(0))
                .op(Op::I64Or)
                .op(Op::LocalSet(FLAGS));
        } else if instruction.destination_is_gpr() {
            self.op(Op::LocalGet(result)).op(Op::I64x2ExtractLane(0));
            let width = if instruction.op.integer64 {
                Width::W64
            } else {
                Width::W32
            };
            self.narrow(width);
            self.write_register(RegisterView::low(instruction.dst), width);
        } else {
            let destination = self.xmm(instruction.dst);
            self.op(Op::LocalGet(result)).op(Op::LocalSet(destination));
        }
    }

    pub(super) fn mxcsr(&mut self, address: Address, store: bool, next_pc: u64, exit_depth: u32) {
        let helper = if store {
            self.store_mxcsr.expect("MXCSR store import")
        } else {
            self.load_mxcsr.expect("MXCSR load import")
        };
        self.address(address, next_pc);
        self.op(Op::I32Const(address.segment as i32))
            .op(Op::Call(helper));
        if store {
            self.op(Op::LocalTee(STORE_STATUS))
                .op(Op::I32Eqz)
                .op(Op::If(BlockType::Empty));
            self.vector_failure(exit_depth + 1);
            self.op(Op::End);
            self.stores = true;
        } else {
            self.op(Op::LocalTee(REASON))
                .op(Op::I32Eqz)
                .op(Op::I32Eqz)
                .op(Op::BrIf(exit_depth));
        }
    }
}
