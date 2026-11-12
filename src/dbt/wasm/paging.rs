use super::{Emitter, GPR, REASON, VALUE};
use crate::embedding::layout::{DISPATCH, RunState};
use crate::x86::instruction::{PagingInstruction, RegisterView, Width};
use wasm_encoder::{Instruction as Op, MemArg};

impl Emitter {
    pub(super) fn paging_control(&mut self, operation: PagingInstruction, next: u64, depth: u32) {
        match operation {
            PagingInstruction::ClearTaskSwitched => {
                self.op(Op::I32Const(5))
                    .op(Op::I32Const(0))
                    .op(Op::I64Const(0));
            }
            PagingInstruction::ControlRegister {
                register,
                gpr,
                write,
                width,
            } => {
                self.op(Op::I32Const(i32::from(write)))
                    .op(Op::I32Const(i32::from(register)));
                if write {
                    self.register(gpr, width);
                } else {
                    self.op(Op::I64Const(0));
                }
            }
            PagingInstruction::ModelSpecificRegister { write } => {
                self.op(Op::I32Const(if write { 3 } else { 2 }));
                self.register(1, Width::W32);
                self.op(Op::I32WrapI64);
                if write {
                    self.register(0, Width::W32);
                    self.register(2, Width::W32);
                    self.op(Op::I64Const(32)).op(Op::I64Shl).op(Op::I64Or);
                } else {
                    self.op(Op::I64Const(0));
                }
            }
            PagingInstruction::InvalidatePage(address) => {
                self.op(Op::I32Const(4))
                    .op(Op::I32Const(address.segment as i32));
                self.address(address, next);
            }
        }
        self.op(Op::I64Const(self.current_pc as i64));
        self.full_flags();
        self.retired();
        self.op(Op::Call(
            self.paging_control.expect("paging control import"),
        ))
        .op(Op::LocalTee(REASON))
        .op(Op::BrIf(depth));
        if matches!(
            operation,
            PagingInstruction::ControlRegister { write: false, .. }
                | PagingInstruction::ModelSpecificRegister { write: false }
        ) {
            self.op(Op::LocalGet(0)).op(Op::I64Load(MemArg {
                offset: std::mem::offset_of!(RunState, vector_scratch) as u64,
                align: 0,
                memory_index: 0,
            }));
            match operation {
                PagingInstruction::ControlRegister { gpr, width, .. } => {
                    self.narrow(width);
                    self.write_register(RegisterView::low(gpr), width);
                }
                PagingInstruction::ModelSpecificRegister { .. } => {
                    self.op(Op::LocalSet(VALUE))
                        .op(Op::LocalGet(VALUE))
                        .op(Op::I64Const(u32::MAX.into()))
                        .op(Op::I64And)
                        .op(Op::LocalSet(GPR))
                        .op(Op::LocalGet(VALUE))
                        .op(Op::I64Const(32))
                        .op(Op::I64ShrU)
                        .op(Op::LocalSet(GPR + 2));
                }
                PagingInstruction::InvalidatePage(_) | PagingInstruction::ClearTaskSwitched => {
                    unreachable!()
                }
            }
        }
        self.commit(next);
        if self.finish_instruction(depth) {
            return;
        }
        self.external_boundary(depth);
        self.gates(depth);
        self.exit(DISPATCH, depth);
    }
}
