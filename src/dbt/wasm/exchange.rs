use super::{Emitter, FLAGS, LHS, RESULT, RHS, VALUE};
use crate::x86::instruction::{Address, Alu, Location, RegisterView, Width};
use wasm_encoder::{BlockType, Instruction as Op};

impl Emitter {
    pub(super) fn exchange(
        &mut self,
        dst: Location,
        src: RegisterView,
        width: Width,
        next_pc: u64,
        exit_depth: u32,
    ) {
        self.read_location(dst, width, next_pc, true, exit_depth);
        self.data_register(src, width);
        self.op(Op::LocalSet(RESULT));
        self.write_location(dst, width, exit_depth);
        self.op(Op::LocalGet(LHS));
        self.write_register(src, width);
    }

    pub(super) fn xadd(
        &mut self,
        dst: Location,
        src: RegisterView,
        width: Width,
        next_pc: u64,
        exit_depth: u32,
    ) {
        self.read_location(dst, width, next_pc, true, exit_depth);
        self.data_register(src, width);
        self.op(Op::LocalSet(RHS));
        self.arithmetic_result(Alu::Add, width);
        if matches!(dst, Location::Memory(_)) {
            self.store_result(width, exit_depth);
        }
        self.op(Op::LocalGet(LHS));
        self.write_register(src, width);
        if let Location::Register(register) = dst {
            self.op(Op::LocalGet(RESULT));
            self.write_register(register, width);
        }
        self.arithmetic_flags(Alu::Add, width);
    }

    pub(super) fn compare_exchange(
        &mut self,
        dst: Location,
        src: RegisterView,
        width: Width,
        next_pc: u64,
        exit_depth: u32,
    ) {
        self.read_location(dst, width, next_pc, true, exit_depth);
        self.op(Op::LocalGet(LHS)).op(Op::LocalSet(RHS));
        self.register(0, width);
        self.op(Op::LocalSet(LHS));
        self.data_register(src, width);
        self.op(Op::LocalSet(VALUE))
            .op(Op::LocalGet(LHS))
            .op(Op::LocalGet(RHS))
            .op(Op::I64Eq)
            .op(Op::If(BlockType::Empty))
            .op(Op::LocalGet(VALUE))
            .op(Op::LocalSet(RESULT));
        self.write_location(dst, width, exit_depth + 1);
        self.op(Op::Else);
        if matches!(dst, Location::Memory(_)) {
            self.op(Op::LocalGet(RHS)).op(Op::LocalSet(RESULT));
            self.store_result(width, exit_depth + 1);
        }
        self.op(Op::LocalGet(RHS));
        self.write_register(RegisterView::low(0), width);
        self.op(Op::End);
        self.arithmetic_result(Alu::Cmp, width);
        self.arithmetic_flags(Alu::Cmp, width);
    }

    fn pair32(&mut self, high: u8, low: u8) {
        self.register(high, Width::W32);
        self.op(Op::I64Const(32)).op(Op::I64Shl);
        self.register(low, Width::W32);
        self.op(Op::I64Or);
    }

    pub(super) fn compare_exchange8b(
        &mut self,
        address: Address,
        next_pc: u64,
        exit_depth: u32,
    ) {
        self.read_location(Location::Memory(address), Width::W64, next_pc, true, exit_depth);
        self.op(Op::LocalGet(LHS)).op(Op::LocalSet(RHS));
        self.pair32(2, 0);
        self.op(Op::LocalSet(LHS));
        self.pair32(1, 3);
        self.op(Op::LocalSet(RESULT))
            .op(Op::LocalGet(LHS))
            .op(Op::LocalGet(RHS))
            .op(Op::I64Eq)
            .op(Op::If(BlockType::Empty));
        self.store_result(Width::W64, exit_depth + 1);
        self.op(Op::LocalGet(FLAGS))
            .op(Op::I64Const(0x40))
            .op(Op::I64Or)
            .op(Op::LocalSet(FLAGS))
            .op(Op::Else)
            .op(Op::LocalGet(RHS))
            .op(Op::LocalSet(RESULT));
        self.store_result(Width::W64, exit_depth + 1);
        self.op(Op::LocalGet(RHS));
        self.narrow(Width::W32);
        self.write_register(RegisterView::low(0), Width::W32);
        self.op(Op::LocalGet(RHS))
            .op(Op::I64Const(32))
            .op(Op::I64ShrU);
        self.write_register(RegisterView::low(2), Width::W32);
        self.op(Op::LocalGet(FLAGS))
            .op(Op::I64Const(!0x40))
            .op(Op::I64And)
            .op(Op::LocalSet(FLAGS))
            .op(Op::End);
    }
}
