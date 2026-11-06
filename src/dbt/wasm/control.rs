use super::{ENTRY, Emitter, FLAGS, GPR, REASON, REMAINING, RHS, RIP};
use crate::embedding::layout::{BUDGET, DISPATCH, RunState, STOP, TARGET};
use crate::memory::canonical48;
use crate::x86::instruction::Condition;
use wasm_encoder::{BlockType, Instruction as Op, MemArg};

impl Emitter {
    pub(super) fn target_failure(&mut self, exit_depth: u32) {
        // Runtime targets cannot be recovered by decoding the published RIP.
        self.op(Op::LocalGet(0))
            .op(Op::LocalGet(RHS))
            .op(Op::I64Store(MemArg {
                offset: std::mem::offset_of!(RunState, target) as u64,
                align: 3,
                memory_index: 0,
            }));
        self.exit(TARGET, exit_depth);
    }

    pub(super) fn check_runtime_target(&mut self, exit_depth: u32) {
        self.op(Op::LocalGet(RHS))
            .op(Op::I64Const(16))
            .op(Op::I64Shl)
            .op(Op::I64Const(16))
            .op(Op::I64ShrS)
            .op(Op::LocalGet(RHS))
            .op(Op::I64Ne)
            .op(Op::If(BlockType::Empty));
        self.target_failure(exit_depth + 1);
        self.op(Op::End);
    }

    pub(super) fn commit_runtime_target(&mut self, exit_depth: u32) {
        self.op(Op::LocalGet(RHS))
            .op(Op::LocalSet(RIP))
            .op(Op::LocalGet(REMAINING))
            .op(Op::I64Const(1))
            .op(Op::I64Sub)
            .op(Op::LocalSet(REMAINING));
        self.gates(exit_depth);
        let lookup = self
            .entry_lookup
            .expect("dynamic transfer has an entry lookup");
        self.op(Op::LocalGet(RHS))
            .op(Op::Call(lookup))
            .op(Op::LocalTee(ENTRY))
            .op(Op::I32Const(-1))
            .op(Op::I32Ne)
            .op(Op::If(BlockType::Empty))
            .op(Op::Br(exit_depth))
            .op(Op::End);
        self.exit(DISPATCH, exit_depth);
    }

    pub(super) fn jump_register(&mut self, target: u8, exit_depth: u32) {
        self.op(Op::LocalGet(GPR + u32::from(target)))
            .op(Op::LocalSet(RHS));
        self.check_runtime_target(exit_depth);
        self.commit_runtime_target(exit_depth);
    }

    pub(super) fn condition(&mut self, condition: Condition) {
        use Condition::*;
        match condition {
            Overflow | NotOverflow => self.flag_bits_clear(0x800),
            Below | AboveOrEqual => self.flag_bits_clear(1),
            Equal | NotEqual => self.flag_bits_clear(0x40),
            BelowOrEqual | Above => self.flag_bits_clear(0x41),
            Sign | NotSign => self.flag_bits_clear(0x80),
            Parity | NotParity => self.flag_bits_clear(4),
            Less | GreaterOrEqual => self.signed_flags_equal(),
            LessOrEqual | Greater => {
                self.flag_bits_clear(0x40);
                self.signed_flags_equal();
                self.op(Op::I32And);
            }
        }
        if matches!(
            condition,
            Overflow | Below | Equal | BelowOrEqual | Sign | Parity | Less | LessOrEqual
        ) {
            self.op(Op::I32Eqz);
        }
    }

    fn flag_bits_clear(&mut self, mask: i64) {
        self.op(Op::LocalGet(FLAGS))
            .op(Op::I64Const(mask))
            .op(Op::I64And)
            .op(Op::I64Eqz);
    }

    fn signed_flags_equal(&mut self) {
        // Align OF with SF before comparing their values.
        self.op(Op::LocalGet(FLAGS))
            .op(Op::LocalGet(FLAGS))
            .op(Op::I64Const(4))
            .op(Op::I64ShrU)
            .op(Op::I64Xor)
            .op(Op::I64Const(0x80))
            .op(Op::I64And)
            .op(Op::I64Eqz);
    }

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
            self.op(Op::I64Const(target as i64)).op(Op::LocalSet(RHS));
            self.target_failure(exit_depth);
        } else {
            self.commit(target);
            self.route(target, loop_depth, exit_depth);
        }
    }
}
