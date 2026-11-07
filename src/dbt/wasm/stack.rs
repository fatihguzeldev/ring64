use super::{ADDRESS, Emitter, GPR, LHS, RESULT, RHS, VALUE};
use crate::x86::context::Segment;
use crate::x86::instruction::{Address, AddressBase, Operand, RegisterView, Width};
use wasm_encoder::Instruction as Op;

const RSP: u32 = GPR + 4;

impl Emitter {
    fn stack_word(&mut self, width: Width, exit_depth: u32) {
        self.load_value(
            Address {
                base: AddressBase::Register(4),
                index: None,
                displacement: 0,
                size: self.context.stack_width(),
                segment: Segment::Ss,
            },
            width,
            0,
            false,
            exit_depth,
        );
    }

    fn update_stack_pointer(&mut self, count: u64) {
        self.op(Op::LocalGet(ADDRESS))
            .op(Op::I64Const(count as i64))
            .op(Op::I64Add);
        let stack_width = self.context.stack_width();
        self.narrow(stack_width);
        self.write_register(RegisterView::low(4), stack_width);
    }

    fn push_result(&mut self, width: Width, exit_depth: u32) {
        let stack_width = self.context.stack_width();
        self.op(Op::LocalGet(RSP))
            .op(Op::I64Const(i64::from(width.bytes())))
            .op(Op::I64Sub);
        self.narrow(stack_width);
        self.op(Op::LocalSet(ADDRESS));
        self.segment = Segment::Ss;
        self.store_result(width, exit_depth);
        self.op(Op::LocalGet(ADDRESS));
        self.write_register(RegisterView::low(4), stack_width);
    }

    pub(super) fn push(&mut self, src: Operand, width: Width, next_pc: u64, exit_depth: u32) {
        self.operand(src, width, next_pc, exit_depth);
        self.op(Op::LocalSet(RESULT));
        self.push_result(width, exit_depth);
    }

    pub(super) fn pop(&mut self, dst: u8, width: Width, exit_depth: u32) {
        self.stack_word(width, exit_depth);
        self.update_stack_pointer(u64::from(width.bytes()));
        self.op(Op::LocalGet(VALUE));
        self.write_register(RegisterView::low(dst), width);
    }

    pub(super) fn pop_memory(
        &mut self,
        address: Address,
        width: Width,
        next_pc: u64,
        exit_depth: u32,
    ) {
        self.stack_word(width, exit_depth);
        self.op(Op::LocalGet(VALUE)).op(Op::LocalSet(RESULT));
        self.op(Op::LocalGet(ADDRESS))
            .op(Op::I64Const(i64::from(width.bytes())))
            .op(Op::I64Add);
        let stack_width = self.context.stack_width();
        self.narrow(stack_width);
        self.merge_register(RegisterView::low(4), stack_width);
        self.op(Op::LocalSet(LHS));
        self.address_with_stack(address, next_pc, Some(LHS));
        self.op(Op::LocalSet(ADDRESS));
        self.store_result(width, exit_depth);
        self.op(Op::LocalGet(LHS)).op(Op::LocalSet(RSP));
    }

    pub(super) fn leave(&mut self, width: Width, exit_depth: u32) {
        self.register(5, self.context.stack_width());
        self.op(Op::LocalSet(ADDRESS));
        self.segment = Segment::Ss;
        self.load_address_value(width, false, exit_depth);
        self.update_stack_pointer(u64::from(width.bytes()));
        self.op(Op::LocalGet(VALUE));
        self.write_register(RegisterView::low(5), width);
    }

    pub(super) fn call(
        &mut self,
        target: Operand,
        width: Width,
        next_pc: u64,
        loop_depth: u32,
        exit_depth: u32,
    ) {
        match target {
            Operand::Immediate(target) => {
                if !self.check_static_target(target, exit_depth) {
                    return;
                }
                self.op(Op::I64Const(next_pc as i64))
                    .op(Op::LocalSet(RESULT));
                self.push_result(width, exit_depth);
                self.commit(target);
                self.route(target, loop_depth, exit_depth);
            }
            Operand::Register(_) | Operand::Memory(_) => {
                self.operand(target, width, next_pc, exit_depth);
                self.op(Op::LocalSet(RHS));
                self.check_runtime_target(exit_depth);
                self.op(Op::I64Const(next_pc as i64))
                    .op(Op::LocalSet(RESULT));
                self.push_result(width, exit_depth);
                self.commit_runtime_target(exit_depth);
            }
        }
    }

    pub(super) fn return_stack(&mut self, cleanup: u16, width: Width, exit_depth: u32) {
        self.stack_word(width, exit_depth);
        self.op(Op::LocalGet(VALUE)).op(Op::LocalSet(RHS));
        self.check_runtime_target(exit_depth);
        self.update_stack_pointer(u64::from(width.bytes()) + u64::from(cleanup));
        self.commit_runtime_target(exit_depth);
    }
}
