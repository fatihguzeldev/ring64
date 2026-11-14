use super::{Emitter, GPR, REASON, STORE_STATUS};
use crate::embedding::layout::RunState;
use crate::x86::compound_stack::CompoundStack;
use std::mem::offset_of;
use wasm_encoder::{Instruction as Op, MemArg};

fn memory(offset: usize) -> MemArg {
    MemArg {
        offset: offset as u64,
        align: 3,
        memory_index: 0,
    }
}

impl Emitter {
    pub(super) fn compound_stack(&mut self, operation: CompoundStack, exit_depth: u32) {
        let helper = self.compound_stack.expect("compound stack import");
        for bank in 0..8 {
            self.op(Op::LocalGet(0))
                .op(Op::LocalGet(GPR + bank as u32))
                .op(Op::I64Store(memory(
                    offset_of!(RunState, registers) + bank * 8,
                )));
        }
        self.op(Op::LocalGet(0));
        self.full_flags();
        self.op(Op::I64Store(memory(offset_of!(RunState, flags))))
            .op(Op::I32Const(operation.encode() as i32))
            .op(Op::Call(helper))
            .op(Op::LocalSet(REASON));
        // POPA's SS-limit prefix is architectural residue even on failure.
        // Reload before testing status so the common exit cannot erase it.
        for bank in 0..8 {
            self.op(Op::LocalGet(0))
                .op(Op::I64Load(memory(
                    offset_of!(RunState, registers) + bank * 8,
                )))
                .op(Op::LocalSet(GPR + bank as u32));
        }
        self.op(Op::LocalGet(REASON));
        self.numeric_state_result(exit_depth);
        self.op(Op::LocalGet(REASON)).op(Op::LocalSet(STORE_STATUS));
        self.stores = true;
    }
}
