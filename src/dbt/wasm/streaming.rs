use super::{Emitter, REASON, STORE_STATUS};
use crate::embedding::layout::RunState;
use crate::x86::instruction::Address;
use std::mem::offset_of;
use wasm_encoder::Instruction as Op;

impl Emitter {
    pub(super) fn masked_store(
        &mut self,
        data: u8,
        mask: u8,
        mmx: bool,
        address: Address,
        next_pc: u64,
        exit_depth: u32,
    ) {
        let scratch = offset_of!(RunState, vector_scratch);
        self.op(Op::LocalGet(0));
        if mmx {
            self.mmx_read_vector(data);
        } else {
            self.op(Op::LocalGet(self.xmm(data)));
        }
        self.op(Op::V128Store(super::vector::memory(scratch)));
        self.address(address, next_pc);
        self.op(Op::I32Const(if mmx { 8 } else { 16 }))
            .op(Op::LocalGet(0))
            .op(Op::I32Const(scratch as i32))
            .op(Op::I32Add);
        if mmx {
            self.mmx_read_vector(mask);
        } else {
            self.op(Op::LocalGet(self.xmm(mask)));
        }
        let helper = self.masked_store.expect("masked store import");
        self.op(Op::I8x16Bitmask)
            .op(Op::I32Const(address.segment as i32))
            .op(Op::Call(helper));
        self.numeric_state_result(exit_depth);
        self.op(Op::LocalGet(REASON)).op(Op::LocalSet(STORE_STATUS));
        self.stores = true;
    }

    pub(super) fn clflush(&mut self, address: Address, next_pc: u64, exit_depth: u32) {
        self.address(address, next_pc);
        let helper = self.clflush.expect("CLFLUSH import");
        self.op(Op::I32Const(address.segment as i32))
            .op(Op::Call(helper))
            .op(Op::LocalTee(REASON))
            .op(Op::BrIf(exit_depth));
    }
}
