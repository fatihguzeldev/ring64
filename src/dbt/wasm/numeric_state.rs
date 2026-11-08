use super::{Emitter, GPR, REASON, STORE_STATUS};
use crate::embedding::layout::RunState;
use crate::x86::context::Segment;
use crate::x86::instruction::Address;
use crate::x86::{mmx, numeric_images};
use std::mem::offset_of;
use wasm_encoder::{Instruction as Wasm, MemArg};

impl Emitter {
    fn spill_xmm(&mut self, bank: u8) {
        if let Some(local) = self.vector_registers[usize::from(bank)] {
            self.op(Wasm::LocalGet(0))
                .op(Wasm::LocalGet(local))
                .op(Wasm::V128Store(super::vector::memory(
                    offset_of!(RunState, xmm) + usize::from(bank) * 16,
                )));
        }
    }

    fn reload_xmm(&mut self, bank: u8) {
        if let Some(local) = self.vector_registers[usize::from(bank)] {
            self.op(Wasm::LocalGet(0))
                .op(Wasm::V128Load(super::vector::memory(
                    offset_of!(RunState, xmm) + usize::from(bank) * 16,
                )))
                .op(Wasm::LocalSet(local));
        }
    }

    fn numeric_state_result(&mut self, exit_depth: u32) {
        self.op(Wasm::LocalTee(REASON))
            .op(Wasm::I32Eqz)
            .op(Wasm::LocalGet(REASON))
            .op(Wasm::I32Const(2))
            .op(Wasm::I32Eq)
            .op(Wasm::I32Or)
            .op(Wasm::I32Eqz)
            .op(Wasm::BrIf(exit_depth));
    }

    pub(super) fn mmx(
        &mut self,
        operation: mmx::Op,
        address: Option<Address>,
        next_pc: u64,
        exit_depth: u32,
    ) {
        if let Some(bank) = operation.source_xmm() {
            self.spill_xmm(bank);
        }
        if operation.kind == mmx::Kind::PiToPs {
            self.spill_xmm(operation.dst);
        }
        let helper = self.mmx.expect("MMX import");
        self.op(Wasm::I32Const(operation.encode() as i32));
        let segment = if let Some(address) = address {
            self.address(address, next_pc);
            address.segment
        } else {
            if let Some(bank) = operation.source_gpr().or(operation.destination_gpr()) {
                self.op(Wasm::LocalGet(GPR + u32::from(bank)));
            } else {
                self.op(Wasm::I64Const(0));
            }
            Segment::Ds
        };
        self.op(Wasm::I32Const(segment as i32))
            .op(Wasm::Call(helper));
        self.numeric_state_result(exit_depth);
        if let Some(bank) = operation.destination_gpr() {
            self.op(Wasm::LocalGet(0))
                .op(Wasm::I64Load(MemArg {
                    offset: (offset_of!(RunState, registers) + usize::from(bank) * 8) as u64,
                    align: 3,
                    memory_index: 0,
                }))
                .op(Wasm::LocalSet(GPR + u32::from(bank)));
        }
        if let Some(bank) = operation.destination_xmm() {
            self.reload_xmm(bank);
        }
        if operation.is_store() {
            self.op(Wasm::LocalGet(REASON))
                .op(Wasm::LocalSet(STORE_STATUS));
            self.stores = true;
        }
    }

    pub(super) fn numeric_image(
        &mut self,
        operation: numeric_images::ImageOp,
        address: Address,
        next_pc: u64,
        exit_depth: u32,
    ) {
        if operation.kind == numeric_images::Kind::SaveFx {
            for bank in 0..operation.xmm_count() {
                self.spill_xmm(bank as u8);
            }
        }
        let helper = self.numeric_image.expect("numeric image import");
        self.op(Wasm::I32Const(operation.encode() as i32));
        self.address(address, next_pc);
        self.op(Wasm::I32Const(address.segment as i32))
            .op(Wasm::Call(helper));
        self.numeric_state_result(exit_depth);
        if operation.kind == numeric_images::Kind::RestoreFx {
            for bank in 0..operation.xmm_count() {
                self.reload_xmm(bank as u8);
            }
        }
        if operation.is_store() {
            self.op(Wasm::LocalGet(REASON))
                .op(Wasm::LocalSet(STORE_STATUS));
            self.stores = true;
        }
    }
}
