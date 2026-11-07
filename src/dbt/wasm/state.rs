use super::{DIRECTION, Emitter, FLAGS, GPR, REMAINING, REPEAT_REMAINING, RIP};
use crate::embedding::layout::RunState;
use std::mem::{offset_of, size_of};
use wasm_encoder::{Instruction as Op, MemArg};

fn memory(offset: usize) -> MemArg {
    MemArg {
        offset: offset as u64,
        align: 3,
        memory_index: 0,
    }
}

impl Emitter {
    pub(super) fn load_state(&mut self) {
        for register in 0..16 {
            self.op(Op::LocalGet(0))
                .op(Op::I64Load(memory(
                    offset_of!(RunState, registers) + register * size_of::<u64>(),
                )))
                .op(Op::LocalSet(GPR + register as u32));
        }
        for (local, offset) in [
            (FLAGS, offset_of!(RunState, flags)),
            (RIP, offset_of!(RunState, rip)),
        ] {
            self.op(Op::LocalGet(0))
                .op(Op::I64Load(memory(offset)))
                .op(Op::LocalSet(local));
        }
        // Keep direction independent from arithmetic status producers.
        self.op(Op::LocalGet(FLAGS))
            .op(Op::I64Const(0x400))
            .op(Op::I64And)
            .op(Op::LocalSet(DIRECTION))
            .op(Op::LocalGet(FLAGS))
            .op(Op::I64Const(!0x400))
            .op(Op::I64And)
            .op(Op::LocalSet(FLAGS));
        self.op(Op::LocalGet(1)).op(Op::LocalSet(REMAINING));
        if self.has_repeat {
            self.op(Op::LocalGet(0))
                .op(Op::I64Load(memory(offset_of!(RunState, repeat_remaining))))
                .op(Op::LocalSet(REPEAT_REMAINING));
        }
    }

    pub(super) fn publish_state(&mut self) {
        for register in 0..16 {
            self.op(Op::LocalGet(0))
                .op(Op::LocalGet(GPR + register as u32))
                .op(Op::I64Store(memory(
                    offset_of!(RunState, registers) + register * size_of::<u64>(),
                )));
        }
        for (local, offset) in [
            (FLAGS, offset_of!(RunState, flags)),
            (RIP, offset_of!(RunState, rip)),
            (REMAINING, offset_of!(RunState, remaining)),
        ] {
            self.op(Op::LocalGet(0)).op(Op::LocalGet(local));
            if local == FLAGS {
                self.op(Op::LocalGet(DIRECTION)).op(Op::I64Or);
            }
            self.op(Op::I64Store(memory(offset)));
        }
        if self.has_repeat {
            self.op(Op::LocalGet(0))
                .op(Op::LocalGet(REPEAT_REMAINING))
                .op(Op::I64Store(memory(offset_of!(RunState, repeat_remaining))));
        }
    }
}
