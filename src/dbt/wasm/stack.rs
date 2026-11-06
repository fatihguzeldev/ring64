use super::{ADDRESS, Emitter, GPR, RESULT, RHS, VALUE};
use crate::memory::canonical48;
use crate::x86::instruction::{Address, AddressBase, Operand, Width};
use wasm_encoder::Instruction as Op;

const RSP: u32 = GPR + 4;

impl Emitter {
    fn stack_word(&mut self, exit_depth: u32) {
        self.load_value(
            Address {
                base: AddressBase::Register(4),
                index: None,
                displacement: 0,
            },
            Width::W64,
            0,
            false,
            exit_depth,
        );
    }

    fn push_result(&mut self, exit_depth: u32) {
        self.op(Op::LocalGet(RSP))
            .op(Op::I64Const(8))
            .op(Op::I64Sub)
            .op(Op::LocalSet(ADDRESS));
        self.store_result(Width::W64, exit_depth);
        self.op(Op::LocalGet(ADDRESS)).op(Op::LocalSet(RSP));
    }

    pub(super) fn push(&mut self, src: Operand, exit_depth: u32) {
        self.operand(src, Width::W64);
        self.op(Op::LocalSet(RESULT));
        self.push_result(exit_depth);
    }

    pub(super) fn pop(&mut self, dst: u8, exit_depth: u32) {
        self.stack_word(exit_depth);
        self.op(Op::LocalGet(ADDRESS))
            .op(Op::I64Const(8))
            .op(Op::I64Add)
            .op(Op::LocalSet(RSP))
            .op(Op::LocalGet(VALUE))
            .op(Op::LocalSet(GPR + u32::from(dst)));
    }

    pub(super) fn call(&mut self, target: Operand, next_pc: u64, loop_depth: u32, exit_depth: u32) {
        match target {
            Operand::Immediate(target) => {
                if !canonical48(target) {
                    self.op(Op::I64Const(target as i64)).op(Op::LocalSet(RHS));
                    self.target_failure(exit_depth);
                    return;
                }
                self.op(Op::I64Const(next_pc as i64))
                    .op(Op::LocalSet(RESULT));
                self.push_result(exit_depth);
                self.commit(target);
                self.route(target, loop_depth, exit_depth);
            }
            Operand::Register(target) => {
                self.op(Op::LocalGet(GPR + u32::from(target)))
                    .op(Op::LocalSet(RHS));
                self.check_runtime_target(exit_depth);
                self.op(Op::I64Const(next_pc as i64))
                    .op(Op::LocalSet(RESULT));
                self.push_result(exit_depth);
                self.commit_runtime_target(exit_depth);
            }
        }
    }

    pub(super) fn return_stack(&mut self, cleanup: u16, exit_depth: u32) {
        self.stack_word(exit_depth);
        self.op(Op::LocalGet(VALUE)).op(Op::LocalSet(RHS));
        self.check_runtime_target(exit_depth);
        self.op(Op::LocalGet(ADDRESS))
            .op(Op::I64Const(8 + i64::from(cleanup)))
            .op(Op::I64Add)
            .op(Op::LocalSet(RSP));
        self.commit_runtime_target(exit_depth);
    }
}
