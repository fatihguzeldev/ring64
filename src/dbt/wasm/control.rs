use super::{ENTRY, Emitter, REASON, REMAINING, RIP};
use crate::embedding::layout::{BUDGET, DISPATCH, STOP, TARGET};
use crate::memory::canonical48;
use wasm_encoder::{BlockType, Instruction as Op};

impl Emitter {
    pub(super) fn exit(&mut self, reason: i32, depth: u32) {
        self.op(Op::I32Const(reason))
            .op(Op::LocalSet(REASON))
            .op(Op::Br(depth));
    }

    pub(super) fn gates(&mut self, exit_depth: u32) {
        self.op(Op::LocalGet(REMAINING))
            .op(Op::I64Eqz)
            .op(Op::If(BlockType::Empty));
        self.exit(BUDGET, exit_depth + 1);
        self.op(Op::End)
            .op(Op::LocalGet(3))
            .op(Op::LocalGet(RIP))
            .op(Op::LocalGet(2))
            .op(Op::I64Eq)
            .op(Op::I32And)
            .op(Op::If(BlockType::Empty));
        self.exit(STOP, exit_depth + 1);
        self.op(Op::End);
    }

    pub(super) fn commit(&mut self, next: u64) {
        self.op(Op::I64Const(next as i64))
            .op(Op::LocalSet(RIP))
            .op(Op::LocalGet(REMAINING))
            .op(Op::I64Const(1))
            .op(Op::I64Sub)
            .op(Op::LocalSet(REMAINING));
    }

    pub(super) fn route(&mut self, target: u64, loop_depth: u32, exit_depth: u32) {
        if let Some(&index) = self.entries.get(&target) {
            if index > self.current_index {
                // Later instructions retain enclosing labels. A conditional
                // target adds its active `if` to the ordinary loop depth.
                let extra_depth = loop_depth - (self.entries.len() as u32 - self.current_index);
                self.op(Op::Br(index - self.current_index - 1 + extra_depth));
            } else {
                self.op(Op::I32Const(index as i32))
                    .op(Op::LocalSet(ENTRY))
                    .op(Op::Br(loop_depth));
            }
        } else {
            // Budget/stop still precede fetch even at an external frontier.
            self.gates(exit_depth);
            self.exit(DISPATCH, exit_depth);
        }
    }

    pub(super) fn target(&mut self, target: u64, loop_depth: u32, exit_depth: u32) {
        if !canonical48(target) {
            self.exit(TARGET, exit_depth);
        } else {
            self.commit(target);
            self.route(target, loop_depth, exit_depth);
        }
    }
}
