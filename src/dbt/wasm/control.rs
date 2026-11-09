use super::{ENTRY, Emitter, FLAGS, REASON, REMAINING, RESULT, RHS, RIP, STORE_STATUS, VALUE};
use crate::embedding::layout::{BUDGET, DISPATCH, RunState, SEGMENT, STOP, TARGET};
use crate::memory::canonical48;
use crate::x86::context::Segment;
use crate::x86::instruction::{Address, Condition, CountCondition, RegisterView, Width};
use wasm_encoder::{BlockType, Instruction as Op, MemArg};

impl Emitter {
    pub(super) fn target_failure(&mut self, exit_depth: u32) {
        self.record_fault_segment(Segment::Cs);
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
        if let Some(check) = self.target_check {
            self.op(Op::LocalGet(RHS))
                .op(Op::Call(check))
                .op(Op::I32Eqz)
                .op(Op::If(BlockType::Empty));
            self.exit(SEGMENT, exit_depth + 1);
            self.op(Op::End);
            return;
        }
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
        if self.finish_instruction(exit_depth) {
            return;
        }
        self.gates(exit_depth);
        self.code_write_boundary(exit_depth);
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

    pub(super) fn jump_register(&mut self, target: u8, width: Width, exit_depth: u32) {
        self.register(target, width);
        self.op(Op::LocalSet(RHS));
        self.check_runtime_target(exit_depth);
        self.commit_runtime_target(exit_depth);
    }

    pub(super) fn jump_memory(
        &mut self,
        address: Address,
        width: Width,
        next_pc: u64,
        exit_depth: u32,
    ) {
        self.load_value(address, width, next_pc, false, exit_depth);
        self.op(Op::LocalGet(VALUE)).op(Op::LocalSet(RHS));
        self.check_runtime_target(exit_depth);
        self.commit_runtime_target(exit_depth);
    }

    pub(super) fn count_branch(
        &mut self,
        condition: CountCondition,
        width: Width,
        target: u64,
        loop_depth: u32,
        exit_depth: u32,
    ) {
        self.register(1, width);
        if condition != CountCondition::Zero {
            self.op(Op::I64Const(1)).op(Op::I64Sub);
            self.narrow(width);
            self.op(Op::LocalTee(RESULT));
        }
        self.op(Op::I64Eqz);
        if condition != CountCondition::Zero {
            self.op(Op::I32Eqz);
        }
        if matches!(condition, CountCondition::Equal | CountCondition::NotEqual) {
            self.condition(if condition == CountCondition::Equal {
                Condition::Equal
            } else {
                Condition::NotEqual
            });
            self.op(Op::I32And);
        }
        self.op(Op::If(BlockType::Empty));
        if self.check_static_target(target, exit_depth + 1) {
            if condition != CountCondition::Zero {
                self.op(Op::LocalGet(RESULT));
                self.write_register(RegisterView::low(1), width);
            }
            self.commit(target);
            self.route(target, loop_depth + 1, exit_depth + 1);
        }
        self.op(Op::End);
        if condition != CountCondition::Zero {
            self.op(Op::LocalGet(RESULT));
            self.write_register(RegisterView::low(1), width);
        }
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
        if self.finish_instruction(exit_depth) {
            return;
        }
        self.code_write_boundary(exit_depth);
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

    fn code_write_boundary(&mut self, exit_depth: u32) {
        if self.stores {
            // Status two is successful storage that invalidated this owner.
            // All instruction effects and its retirement are committed first.
            self.op(Op::LocalGet(STORE_STATUS))
                .op(Op::I32Const(2))
                .op(Op::I32Eq)
                .op(Op::If(BlockType::Empty));
            self.gates(exit_depth + 1);
            self.exit(DISPATCH, exit_depth + 1);
            self.op(Op::End);
        }
    }

    pub(super) fn check_static_target(&mut self, target: u64, exit_depth: u32) -> bool {
        if self.context.is_long64() {
            if !canonical48(target) {
                self.op(Op::I64Const(target as i64)).op(Op::LocalSet(RHS));
                self.target_failure(exit_depth);
                return false;
            }
        } else if target > self.context.code_limit() {
            self.op(Op::I64Const(target as i64)).op(Op::LocalSet(RHS));
            self.check_runtime_target(exit_depth);
            return false;
        }
        true
    }

    pub(super) fn target(&mut self, target: u64, loop_depth: u32, exit_depth: u32) {
        if self.check_static_target(target, exit_depth) {
            self.commit(target);
            self.route(target, loop_depth, exit_depth);
        }
    }
}
