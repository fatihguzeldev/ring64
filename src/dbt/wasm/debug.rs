use super::{Emitter, REASON};
use crate::embedding::layout::{DISPATCH, RunState};
use crate::x86::instruction::{RegisterView, Width};
use wasm_encoder::{Instruction as Op, MemArg};
impl Emitter {
    pub(super) fn debug_register(
        &mut self,
        register: u8,
        gpr: u8,
        write: bool,
        width: Width,
        next: u64,
        depth: u32,
    ) {
        self.op(Op::I32Const(
            i32::from(register)
                | if write { 8 } else { 0 }
                | if width == Width::W64 { 16 } else { 0 },
        ));
        if write {
            self.register(gpr, width);
        } else {
            self.op(Op::I64Const(0));
        }
        self.op(Op::I64Const(self.current_pc as i64));
        self.full_flags();
        self.op(Op::Call(
            self.debug_register.expect("debug register import"),
        ))
        .op(Op::LocalTee(REASON))
        .op(Op::BrIf(depth));
        if !write {
            self.op(Op::LocalGet(0)).op(Op::I64Load(MemArg {
                offset: std::mem::offset_of!(RunState, vector_scratch) as u64,
                align: 0,
                memory_index: 0,
            }));
            self.write_register(RegisterView::low(gpr), width);
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
